"""claude CLI を起動して /usage を取ってくる Source。

何を: `claude auth status --json` でログイン状態を確かめ、ログイン中なら
      `claude -p /usage --output-format json --no-session-persistence` の結果を RawResult にする。
なぜ: ログイン切れをテキストの見た目ではなく確かな情報で判定するため（PLAN §3.2, §4.1）。
      /usage はローカルで処理されモデルは呼ばれない（料金 0）。トークンには一切触れない。
方針: シェルを介さず引数配列で起動する（Git Bash 等を経由すると /usage がパスに書き換わるため）。
      環境変数は子プロセスにだけ渡す。タイムアウト時はプロセスツリーごと終了させる。
      timeout_seconds は1回の取得全体の締め切り（各プロセスには残り時間を渡す）。
      例外は外に投げず、失敗は RawResult.error / timed_out で返す。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ccsmoni.model import Account, RawResult

# auth status の結果のうち meta に残してよいキー。メールアドレスや組織名など、人や組織が特定できるものは残さない
# （orgId はログイン後の「前と同じアカウントか」の照合に使うので残す）。
_AUTH_KEEP_KEYS = ("loggedIn", "authMethod", "subscriptionType", "orgId")

# auth status の出力が JSON として読めなかったとき、meta["auth_error"] に残す先頭の文字数
AUTH_ERROR_HEAD = 200
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def _mask_emails(text: str) -> str:
    """メールアドレス風の文字列を伏せる（ログや DB に個人情報を残さないため）。"""
    return _EMAIL_RE.sub("<email>", text)


@dataclass
class _Run:
    """子プロセス1回分の結果（内部用）。"""

    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    timed_out: bool = False
    error: str | None = None


def _kill_tree(proc: subprocess.Popen) -> None:
    """プロセスツリーごと終了させる。claude は子プロセスを持つので、本体だけ殺すと残る。"""
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        proc.kill()  # taskkill が使えなかった場合の保険
    except Exception:
        pass


class CliUsageSource:
    kind = "cli-usage"

    # CLI のバージョンは毎回呼ぶと遅いので、プロセス内で共有してキャッシュする（コマンドごと）。
    # 値は (バージョン, キャッシュの期限 = time.monotonic())。claude は自動更新されるので1時間で切れるようにする。
    # 取得に失敗した（None）ときはキャッシュしない（次の取得でもう一度試す）。
    _version_cache: dict[tuple[str, ...], tuple[str, float]] = {}
    VERSION_TTL_SECONDS = 3600.0

    def __init__(self, claude_path: str | list[str] = "claude", timeout_seconds: float = 30) -> None:
        self.claude_path = claude_path
        self.timeout_seconds = timeout_seconds  # 1回の取得（auth status + /usage）全体の締め切り

    # ---- 起動まわり ----

    def base_command(self) -> list[str]:
        """起動コマンドの先頭部分。単一の文字列は PATH から実体（claude.exe など）に解決する。"""
        if isinstance(self.claude_path, str):
            return [shutil.which(self.claude_path) or self.claude_path]
        return list(self.claude_path)

    def _run(self, args: list[str], config_dir: str | None, timeout: float | None = None) -> _Run:
        """子プロセスを1つ実行する。timeout は残り時間（秒）。省略すると timeout_seconds。0 以下なら起動しない。"""
        timeout = self.timeout_seconds if timeout is None else timeout
        if timeout <= 0:
            return _Run(timed_out=True)  # 締め切りを過ぎている
        cmd = self.base_command() + args
        env = os.environ.copy()  # グローバルの os.environ は変更しない
        if config_dir is not None:
            env["CLAUDE_CONFIG_DIR"] = config_dir
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True  # killpg でツリーごと終了できるように
        try:
            proc = subprocess.Popen(
                cmd,
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                encoding="utf-8",
                errors="replace",
                **kwargs,
            )
        except Exception as e:  # 見つからない・権限なしなど
            return _Run(error=f"{type(e).__name__}: {e}")
        try:
            out, err = proc.communicate(timeout=timeout)
            return _Run(stdout=out or "", stderr=err or "", exit_code=proc.returncode)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                out, err = proc.communicate(timeout=5)
            except Exception:
                out, err = "", ""
            return _Run(stdout=out or "", stderr=err or "", exit_code=None, timed_out=True)
        except Exception as e:
            _kill_tree(proc)
            return _Run(error=f"{type(e).__name__}: {e}")

    def _cli_version(self, timeout: float | None = None) -> str | None:
        key = tuple(self.base_command())
        now = time.monotonic()
        hit = CliUsageSource._version_cache.get(key)
        if hit is not None and hit[1] > now:
            return hit[0]
        r = self._run(["--version"], None, timeout)
        version = (r.stdout.strip() or None) if r.exit_code == 0 else None
        if version is not None:
            CliUsageSource._version_cache[key] = (version, now + self.VERSION_TTL_SECONDS)
        else:
            CliUsageSource._version_cache.pop(key, None)
        return version

    # ---- ログイン状態 ----

    def _auth(
        self, config_dir: str, timeout: float | None = None
    ) -> tuple[_Run, dict[str, Any] | None, str | None]:
        """`claude auth status --json` を実行する。戻り値は (実行結果, 残してよいキーだけの dict, 読めなかった理由)。"""
        r = self._run(["auth", "status", "--json"], config_dir, timeout)
        if r.error or r.timed_out:
            return r, None, r.error or "auth status がタイムアウトしました"
        try:
            data = json.loads(r.stdout)
            if not isinstance(data, dict):
                raise ValueError("JSON object ではありません")
        except ValueError as e:
            return r, None, f"auth status を読めませんでした: {e}"
        return r, {k: data[k] for k in _AUTH_KEEP_KEYS if k in data}, None

    def auth_status(self, account: Account) -> dict[str, Any] | None:
        """ログイン状態だけを確かめる（LoginService が完了を待つのに使う）。読めなければ None。

        返すのは loggedIn / orgId など _AUTH_KEEP_KEYS のキーだけ（メールアドレスなどは捨てる）。
        """
        return self._auth(str(account.config_dir))[1]

    # ---- 取得 ----

    def fetch(self, account: Account) -> RawResult:
        """1回の取得。timeout_seconds は auth status と /usage を合わせた全体の締め切り。

        締め切りは開始時に決め、各プロセスには残り時間だけを渡す（auth status が遅いと、その分 /usage の持ち時間が減る）。
        タイムアウト・起動失敗のときは --version を呼ばない（同じ理由で失敗し、待ち時間を延ばすだけなので）。
        """
        started_at = datetime.now(UTC)
        t0 = time.monotonic()
        deadline = t0 + self.timeout_seconds
        meta: dict[str, Any] = {}

        def remaining() -> float:
            return deadline - time.monotonic()

        def done(text: str = "", with_version: bool = True, **kw: Any) -> RawResult:
            meta["cli_version"] = self._cli_version(remaining()) if with_version else None
            return RawResult(
                source=self.kind,
                started_at=started_at,
                duration_ms=int((time.monotonic() - t0) * 1000),
                text=text,
                meta=meta,
                **kw,
            )

        config_dir = str(account.config_dir)

        # 1. ログイン状態。ログイン切れでも exit 1 + JSON なので、終了コードでなく中身を見る。
        auth, auth_json, auth_error = self._auth(config_dir, remaining())
        if auth.error or auth.timed_out:
            return done(with_version=False, exit_code=auth.exit_code, timed_out=auth.timed_out, error=auth.error)
        if auth_json is None:
            # 読めなかった出力は raw に保存しない（メールアドレスなどが含まれうる）。
            # 原因の手がかりとして、メールアドレス風の文字列を伏せた先頭だけを meta に残す
            meta["auth_error"] = _mask_emails(auth.stdout)[:AUTH_ERROR_HEAD]
            return done(text="", exit_code=auth.exit_code, error=auth_error)
        meta["auth"] = auth_json

        # 2. ログイン切れなら /usage は実行しない（実行するとコスト表示になり紛らわしい）。
        if auth_json.get("loggedIn") is not True:
            return done(text="", exit_code=auth.exit_code)

        # 3. /usage。文字列 "/usage" をそのまま引数に渡す。--bare は認証が読まれなくなるので使わない。
        usage = self._run(
            ["-p", "/usage", "--output-format", "json", "--no-session-persistence"], config_dir, remaining()
        )
        if usage.error or usage.timed_out:
            return done(with_version=False, exit_code=usage.exit_code, timed_out=usage.timed_out, error=usage.error)

        text = usage.stdout
        try:
            envelope = json.loads(usage.stdout)
            if not isinstance(envelope, dict) or not isinstance(envelope.get("result"), str):
                raise ValueError("result が文字列ではありません")
            text = envelope["result"]
            # 料金・ターン数は「モデルが呼ばれていないこと」の確認用に残す
            for k in ("total_cost_usd", "num_turns"):
                if k in envelope:
                    meta[k] = envelope[k]
        except ValueError as e:
            meta["envelope_error"] = str(e)
        return done(text=text, exit_code=usage.exit_code)
