"""codex CLI の app-server から使用率を取ってくる Source。

何を: `CODEX_HOME` を設定して `codex app-server` を起動し、標準入出力の JSON-RPC で
      `account/read`（ログイン状態）→ `account/rateLimits/read`（使用率）を呼んで、結果を RawResult にする。
なぜ: app-server は構造化された JSON で使用率を返す。モデルは呼ばれない（料金 0）。
      トークンには一切触れず、改変していない codex CLI の機能だけを使う（docs/design/CODEX.md）。
方針:
  - シェルを介さず引数配列で起動する。環境変数は子プロセスにだけ渡す。stderr は読まない
    （警告にユーザー名を含むパスが出ることがあるため）。
  - 応答は1行1メッセージ。読み取りは別スレッドで行い、取得全体の締め切り（timeout_seconds）で待つのをやめる。
    締め切りを過ぎたら、プロセスツリーごと終了させる。
  - raw に残すのは、使用率の表示に要る項目だけ（メールアドレス・アカウント ID・クレジットなどは捨てる）。
    「前と同じアカウントか」の照合用に、アカウント ID はハッシュにして orgId として残す。
  - 例外は外に投げず、失敗は RawResult.error / timed_out で返す。
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from typing import Any

from ccsmoni.model import Account, RawResult
from ccsmoni.probes.cli_usage import _kill_tree, _mask_emails

KIND = "codex-app-server"

# rateLimits の各 snapshot・枠のうち、raw に残してよいキー
_SNAPSHOT_KEEP_KEYS = ("limitId", "limitName", "primary", "secondary", "planType", "rateLimitReachedType")
_WINDOW_KEEP_KEYS = ("usedPercent", "windowDurationMins", "resetsAt")


class _Timeout(Exception):
    pass


class _Closed(Exception):
    """応答の途中で app-server が終了した。"""


def _client_version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("ccsmoni")
    except PackageNotFoundError:
        return "unknown"


def account_hash(account_id: str) -> str:
    """アカウント ID の代わりに残す値（ログイン後の照合に使う。ID そのものは残さない）。"""
    return hashlib.sha256(f"codex:{account_id}".encode()).hexdigest()[:16]


def _keep_window(w: Any) -> dict | None:
    return {k: w[k] for k in _WINDOW_KEEP_KEYS if k in w} if isinstance(w, dict) else None


def _keep_snapshot(s: Any) -> dict | None:
    if not isinstance(s, dict):
        return None
    out = {k: s[k] for k in _SNAPSHOT_KEEP_KEYS if k in s}
    for k in ("primary", "secondary"):
        if k in out:
            out[k] = _keep_window(out[k])
    return out


def filter_rate_limits(result: Any) -> dict:
    """account/rateLimits/read の結果から、残してよい項目だけを取り出す。"""
    if not isinstance(result, dict):
        return {}
    out: dict[str, Any] = {}
    if "rateLimits" in result:
        out["rateLimits"] = _keep_snapshot(result["rateLimits"])
    by_id = result.get("rateLimitsByLimitId")
    if isinstance(by_id, dict):
        out["rateLimitsByLimitId"] = {str(k): _keep_snapshot(v) for k, v in by_id.items()}
    if "ordinaryUsageAllowed" in result:
        out["ordinaryUsageAllowed"] = result["ordinaryUsageAllowed"]
    return out


def auth_from_account_read(result: Any) -> dict[str, Any]:
    """account/read の結果を、Claude の auth status と同じ形（loggedIn / orgId など）にする。メールアドレスは捨てる。"""
    acc = result.get("account") if isinstance(result, dict) else None
    if not isinstance(acc, dict):
        return {"loggedIn": False}
    out: dict[str, Any] = {"loggedIn": True, "authMethod": acc.get("type")}
    if acc.get("planType"):
        out["planType"] = acc["planType"]
    routing = result.get("workspaceRouting")
    aid = routing.get("chatgptAccountId") if isinstance(routing, dict) else None
    if isinstance(aid, str) and aid:
        out["orgId"] = account_hash(aid)
    return out


class _Session:
    """app-server のプロセス1つ分。call() で要求を送り、同じ id の応答を待つ（通知は読み捨てる）。"""

    def __init__(self, proc: subprocess.Popen, deadline: float) -> None:
        self.proc = proc
        self.deadline = deadline
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._next_id = 1
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        try:
            assert self.proc.stdout is not None
            for line in self.proc.stdout:
                self._lines.put(line)
        except Exception:
            pass
        finally:
            self._lines.put(None)

    def send(self, msg: dict) -> None:
        assert self.proc.stdin is not None
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except OSError as e:  # 起動直後に終了していた
            raise _Closed() from e

    def call(self, method: str, params: Any = None) -> dict:
        """応答のメッセージ全体（result か error を含む）を返す。"""
        rid = self._next_id
        self._next_id += 1
        self.send({"id": rid, "method": method, "params": params})
        while True:
            left = self.deadline - time.monotonic()
            if left <= 0:
                raise _Timeout()
            try:
                line = self._lines.get(timeout=left)
            except queue.Empty as e:
                raise _Timeout() from e
            if line is None:
                raise _Closed()
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # JSON でない行（想定外の出力）は読み捨てる
            if isinstance(msg, dict) and msg.get("id") == rid and "method" not in msg:
                return msg

    def close(self) -> None:
        """標準入力を閉じると終了する。少し待っても終わらなければツリーごと終了させる。"""
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=3)
        except Exception:
            _kill_tree(self.proc)


def _rpc_error(method: str, msg: dict) -> str:
    err = msg.get("error")
    text = err.get("message") if isinstance(err, dict) else None
    return _mask_emails(f"{method}: {text or err}")[:300]


class CodexAppServerSource:
    kind = KIND

    def __init__(self, codex_path: str | list[str] = "codex", timeout_seconds: float = 30) -> None:
        self.codex_path = codex_path
        self.timeout_seconds = timeout_seconds  # 1回の取得全体の締め切り

    def base_command(self) -> list[str]:
        """起動コマンドの先頭部分。単一の文字列は PATH から実体（codex.exe など）に解決する。"""
        if isinstance(self.codex_path, str):
            return [shutil.which(self.codex_path) or self.codex_path]
        return list(self.codex_path)

    def _start(self, account: Account) -> subprocess.Popen:
        env = os.environ.copy()  # グローバルの os.environ は変更しない
        env["CODEX_HOME"] = str(account.config_dir)
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True  # killpg でツリーごと終了できるように
        return subprocess.Popen(
            [*self.base_command(), "app-server"],
            shell=False,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            encoding="utf-8",
            errors="replace",
            **kwargs,
        )

    @staticmethod
    def _initialize(s: _Session, meta: dict[str, Any]) -> None:
        init = s.call("initialize", {"clientInfo": {"name": "ccsmoni", "version": _client_version()}})
        ua = (init.get("result") or {}).get("userAgent")  # 例: "ccsmoni/0.157.1 (Windows ...)"。/ の後ろが CLI の版
        if isinstance(ua, str) and "/" in ua.split(" ", 1)[0]:
            meta["cli_version"] = ua.split(" ", 1)[0].split("/", 1)[1]
        s.send({"method": "initialized"})

    def auth_status(self, account: Account) -> dict[str, Any] | None:
        """ログイン状態だけを確かめる（LoginService が完了を待つのに使う）。読めなければ None。"""
        s = None
        try:
            s = _Session(self._start(account), time.monotonic() + self.timeout_seconds)
            self._initialize(s, {})
            msg = s.call("account/read", {"refreshToken": False})
            return auth_from_account_read(msg["result"]) if "result" in msg else None
        except Exception:
            return None
        finally:
            if s is not None:
                s.close()

    def fetch(self, account: Account) -> RawResult:
        started_at = datetime.now(UTC)
        t0 = time.monotonic()
        meta: dict[str, Any] = {"cli_version": None}

        def done(text: str = "", **kw: Any) -> RawResult:
            return RawResult(
                source=self.kind,
                started_at=started_at,
                duration_ms=int((time.monotonic() - t0) * 1000),
                text=text,
                meta=meta,
                **kw,
            )

        try:
            proc = self._start(account)
        except Exception as e:  # 見つからない・権限なしなど
            return done(error=f"{type(e).__name__}: {e}")
        s = _Session(proc, t0 + self.timeout_seconds)
        try:
            self._initialize(s, meta)

            # 1. ログイン状態。未ログインなら rateLimits/read はエラーになるので呼ばない
            acc = s.call("account/read", {"refreshToken": False})
            if "result" not in acc:
                return done(error=_rpc_error("account/read", acc))
            meta["auth"] = auth_from_account_read(acc["result"])
            if meta["auth"]["loggedIn"] is not True:
                return done(exit_code=0)

            # 2. 使用率
            rl = s.call("account/rateLimits/read")
            if "result" not in rl:
                return done(error=_rpc_error("account/rateLimits/read", rl))
            return done(text=json.dumps(filter_rate_limits(rl["result"]), ensure_ascii=False), exit_code=0)
        except _Timeout:
            _kill_tree(s.proc)
            return done(timed_out=True)
        except _Closed:
            code = s.proc.poll()
            return done(exit_code=code, error=f"codex app-server が応答の途中で終了しました（終了コード {code}）")
        finally:
            s.close()
