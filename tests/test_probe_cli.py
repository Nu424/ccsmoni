"""CliUsageSource の単体テスト。実際の claude は呼ばず、偽の claude（小さな Python スクリプト）を使う。"""

from __future__ import annotations

import os
import sys
import textwrap
import time
from pathlib import Path

import pytest

from ccsmoni.model import Account
from ccsmoni.probes.cli_usage import CliUsageSource

# 偽 claude。環境変数 FAKE_MODE で挙動を変える（子プロセスには os.environ 経由で渡す）。
FAKE = textwrap.dedent(
    r"""
    import json, os, sys, time
    mode = os.environ.get("FAKE_MODE", "ok")
    args = sys.argv[1:]
    if args == ["--version"]:
        print("9.9.9 (fake)")
    elif args[:2] == ["auth", "status"]:
        if mode == "logged_out":
            print(json.dumps({"loggedIn": False, "authMethod": "none"}))
            sys.exit(1)
        if mode == "auth_garbage":
            print("not json")
        else:
            print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max",
                              "orgId": "org-x", "orgName": "Org", "email": "a@example.com"}))
    elif args[:2] == ["-p", "/usage"]:
        assert "--bare" not in args and "--no-session-persistence" in args
        if mode == "timeout":
            time.sleep(60)
        if mode == "bad_envelope":
            print("plain text, not json")
        else:
            print(json.dumps({"result": "Current session: 6% used", "total_cost_usd": 0, "num_turns": 0,
                              "config_dir": os.environ.get("CLAUDE_CONFIG_DIR")}))
    else:
        sys.exit(2)
    """
)


@pytest.fixture
def fake(tmp_path: Path) -> list[str]:
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE, encoding="utf-8")
    return [sys.executable, str(script)]


@pytest.fixture
def account(tmp_path: Path) -> Account:
    return Account(id="acct-a", label="A", config_dir=tmp_path / "cfg")


@pytest.fixture(autouse=True)
def clear_cache():
    CliUsageSource._version_cache.clear()


def test_ok(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "ok")
    before = os.environ.get("CLAUDE_CONFIG_DIR")
    raw = CliUsageSource(fake, timeout_seconds=20).fetch(account)
    assert raw.source == "cli-usage"
    assert raw.text == "Current session: 6% used"
    assert raw.exit_code == 0 and not raw.timed_out and raw.error is None
    assert raw.started_at.utcoffset().total_seconds() == 0
    assert raw.meta["cli_version"] == "9.9.9 (fake)"
    assert raw.meta["total_cost_usd"] == 0 and raw.meta["num_turns"] == 0
    # 個人情報は残さない
    assert raw.meta["auth"] == {
        "loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max", "orgId": "org-x", "orgName": "Org",
    }
    assert "a@example.com" not in repr(raw)
    # グローバル環境は変更されない
    assert os.environ.get("CLAUDE_CONFIG_DIR") == before


def test_config_dir_passed_to_child(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "ok")
    src = CliUsageSource(fake, timeout_seconds=20)
    # 偽 claude が config_dir を envelope に載せて返すので、子に渡った値を直接確かめる
    run = src._run(["-p", "/usage", "--output-format", "json", "--no-session-persistence"], str(account.config_dir))
    assert str(account.config_dir) in run.stdout.replace("\\\\", "\\")


def test_logged_out_skips_usage(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "logged_out")
    raw = CliUsageSource(fake, timeout_seconds=20).fetch(account)
    assert raw.meta["auth"]["loggedIn"] is False
    assert raw.text == ""
    assert raw.exit_code == 1 and raw.error is None
    assert "total_cost_usd" not in raw.meta  # /usage は実行されていない


def test_auth_garbage(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "auth_garbage")
    raw = CliUsageSource(fake, timeout_seconds=20).fetch(account)
    assert raw.error and "auth status" in raw.error
    assert "auth" not in raw.meta


def test_bad_envelope(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "bad_envelope")
    raw = CliUsageSource(fake, timeout_seconds=20).fetch(account)
    assert raw.text.strip() == "plain text, not json"
    assert "envelope_error" in raw.meta


def test_timeout(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "timeout")
    t0 = time.monotonic()
    raw = CliUsageSource(fake, timeout_seconds=3).fetch(account)
    assert raw.timed_out and raw.exit_code is None
    assert time.monotonic() - t0 < 30  # 60 秒待たずに打ち切られる
    assert raw.meta["auth"]["loggedIn"] is True


def test_launch_failure(account):
    raw = CliUsageSource("definitely-not-a-real-command-xyz").fetch(account)
    assert raw.error and raw.exit_code is None and not raw.timed_out
    assert raw.text == ""


def test_version_is_cached(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "ok")
    src = CliUsageSource(fake, timeout_seconds=20)
    src.fetch(account)
    assert tuple(fake) in CliUsageSource._version_cache
    CliUsageSource._version_cache[tuple(fake)] = "cached"
    assert src.fetch(account).meta["cli_version"] == "cached"
