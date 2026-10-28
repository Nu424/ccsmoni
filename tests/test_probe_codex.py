"""CodexAppServerSource の単体テスト。実際の codex は呼ばず、偽の app-server（小さな Python スクリプト）を使う。"""

from __future__ import annotations

import json
import sys
import textwrap
import time
from pathlib import Path

import pytest

from ccsmoni.model import Account, Provider
from ccsmoni.parser_codex import CodexRateLimitsParser
from ccsmoni.probes.codex_app_server import CodexAppServerSource, account_hash

# 偽の codex app-server。環境変数 FAKE_MODE で挙動を変える。標準入力の JSON-RPC に1行ずつ応答する
FAKE = textwrap.dedent(
    r"""
    import json, os, sys, time
    mode = os.environ.get("FAKE_MODE", "ok")
    assert sys.argv[1:] == ["app-server"], sys.argv
    log = os.environ.get("FAKE_LOG")
    if log:  # 渡された CODEX_HOME と、受け取った要求を記録する
        with open(log, "a", encoding="utf-8") as f:
            f.write("home=" + os.environ.get("CODEX_HOME", "") + "\n")
    def out(m):
        sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
    snap = {"limitId": "codex", "limitName": None, "planType": "plus", "rateLimitReachedType": None,
            "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1793790000},
            "secondary": {"usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1794200000},
            "credits": {"hasCredits": True, "unlimited": False, "balance": "12.5"},
            "individualLimit": {"limit": "1", "used": "1", "remainingPercent": 0, "resetsAt": 1}}
    for line in sys.stdin:
        m = json.loads(line)
        if log:
            with open(log, "a", encoding="utf-8") as f:
                f.write(m["method"] + "\n")
        if "id" not in m:
            continue
        rid, meth = m["id"], m["method"]
        out({"method": "account/updated", "params": {}})  # 通知は読み捨てられる
        if meth == "initialize":
            if mode == "hang":
                time.sleep(60)
            out({"id": rid, "result": {"userAgent": "ccsmoni/9.9.9 (Fake OS)", "codexHome": os.environ["CODEX_HOME"]}})
        elif meth == "account/read":
            if mode == "crash":
                sys.exit(3)
            if mode == "logged_out":
                out({"id": rid, "result": {"account": None, "requiresOpenaiAuth": True, "workspaceRouting": None}})
            else:
                out({"id": rid, "result": {"account": {"type": "chatgpt", "email": "a@example.com", "planType": "plus"},
                                           "workspaceRouting": {"chatgptAccountId": "acct-123", "backendOrigin": "x"}}})
        elif meth == "account/rateLimits/read":
            if mode == "rl_error":
                out({"id": rid, "error": {"code": -32600, "message": "denied for a@example.com"}})
            else:
                out({"id": rid, "result": {"rateLimits": snap, "rateLimitsByLimitId": {"codex": snap},
                                           "accountId": "acct-123", "ordinaryUsageAllowed": True,
                                           "rateLimitUpsell": {"x": 1},
                                           "rateLimitResetCredits": {"availableCount": 1, "credits": []}}})
    """
)


@pytest.fixture
def fake(tmp_path: Path) -> list[str]:
    script = tmp_path / "fake_codex.py"
    script.write_text(FAKE, encoding="utf-8")
    return [sys.executable, str(script)]


@pytest.fixture
def account(tmp_path: Path) -> Account:
    return Account(id="codex-a", label="C", config_dir=tmp_path / "home", provider=Provider.CODEX)


def test_ok_keeps_only_allowed_fields(fake, account, monkeypatch, tmp_path):
    log = tmp_path / "log.txt"
    monkeypatch.setenv("FAKE_LOG", str(log))
    raw = CodexAppServerSource(fake, timeout_seconds=20).fetch(account)
    assert raw.source == "codex-app-server" and raw.error is None and not raw.timed_out and raw.exit_code == 0
    assert raw.meta["cli_version"] == "9.9.9"
    assert raw.meta["auth"] == {"loggedIn": True, "authMethod": "chatgpt", "planType": "plus", "orgId": account_hash("acct-123")}
    # メールアドレス・アカウント ID・クレジットなどは残さない
    for secret in ("example.com", "acct-123", "balance", "individualLimit", "rateLimitUpsell", "accountId"):
        assert secret not in raw.text and secret not in json.dumps(raw.meta)
    assert log.read_text(encoding="utf-8").splitlines() == [
        f"home={account.config_dir}", "initialize", "initialized", "account/read", "account/rateLimits/read"]
    r = CodexRateLimitsParser().parse(raw, account.id)
    assert [(lim.kind, lim.percent) for lim in r.limits] == [("session", 12.0), ("weekly_all", 40.0)]


def test_auth_status(fake, account):
    st = CodexAppServerSource(fake, timeout_seconds=20).auth_status(account)
    assert st == {"loggedIn": True, "authMethod": "chatgpt", "planType": "plus", "orgId": account_hash("acct-123")}


def test_logged_out_skips_rate_limits(fake, account, monkeypatch, tmp_path):
    log = tmp_path / "log.txt"
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_MODE", "logged_out")
    raw = CodexAppServerSource(fake, timeout_seconds=20).fetch(account)
    assert raw.meta["auth"] == {"loggedIn": False} and raw.text == "" and raw.error is None
    assert "account/rateLimits/read" not in log.read_text(encoding="utf-8")
    assert CodexAppServerSource(fake, timeout_seconds=20).auth_status(account) == {"loggedIn": False}


def test_rpc_error_masks_email(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "rl_error")
    raw = CodexAppServerSource(fake, timeout_seconds=20).fetch(account)
    assert raw.error == "account/rateLimits/read: denied for <email>"


def test_crash_mid_response(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "crash")
    raw = CodexAppServerSource(fake, timeout_seconds=20).fetch(account)
    assert raw.error and "終了" in raw.error and not raw.timed_out


def test_timeout_kills_process(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "hang")
    t0 = time.monotonic()
    raw = CodexAppServerSource(fake, timeout_seconds=1).fetch(account)
    assert raw.timed_out and raw.exit_code is None
    assert time.monotonic() - t0 < 10
    assert CodexAppServerSource(fake, timeout_seconds=1).auth_status(account) is None


def test_launch_failure(account):
    raw = CodexAppServerSource(["Z:/definitely/missing/codex.exe"]).fetch(account)
    assert raw.error and raw.exit_code is None and not raw.timed_out
