"""LoginService のテスト。Popen・auth status・時計は偽物（実際にウィンドウは開かない）。"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

from ccsmoni.login import LoginService
from ccsmoni.model import Account

ACCOUNT = Account(id="acct-a", label="A", config_dir=Path("/x/acct-a"))


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
            command=lambda: ["C:/fake/claude.exe"],
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
