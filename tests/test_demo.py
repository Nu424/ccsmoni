"""demo（架空データの生成と、serve --demo 用の偽 Source）のテスト。"""

from __future__ import annotations

from ccsmoni import demo
from ccsmoni.config import ConfigService
from ccsmoni.model import Account, Status
from ccsmoni.parser_usage import UsageTextParser
from ccsmoni.store import Store

ANCHOR = 1_793_000_000.0


def test_create_demo_home_and_live_source(tmp_path):
    counts = demo.create_demo_home(tmp_path, days=3, now=ANCHOR)
    assert set(counts) == {"acct-a", "acct-b", "acct-c", "acct-d"}
    assert counts["acct-b"] > counts["acct-a"] > 0  # acct-b は 5 分間隔

    cfg, _ = ConfigService(tmp_path / "config.toml").load()
    assert [a.id for a in cfg.accounts] == ["acct-a", "acct-b", "acct-c", "acct-d"]
    assert cfg.collector.discover_roots == []  # 実環境を走査しない

    store = Store(tmp_path / "ccsmoni.db")
    try:
        latest = store.latest()
        assert latest["acct-a"].status == Status.OK
        assert latest["acct-d"].status == Status.LOGGED_OUT  # いまログインが切れている
        assert store.latest_ok("acct-d") is not None
        assert store.windows(kind="weekly_all")
    finally:
        store.close()

    # serve --demo の Source は履歴の続きを返す（同じモデル）。ログインすると数秒後に ok になる
    t = [ANCHOR + 60]
    src = demo.DemoSource(tmp_path, clock=lambda: t[0], delay=0)
    parser = UsageTextParser()
    acc = Account("acct-d", "D", tmp_path / "x")
    assert parser.parse(src.fetch(acc), "acct-d").status == Status.LOGGED_OUT
    src.mark_login_soon("acct-d", seconds=5)
    t[0] += 10
    assert src.auth_status(acc)["loggedIn"] is True
    assert parser.parse(src.fetch(acc), "acct-d").status == Status.OK


def test_create_demo_home_refuses_non_demo_dir(tmp_path):
    (tmp_path / "config.toml").write_text("", encoding="utf-8")
    try:
        demo.create_demo_home(tmp_path, days=1, now=ANCHOR, force=True)
        raise AssertionError("FileExistsError になるはず")
    except FileExistsError:
        pass
