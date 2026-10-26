"""Store（SQLite 保存層）のテスト。DB は ":memory:" か tmp_path を使う。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ccsmoni.model import Limit, RawResult, Reading, Status
from ccsmoni.store import Store

T0 = datetime(2026, 10, 27, 0, 0, tzinfo=UTC)
RESET = datetime(2026, 10, 27, 4, 20, tzinfo=UTC)


@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


def make_raw(at: datetime, text: str = "raw") -> RawResult:
    return RawResult(source="cli-usage", started_at=at, duration_ms=1234, text=text,
                     exit_code=0, meta={"version": "1.2.3"})


def make_reading(account="a", at=T0, percent=10.0, resets_at=RESET, kind="session",
                 status=Status.OK, extras=None) -> Reading:
    limits = () if status != Status.OK else (
        Limit(kind=kind, label="Current session", percent=percent, resets_at=resets_at),
    )
    return Reading(account_id=account, taken_at=at, probe="cli-usage", status=status,
                   limits=limits, extras=extras or {})


def put(store, **kw) -> int:
    r = make_reading(**kw)
    return store.save(make_raw(r.taken_at), r)


def test_save_latest_roundtrip(store):
    reading = Reading(
        account_id="a", taken_at=T0, probe="cli-usage", status=Status.OK,
        limits=(
            Limit("session", "Current session", 6.0, RESET),
            Limit("weekly_all", "Current week (all models)", 42.5, RESET + timedelta(days=3)),
            Limit("weekly_model:x", "Current week (x)", 0.0, None),
        ),
        message="hi", extras={"plan": "max", "n": 1},
    )
    store.save(make_raw(T0), reading)
    assert store.latest() == {"a": reading}
    assert store.latest(["a"]) == {"a": reading}
    assert store.latest(["zzz"]) == {}


def test_latest_returns_newest_per_account_and_latest_ok(store):
    put(store, at=T0, percent=10)
    put(store, at=T0 + timedelta(minutes=10), percent=20)
    put(store, at=T0 + timedelta(minutes=20), status=Status.LOGGED_OUT)
    put(store, account="b", at=T0, percent=5)
    latest = store.latest()
    assert latest["a"].status == Status.LOGGED_OUT
    assert latest["b"].limit("session").percent == 5
    ok = store.latest_ok("a")
    assert ok is not None and ok.limit("session").percent == 20
    assert store.latest_ok("nobody") is None


def test_raw_restored(store):
    sid = put(store, at=T0)
    (got_id, acct, raw), = list(store.iter_raw())
    assert (got_id, acct) == (sid, "a")
    assert raw == make_raw(T0)
    assert raw.started_at.tzinfo is not None


def test_window_absorbs_jitter_and_splits_new_window(store):
    put(store, at=T0, percent=10, resets_at=RESET)
    put(store, at=T0 + timedelta(minutes=10), percent=30, resets_at=RESET - timedelta(minutes=1))  # 丸めの揺れ
    put(store, at=T0 + timedelta(minutes=20), percent=25, resets_at=RESET)  # 少し下がった（表示の揺れ）: 同じ枠
    put(store, at=T0 + timedelta(hours=5), percent=3, resets_at=RESET + timedelta(hours=5))
    hist = store.history(T0 - timedelta(days=1))
    ids = [h["window_id"] for h in hist]
    assert ids[0] == ids[1] == ids[2] != ids[3]
    wins = store.windows(account_id="a", kind="session")
    assert len(wins) == 2
    assert wins[0]["peak_percent"] == 30  # 途中で下がっても最大値を保つ
    assert wins[1]["peak_percent"] == 3
    assert wins[0]["resets_at"] == int(RESET.timestamp())  # 最新の観測値
    assert wins[0]["first_seen"] == int(T0.timestamp())
    assert wins[0]["last_seen"] == int((T0 + timedelta(minutes=20)).timestamp())


def test_window_splits_on_large_drop_with_same_resets_at(store):
    # resets_at が同じでも、直前の値から 10 ポイント以上下がったらリセットされたとみなす（PLAN §4.2）
    put(store, at=T0, percent=10, resets_at=RESET)
    put(store, at=T0 + timedelta(minutes=10), percent=30, resets_at=RESET)
    put(store, at=T0 + timedelta(minutes=20), percent=20, resets_at=RESET)  # 30% → 20%: ちょうど 10 下がった
    put(store, at=T0 + timedelta(minutes=30), percent=11, resets_at=RESET)  # 20% → 11%: 9 だけなので同じ枠
    ids = [h["window_id"] for h in store.history(T0 - timedelta(days=1))]
    assert ids[0] == ids[1] != ids[2] == ids[3]
    wins = store.windows(account_id="a", kind="session")
    assert [w["peak_percent"] for w in wins] == [30, 20]
    assert wins[1]["first_seen"] == int((T0 + timedelta(minutes=20)).timestamp())
    # 他のアカウント・種類の値とは比べない
    put(store, account="b", at=T0 + timedelta(minutes=40), percent=1, resets_at=RESET)
    assert len(store.windows(account_id="a")) == 2 and len(store.windows(account_id="b")) == 1


def test_window_is_per_account_and_kind(store):
    put(store, account="a", at=T0)
    put(store, account="b", at=T0)
    put(store, account="a", at=T0, kind="weekly_all")
    assert len({w["id"] for w in store.windows()}) == 3


def test_no_resets_at_means_null_window(store):
    put(store, at=T0, percent=0, resets_at=None)
    (h,) = store.history(T0 - timedelta(hours=1))
    assert h["window_id"] is None and h["resets_at"] is None
    assert store.windows() == []


def test_history_filters(store):
    put(store, account="a", at=T0)
    put(store, account="a", at=T0 + timedelta(hours=1), kind="weekly_all")
    put(store, account="b", at=T0 + timedelta(hours=2))
    put(store, account="a", at=T0 + timedelta(hours=3))
    since = T0 + timedelta(minutes=30)
    assert [h["t"] for h in store.history(since)] == [
        int((T0 + timedelta(hours=h)).timestamp()) for h in (1, 2, 3)
    ]
    assert len(store.history(since, until=T0 + timedelta(hours=2))) == 2
    assert {h["account_id"] for h in store.history(T0, account_ids=["b"])} == {"b"}
    assert [h["kind"] for h in store.history(T0, kinds=["weekly_all"])] == ["weekly_all"]
    assert store.history(T0, account_ids=[]) == []
    h = store.history(T0)[0]
    assert set(h) == {"account_id", "kind", "t", "percent", "resets_at", "window_id"}


def test_snapshot_times(store):
    put(store, at=T0)
    put(store, at=T0 + timedelta(minutes=10), status=Status.ERROR)
    put(store, account="b", at=T0 + timedelta(minutes=5))
    assert store.snapshot_times(T0, ["a"]) == [
        ("a", int(T0.timestamp()), "ok"),
        ("a", int((T0 + timedelta(minutes=10)).timestamp()), "error"),
    ]
    assert len(store.snapshot_times(T0)) == 3
    # until（含む）で後ろを絞る
    assert store.snapshot_times(T0, until=T0 + timedelta(minutes=5)) == [
        ("a", int(T0.timestamp()), "ok"),
        ("b", int((T0 + timedelta(minutes=5)).timestamp()), "ok"),
    ]
    assert store.snapshot_times(T0, ["a"], until=T0 - timedelta(seconds=1)) == []


def test_account_meta(store):
    assert store.get_account_meta("a") is None
    put(store, at=T0, extras={"org_id": "org1", "plan": "max"})
    m = store.get_account_meta("a")
    assert (m["last_org_id"], m["last_plan"]) == ("org1", "max")
    # ok 以外では更新しない
    put(store, at=T0 + timedelta(minutes=1), status=Status.LOGGED_OUT, extras={"org_id": "org2"})
    assert store.get_account_meta("a")["last_org_id"] == "org1"
    # 片方だけなら、もう片方は残す
    put(store, at=T0 + timedelta(minutes=2), extras={"org_id": "org3"})
    m = store.get_account_meta("a")
    assert (m["last_org_id"], m["last_plan"]) == ("org3", "max")


class FixedParser:
    """raw.text の数値を percent にする。resets_at は固定。"""

    def parse(self, raw: RawResult, account_id: str) -> Reading:
        return Reading(
            account_id=account_id, taken_at=raw.started_at, probe="cli-usage", status=Status.OK,
            limits=(Limit("session", "s", float(raw.text), RESET),),
        )


def test_reparse_rebuilds_limits_and_windows(store):
    # 保存時のパース結果はわざと別の値（raw とは食い違う）にしておく
    for i, pct in enumerate([10, 40, 20]):
        at = T0 + timedelta(minutes=10 * i)
        store.save(make_raw(at, text=str(pct)), make_reading(at=at, percent=1, resets_at=RESET))
    at = T0 + timedelta(hours=5)
    store.save(make_raw(at, text="7"), make_reading(at=at, percent=1, resets_at=RESET + timedelta(hours=5)))

    def window_shape():
        h = store.history(T0 - timedelta(days=1))
        first = {x["window_id"] for x in h}
        return [x["window_id"] for x in h], len(first)

    before_ids, n = window_shape()
    assert store.reparse(FixedParser()) == 4
    assert [h["percent"] for h in store.history(T0 - timedelta(days=1))] == [10, 40, 20, 7]
    # reparse の resets_at は固定 RESET。それでも 40→20、20→7 と 10 ポイント以上下がったところで枠が分かれる。
    # 割り当て規則は決定的（もう一度 reparse しても同じ）
    first = store.windows()
    assert store.reparse(FixedParser()) == 4
    assert store.windows() == first
    assert [w["peak_percent"] for w in first] == [40, 20, 7]
    assert n == 2 and len(before_ids) == 4


def test_reparse_same_window_assignment_as_save(store):
    class EchoParser:
        """保存時と同じ Reading を作る（raw.text に percent、meta に resets_at を持たせる）。"""

        def parse(self, raw, account_id):
            return Reading(
                account_id=account_id, taken_at=raw.started_at, probe="cli-usage", status=Status.OK,
                limits=(Limit("session", "s", float(raw.text),
                              datetime.fromtimestamp(raw.meta["r"], UTC)),),
            )

    for i, (pct, r) in enumerate([(10, RESET), (30, RESET - timedelta(minutes=1)), (15, RESET),
                                  (5, RESET + timedelta(hours=5))]):
        at = T0 + timedelta(hours=2 * i)
        raw = RawResult("cli-usage", at, 1, str(pct), 0, meta={"r": int(r.timestamp())})
        store.save(raw, make_reading(at=at, percent=pct, resets_at=r))
    since = T0 - timedelta(days=1)
    h1, w1 = store.history(since), store.windows()
    assert len(w1) == 3  # 30→15 の下がり（resets_at は同じ）で分かれている
    assert store.reparse(EchoParser()) == 4
    assert store.history(since) == h1
    assert store.windows() == w1


def test_account_ids(store):
    assert store.account_ids() == []
    put(store, account="b", at=T0)
    put(store, account="a", at=T0, status=Status.ERROR)
    put(store, account="b", at=T0 + timedelta(minutes=1))
    assert store.account_ids() == ["a", "b"]


def test_persists_to_file_and_wal(tmp_path):
    p = tmp_path / "x.db"
    s = Store(p)
    put(s, at=T0)
    s.close()
    s2 = Store(p)
    try:
        assert "a" in s2.latest()
        assert s2._conn.execute("PRAGMA user_version").fetchone()[0] == 1
        assert s2._conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        s2.close()
