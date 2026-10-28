"""LoginService のテスト。Popen・auth status・時計は偽物（実際にウィンドウは開かない）。"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

from ccsmoni.login import LoginService
from ccsmoni.model import Account, Provider

ACCOUNT = Account(id="acct-a", label="A", config_dir=Path("/x/acct-a"))
CODEX_ACCOUNT = Account(id="codex-a", label="C", config_dir=Path("/x/codex-a"), provider=Provider.CODEX)


class FakeProc:
    def __init__(self) -> None:
        self.exit_code: int | None = None

    def poll(self):
        return self.exit_code


class Harness:
    def __init__(self, last_org: str | None = "org-1", popen_error: bool = False) -> None:
        self.t = 1000.0
        self.status: dict | None = {"loggedIn": False}
        self.popen_calls: list[tuple[list[str], dict]] = []
        self.refreshed: list[str] = []
        self.proc = FakeProc()
        self.popen_error = popen_error
        self.svc = LoginService(
            command=lambda a: [f"C:/fake/{a.provider}.exe"],
            auth_status=lambda a: self.status,
            last_org_id=lambda aid: last_org,
            on_logged_in=self.refreshed.append,
            popen=self.popen,
            clock=lambda: self.t,
            poll_seconds=0.01,
            timeout_seconds=600,
        )

    def popen(self, args, **kw):
        if self.popen_error:
            raise FileNotFoundError("no claude")
        self.popen_calls.append((args, kw))
        return self.proc


async def wait_state(h: Harness, state: str) -> dict:
    for _ in range(500):
        s = h.svc.state(ACCOUNT.id)
        if s and s["state"] == state:
            return s
        await asyncio.sleep(0.005)
    raise AssertionError(f"{state} になりませんでした: {h.svc.state(ACCOUNT.id)}")


def test_start_opens_new_console_without_shell_and_completes():
    async def main():
        h = Harness()
        s = h.svc.start(ACCOUNT)
        assert s["state"] == "waiting" and s["started_at"] == 1000
        assert s["message"] == "PC 側にログイン画面を開きました"
        (args, kw), = h.popen_calls
        assert args == ["C:/fake/claude.exe", "auth", "login"]
        assert kw["shell"] is False
        assert kw["env"]["CLAUDE_CONFIG_DIR"] == str(ACCOUNT.config_dir)
        assert "stdin" not in kw and "stdout" not in kw  # 入出力は新しいコンソールにつながる（ccsmoni は触れない）
        if sys.platform == "win32":
            assert kw["creationflags"] == subprocess.CREATE_NEW_CONSOLE
        # 二重に起動しない
        assert h.svc.start(ACCOUNT)["state"] == "waiting"
        assert len(h.popen_calls) == 1
        await asyncio.sleep(0.05)
        assert h.refreshed == []
        h.status = {"loggedIn": True, "orgId": "org-1"}
        await wait_state(h, "done")
        assert h.refreshed == ["acct-a"]

    asyncio.run(main())


def test_codex_opens_codex_login_with_codex_home():
    async def main():
        h = Harness()
        assert h.svc.start(CODEX_ACCOUNT)["state"] == "waiting"
        (args, kw), = h.popen_calls
        assert args == ["C:/fake/codex.exe", "login"]
        assert kw["env"]["CODEX_HOME"] == str(CODEX_ACCOUNT.config_dir)
        h.status = {"loggedIn": True, "orgId": "org-1"}
        for _ in range(500):
            s = h.svc.state(CODEX_ACCOUNT.id)
            if s["state"] == "done":
                break
            await asyncio.sleep(0.005)
        assert h.refreshed == ["codex-a"]

    asyncio.run(main())


def test_mismatch_when_org_differs():
    async def main():
        h = Harness(last_org="org-1")
        h.svc.start(ACCOUNT)
        h.status = {"loggedIn": True, "orgId": "org-2"}
        s = await wait_state(h, "mismatch")
        assert "別のアカウント" in s["message"]
        assert h.refreshed == ["acct-a"]  # mismatch でも再取得する

    asyncio.run(main())


def test_done_when_no_previous_org():
    async def main():
        h = Harness(last_org=None)
        h.svc.start(ACCOUNT)
        h.status = {"loggedIn": True, "orgId": "org-9"}
        await wait_state(h, "done")

    asyncio.run(main())


def test_failed_when_console_closed_without_login():
    async def main():
        h = Harness()
        h.svc.start(ACCOUNT)
        h.proc.exit_code = 1
        await wait_state(h, "failed")
        assert h.refreshed == []
        # 終わったあとは、もう一度起動できる
        h.proc = FakeProc()
        assert h.svc.start(ACCOUNT)["state"] == "waiting"
        assert len(h.popen_calls) == 2

    asyncio.run(main())


def test_timeout_after_10_minutes():
    async def main():
        h = Harness()
        h.svc.start(ACCOUNT)
        await asyncio.sleep(0.03)
        h.t += 600
        s = await wait_state(h, "timeout")
        assert "10 分" in s["message"]
        # 結果は一定時間たつと消える（カードを元に戻す）
        h.t += 11 * 60
        assert h.svc.state(ACCOUNT.id) is None

    asyncio.run(main())


def test_popen_failure_is_failed():
    async def main():
        h = Harness(popen_error=True)
        s = h.svc.start(ACCOUNT)
        assert s["state"] == "failed"
        assert h.svc.state(ACCOUNT.id)["state"] == "failed"

    asyncio.run(main())


def test_state_none_when_never_started():
    assert Harness().svc.state("acct-a") is None


def test_finished_at_is_set_when_done():
    async def main():
        h = Harness()
        s = h.svc.start(ACCOUNT)
        assert s["finished_at"] is None  # 待っている間は None
        h.t = 1042.0
        h.status = {"loggedIn": True, "orgId": "org-1"}
        s = await wait_state(h, "done")
        assert s["finished_at"] == 1042 and s["started_at"] == 1000

    asyncio.run(main())


def test_login_completion_refetches_even_while_collecting():
    """ログインの完了時に取得中でも、その取得が終わったあとに必ず取り直す（Scheduler.refresh_soon）。"""
    import threading

    from ccsmoni.config import AppConfig
    from ccsmoni.model import RawResult
    from ccsmoni.probes.base import Probe
    from ccsmoni.scheduler import Scheduler

    from ccsmoni.model import Limit, Reading, Status

    class FakeParser:
        def parse(self, raw, account_id):
            return Reading(account_id, raw.started_at, "fake", Status.OK, (Limit("session", "s", 10.0, None),))

    class FakeStore:
        def __init__(self) -> None:
            self.saved: list = []

        def save(self, raw, reading):
            self.saved.append(reading)

    async def until(cond) -> None:
        for _ in range(1000):
            if cond():
                return
            await asyncio.sleep(0.005)
        raise AssertionError("条件を満たしませんでした")

    class GatedSource:
        kind = "fake"

        def __init__(self) -> None:
            self.gate = threading.Event()
            self.calls = 0

        def fetch(self, account):
            from datetime import UTC, datetime

            self.calls += 1
            self.gate.wait(5)
            return RawResult("fake", datetime.now(UTC), 1, "10")

    async def main():
        src, store = GatedSource(), FakeStore()
        cfg = AppConfig.model_validate({"collector": {"discover_roots": []},
                                        "accounts": [{"id": "acct-a", "label": "A", "config_dir": "/x/acct-a"}]})
        sched = Scheduler(store, cfg, lambda c: Probe("fake", src, FakeParser()), clock=lambda: 1000.0, max_sleep=0.01)
        task = asyncio.create_task(sched.run())
        await until(lambda: src.calls == 1)  # ログイン前の状態で取得中
        h = Harness()
        h.svc.on_logged_in = sched.refresh_soon
        h.svc.start(ACCOUNT)
        h.status = {"loggedIn": True, "orgId": "org-1"}
        await wait_state(h, "done")
        src.gate.set()
        await until(lambda: len(store.saved) == 2)  # 時計を進めなくても、すぐもう一度取る
        assert src.calls == 2
        await sched.stop()
        task.cancel()

    asyncio.run(main())
