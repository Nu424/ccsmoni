"""ログインの起動と完了の監視（LoginService）。

何を: カードの［ログイン］から、PC 上に `CLAUDE_CONFIG_DIR` を設定した `claude auth login` のコンソールを開き、
      `claude auth status --json` を数秒おきに確認して、完了（done / mismatch）・失敗・タイムアウトを判定する。
なぜ: ログイン切れをその画面から直せるようにする（PLAN §5.2、U3）。
方針:
  - ログインは Anthropic 自身の手順で完了させる。ccsmoni はコードやトークンに一切触れない
    （新しいコンソールの stdin/stdout はそのコンソールにつながり、ccsmoni は読まない）。
  - シェルは介さず引数配列で起動する。起動できるのは設定の claude 本体だけ。
  - 監視は asyncio のタスク。auth status の実行（0.3 秒程度のブロッキング）は to_thread。
  - 同じアカウントで二重に起動しない（監視中なら今の状態を返すだけ）。
  - 完了したら store の account_meta.last_org_id と orgId を比べ、違えば mismatch。どちらでも再取得を依頼する。
  - Popen・auth status・時計は注入できる（テストでは偽物を使い、実際にウィンドウを開かない）。
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ccsmoni.model import Account

log = logging.getLogger("ccsmoni.login")

POLL_SECONDS = 3.0
TIMEOUT_SECONDS = 10 * 60
RESULT_TTL_SECONDS = 10 * 60  # 終わった結果（done など）をカードに出しておく時間

MSG_WAITING = "PC 側にログイン画面を開きました"
MSG_DONE = "ログインしました"
MSG_MISMATCH = "前回と別のアカウントでログインした可能性があります（組織が前回と違います）"
MSG_FAILED_EXIT = "ログインが完了しないまま、ログイン画面が閉じられました"
MSG_FAILED_START = "ログイン画面を開けませんでした（claude を起動できません）"
MSG_TIMEOUT = "10 分以内にログインが完了しませんでした"


@dataclass
class LoginState:
    account_id: str
    state: str  # waiting | done | mismatch | failed | timeout
    started_at: float
    message: str
    finished_at: float | None = None
    proc: Any = field(default=None, repr=False)

    def to_api(self) -> dict[str, Any]:
        return {"state": self.state, "started_at": int(self.started_at), "message": self.message}


class LoginService:
    def __init__(
        self,
        command: Callable[[], list[str]],
        auth_status: Callable[[Account], dict | None],
        last_org_id: Callable[[str], str | None],
        on_logged_in: Callable[[str], Any],
        popen: Callable[..., Any] = subprocess.Popen,
        clock: Callable[[], float] = time.time,
        poll_seconds: float = POLL_SECONDS,
        timeout_seconds: float = TIMEOUT_SECONDS,
    ) -> None:
        """
        command: claude 本体の起動コマンド（例: ["C:\\...\\claude.exe"]）を返す関数。設定の変更に追従するため関数にする。
        auth_status: CliUsageSource.auth_status と同じ形（loggedIn / orgId を含む dict、読めなければ None）。
        last_org_id: アカウント id → 前回ログインしていたときの orgId（store の account_meta）。
        on_logged_in: ログイン完了時に呼ぶ（Scheduler.refresh）。
        """
        self.command = command
        self.auth_status = auth_status
        self.last_org_id = last_org_id
        self.on_logged_in = on_logged_in
        self.popen = popen
        self.clock = clock
        self.poll_seconds = poll_seconds
        self.timeout_seconds = timeout_seconds
        self._states: dict[str, LoginState] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------ 状態

    def state(self, account_id: str) -> dict[str, Any] | None:
        """API.md の accounts[].login。何もしていない（または結果が古くなった）なら None。"""
        s = self._states.get(account_id)
        if s is None:
            return None
        if s.finished_at is not None and self.clock() - s.finished_at > RESULT_TTL_SECONDS:
            return None
        return s.to_api()

    def is_waiting(self, account_id: str) -> bool:
        s = self._states.get(account_id)
        return s is not None and s.state == "waiting"

    # ------------------------------------------------------------ 起動

    def _spawn_console(self, account: Account) -> Any:
        """新しいコンソールで `claude auth login` を開く。stdin/stdout は渡さない（＝新しいコンソールにつながる）。"""
        env = os.environ.copy()  # グローバルの os.environ は変更しない
        env["CLAUDE_CONFIG_DIR"] = str(account.config_dir)
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_CONSOLE
        return self.popen([*self.command(), "auth", "login"], env=env, shell=False, **kwargs)

    def start(self, account: Account) -> dict[str, Any]:
        """ログイン画面を開き、監視を始める。すでに待っているなら何もしないで今の状態を返す。

        イベントループの中から呼ぶこと（監視タスクを作るため）。
        """
        if self.is_waiting(account.id):
            return self._states[account.id].to_api()
        now = self.clock()
        try:
            proc = self._spawn_console(account)
        except Exception as e:
            log.error("%s: ログイン画面を開けませんでした（%s）", account.id, type(e).__name__)
            s = LoginState(account.id, "failed", now, MSG_FAILED_START, finished_at=now)
            self._states[account.id] = s
            return s.to_api()
        s = LoginState(account.id, "waiting", now, MSG_WAITING, proc=proc)
        self._states[account.id] = s
        log.info("%s: ログイン画面を開きました", account.id)
        self._tasks[account.id] = asyncio.get_running_loop().create_task(
            self._watch(account, s), name=f"login-{account.id}"
        )
        return s.to_api()

    # ------------------------------------------------------------ 監視

    def _finish(self, s: LoginState, state: str, message: str) -> None:
        s.state, s.message, s.finished_at = state, message, self.clock()
        s.proc = None
        log.info("%s: ログイン %s", s.account_id, state)

    async def _watch(self, account: Account, s: LoginState) -> None:
        try:
            while True:
                await asyncio.sleep(self.poll_seconds)
                # 先にプロセスの終了を見ておく。終了直後に loggedIn になっている場合は成功として扱う
                exited = s.proc is not None and s.proc.poll() is not None
                status = await asyncio.to_thread(self.auth_status, account)
                if status is not None and status.get("loggedIn") is True:
                    org = status.get("orgId")
                    last = await asyncio.to_thread(self.last_org_id, account.id)
                    if last and org and org != last:
                        self._finish(s, "mismatch", MSG_MISMATCH)
                    else:
                        self._finish(s, "done", MSG_DONE)
                    try:
                        self.on_logged_in(account.id)
                    except Exception as e:  # 再取得の依頼に失敗しても、ログイン自体は成功している
                        log.error("%s: 再取得を始められませんでした（%s）", account.id, type(e).__name__)
                    return
                if exited:
                    self._finish(s, "failed", MSG_FAILED_EXIT)
                    return
                if self.clock() - s.started_at >= self.timeout_seconds:
                    # コンソールは閉じない（利用者が操作中かもしれないため）。監視だけやめる
                    self._finish(s, "timeout", MSG_TIMEOUT)
                    return
        finally:
            self._tasks.pop(account.id, None)

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
