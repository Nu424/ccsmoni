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
    log = os.environ.get("FAKE_LOG")
    if log:  # 呼ばれた引数を記録する（--version が呼ばれたかの確認用）
        with open(log, "a", encoding="utf-8") as f:
            f.write(" ".join(args) + "\n")
    if args == ["--version"]:
        if mode == "version_fail":
            sys.exit(1)
        print("9.9.9 (fake)")
    elif args[:2] == ["auth", "status"]:
        if mode == "logged_out":
            print(json.dumps({"loggedIn": False, "authMethod": "none"}))
            sys.exit(1)
        if mode == "auth_timeout":
            time.sleep(60)
        if mode == "slow":
            time.sleep(2)
        if mode == "auth_garbage":
            print("not json: please sign in as someone.name+tag@example.co.jp " + "x" * 400)
        else:
            print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max",
                              "orgId": "org-x", "orgName": "Org", "email": "a@example.com"}))
    elif args[:2] == ["-p", "/usage"]:
        assert "--bare" not in args and "--no-session-persistence" in args
        if mode in ("timeout", "slow"):
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
        "loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max", "orgId": "org-x",
    }
    assert "a@example.com" not in repr(raw) and "Org" not in repr(raw.meta)  # メールアドレス・組織名は残さない
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
    # 読めなかった出力は raw に保存しない。メールアドレスを伏せた先頭 200 文字だけを meta に残す
    assert raw.text == ""
    assert raw.meta["auth_error"].startswith("not json: please sign in as <email> x")
    assert len(raw.meta["auth_error"]) == 200
    assert "example" not in repr(raw)


def test_bad_envelope(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "bad_envelope")
    raw = CliUsageSource(fake, timeout_seconds=20).fetch(account)
    assert raw.text.strip() == "plain text, not json"
    assert "envelope_error" in raw.meta


def calls(log: Path) -> list[str]:
    return log.read_text(encoding="utf-8").splitlines() if log.exists() else []


def test_timeout(fake, account, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_MODE", "timeout")
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.log"))
    t0 = time.monotonic()
    raw = CliUsageSource(fake, timeout_seconds=3).fetch(account)
    assert raw.timed_out and raw.exit_code is None
    assert time.monotonic() - t0 < 30  # 60 秒待たずに打ち切られる
    assert raw.meta["auth"]["loggedIn"] is True
    # タイムアウトのときは --version を呼ばない
    assert "--version" not in calls(tmp_path / "calls.log") and raw.meta["cli_version"] is None


def test_timeout_is_a_deadline_for_the_whole_fetch(fake, account, monkeypatch, tmp_path):
    # auth status に 2 秒かかると、/usage の持ち時間はその分だけ減る（各プロセスに残り時間を渡す）
    monkeypatch.setenv("FAKE_MODE", "slow")
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.log"))
    t0 = time.monotonic()
    raw = CliUsageSource(fake, timeout_seconds=4).fetch(account)
    elapsed = time.monotonic() - t0
    assert raw.timed_out and raw.meta["auth"]["loggedIn"] is True
    # 締め切り 4 秒 + 終了処理の余裕。auth と /usage に別々に 4 秒ずつ渡していたら 6 秒を超える
    assert elapsed < 5.8, elapsed


def test_auth_timeout_and_launch_failure_skip_version(fake, account, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_MODE", "auth_timeout")
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.log"))
    raw = CliUsageSource(fake, timeout_seconds=2).fetch(account)
    assert raw.timed_out and "--version" not in calls(tmp_path / "calls.log")
    assert CliUsageSource._version_cache == {}


def test_launch_failure(account):
    raw = CliUsageSource("definitely-not-a-real-command-xyz").fetch(account)
    assert raw.error and raw.exit_code is None and not raw.timed_out
    assert raw.text == ""


def test_version_is_cached_for_an_hour(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "ok")
    src = CliUsageSource(fake, timeout_seconds=20)
    src.fetch(account)
    version, expires = CliUsageSource._version_cache[tuple(fake)]
    assert version == "9.9.9 (fake)"
    assert 3500 < expires - time.monotonic() <= 3600
    CliUsageSource._version_cache[tuple(fake)] = ("cached", time.monotonic() + 60)
    assert src.fetch(account).meta["cli_version"] == "cached"
    # 期限が切れたら取り直す
    CliUsageSource._version_cache[tuple(fake)] = ("old", time.monotonic() - 1)
    assert src.fetch(account).meta["cli_version"] == "9.9.9 (fake)"


def test_version_failure_is_not_cached(fake, account, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "version_fail")
    src = CliUsageSource(fake, timeout_seconds=20)
    assert src._cli_version() is None
    assert CliUsageSource._version_cache == {}
