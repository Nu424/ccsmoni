"""insights（純粋関数）のテスト。時計はすべて引数で渡す。"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from ccsmoni import insights
from ccsmoni.insights import hints, history_series, pace, window_peaks

JST = ZoneInfo("Asia/Tokyo")
H = 3600
DAY = 86400
# 2026-10-30（金）12:00 JST
NOW = int(datetime(2026, 10, 30, 3, 0, tzinfo=UTC).timestamp())


def lim(kind="weekly_all", percent=50.0, resets_in=3 * DAY, label=None):
    return {
        "kind": kind,
        "label": label or {"session": "Current session", "weekly_all": "Current week (all models)"}.get(kind, kind),
        "percent": percent,
        "resets_at": NOW + resets_in if resets_in is not None else None,
    }


# ---------------------------------------------------------------- pace


def test_pace_elapsed_ratio_and_expected():
    p = pace(lim("weekly_all", 10, resets_in=int(3.5 * DAY)), NOW)
    assert p["elapsed_ratio"] == 0.5 and p["expected_percent"] == 50.0
    p = pace(lim("session", 10, resets_in=4 * H), NOW)
    assert p["elapsed_ratio"] == 0.2


def test_pace_clamps_ratio():
    assert pace(lim(resets_in=8 * DAY), NOW)["elapsed_ratio"] == 0.0  # 表示の揺れで 7 日より先
    assert pace(lim(resets_in=-H), NOW)["elapsed_ratio"] == 1.0  # リセット時刻を過ぎた古い値


def test_pace_none_without_reset_or_unknown_kind():
    assert pace(lim(resets_in=None), NOW) is None
    assert pace(lim(kind="other"), NOW) is None


def test_eta_from_window_average_when_few_points():
    # 週間枠の開始から 3.5 日で 50% → 平均速度なら残り 3.5 日でちょうど 100%。リセットより前ではないので null
    assert pace(lim("weekly_all", 50, resets_in=int(3.5 * DAY)), NOW)["eta_full"] is None
    # 2 日で 50%（開始から）→ あと 2 日で 100%。リセットまで 5 日あるので予測が出る
    p = pace(lim("weekly_all", 50, resets_in=5 * DAY), NOW)
    assert p["eta_full"] == NOW + 2 * DAY


def test_eta_uses_recent_rate_when_24h_of_history():
    # 直近 24 時間で 36% → 60%（1%/h）。残り 40% は 40 時間後。平均速度（2日で60% → 残り 40% は 32 時間）より遅い
    pts = [(NOW - 24 * H + i * H, 36 + i) for i in range(25)]
    p = pace(lim("weekly_all", 60, resets_in=5 * DAY), NOW, pts)
    assert p["eta_full"] == NOW + 40 * H


def test_eta_short_burst_does_not_extrapolate():
    # 回帰: 週間 65%・リセットまで 5 日。直近 1 時間だけ 5%/h で増えた。
    # 以前は 1 時間の勢いを延ばして「7 時間後に上限」と出ていた。24 時間分の履歴が無いので平均速度を使う。
    burst = [(NOW - H + i * 600, 60 + 5 * i / 6) for i in range(7)]
    p = pace(lim("weekly_all", 65, resets_in=5 * DAY), NOW, burst)
    # 開始から 2 日で 65% → 32.5%/日 → 残り 35% は約 25.8 時間後
    assert p["eta_full"] == NOW + round(35 / (65 / (2 * DAY)))
    assert p["eta_full"] > NOW + DAY
    # 4 時間分でも同じ（週間枠は 24 時間分そろうまで直近の速度を使わない）
    four = [(NOW - 4 * H + i * H, 45 + 5 * i) for i in range(5)]
    assert pace(lim("weekly_all", 65, resets_in=5 * DAY), NOW, four)["eta_full"] == p["eta_full"]


def test_eta_none_right_after_window_start():
    # 週間枠が始まって 6 時間で 10%（平均なら 2.5 日で上限）でも、12 時間たつまでは予測しない
    assert pace(lim("weekly_all", 10, resets_in=7 * DAY - 6 * H), NOW)["eta_full"] is None
    assert pace(lim("weekly_all", 10, resets_in=7 * DAY - 13 * H), NOW)["eta_full"] is not None
    # 5h 枠は 30 分
    assert pace(lim("session", 30, resets_in=5 * H - 20 * 60), NOW)["eta_full"] is None
    # すでに上限なら出す
    assert pace(lim("session", 100, resets_in=5 * H - 5 * 60), NOW)["eta_full"] == NOW


def test_eta_session_recent_needs_one_hour():
    # 5h 枠: 開始 3 時間で 30%（平均 10%/h → 7 時間後でリセットより後）。直近 1 時間分の点がそろえば、その傾きを使う
    pts = [(NOW - H + i * 600, 10 + 20 * i / 6) for i in range(7)]  # 20%/h → 3.5 時間後。まだリセットより後
    p = pace(lim("session", 30, resets_in=2 * H), NOW, pts)
    assert p["eta_full"] is None
    # 30 分ぶんしか無ければ、速くても平均速度のまま
    half = [(NOW - 30 * 60 + i * 600, 0 + 10 * i) for i in range(4)]  # 60%/h
    assert pace(lim("session", 30, resets_in=2 * H), NOW, half)["eta_full"] is None
    pts2 = [(NOW - H + i * 600, -30 + 60 * i / 6) for i in range(7)]  # 60%/h
    p2 = pace(lim("session", 30, resets_in=2 * H), NOW, pts2)
    assert p2["eta_full"] == NOW + 70 * 60  # 残り 70% を 60%/h


def test_eta_none_when_recent_rate_flat_or_after_reset():
    # 直近 24 時間まったく増えていない → 予測しない（平均速度なら 2 日で 60% なので出てしまう）
    flat = [(NOW - 24 * H + i * H, 60) for i in range(25)]
    assert pace(lim("weekly_all", 60, resets_in=5 * DAY), NOW, flat)["eta_full"] is None
    slow = [(NOW - 24 * H + i * H, 58 + 0.1 * i) for i in range(25)]
    assert pace(lim("weekly_all", 60.4, resets_in=DAY), NOW, slow)["eta_full"] is None


def test_eta_ignores_old_points_and_short_span():
    # 1時間より前の点は 5h 枠の速度に使わない → 平均速度にフォールバック
    old = [(NOW - 3 * H, 0), (NOW - 2.5 * H, 50), (NOW - 2 * H, 90)]
    p = pace(lim("session", 90, resets_in=2 * H), NOW, old)
    # 開始から 3 時間で 90% → 30%/h → あと 20 分
    assert p["eta_full"] == NOW + 20 * 60


def test_eta_full_already_reached():
    assert pace(lim("session", 100, resets_in=H), NOW)["eta_full"] == NOW


def test_window_points_matches_jitter():
    rows = [
        {"kind": "session", "t": 1, "percent": 1, "resets_at": 1000},
        {"kind": "session", "t": 2, "percent": 2, "resets_at": 1000 + 60},
        {"kind": "session", "t": 3, "percent": 3, "resets_at": 1000 + 5 * H},
        {"kind": "weekly_all", "t": 4, "percent": 4, "resets_at": 1000},
        {"kind": "session", "t": 5, "percent": 0, "resets_at": None},
    ]
    assert insights.window_points(rows, "session", 1000) == [(1, 1), (2, 2)]


# ---------------------------------------------------------------- hints


def state(*limits, status="ok"):
    out = []
    for x in limits:
        x = dict(x)
        x["pace"] = pace(x, NOW)
        out.append(x)
    return {"status": status, "limits": out}


def test_use_it_or_lose_it():
    s = state(lim("weekly_all", 64, resets_in=20 * H))
    assert hints(s, NOW, tz=JST) == [
        {"kind": "use_it_or_lose_it", "text": "週間リセットまで 20 時間・残り 36%。使わないと損です"}
    ]


def test_use_it_or_lose_it_thresholds():
    assert hints(state(lim("weekly_all", 71, resets_in=20 * H)), NOW) == []  # 残り 29%
    assert hints(state(lim("weekly_all", 10, resets_in=37 * H)), NOW) == []  # 37 時間前
    custom = hints(state(lim("weekly_all", 10, resets_in=37 * H)), NOW, lose_within_hours=48)
    assert [h["kind"] for h in custom] == ["use_it_or_lose_it"]


def test_use_it_or_lose_it_prefers_all_models_and_dedupes():
    s = state(
        lim("weekly_model:sonnet", 5, resets_in=10 * H, label="Current week (Sonnet)"),
        lim("weekly_all", 20, resets_in=10 * H),
    )
    hs = hints(s, NOW)
    assert len(hs) == 1 and hs[0]["text"].startswith("週間リセットまで 10 時間・残り 80%")
    only_model = hints(state(lim("weekly_model:sonnet", 5, resets_in=30 * 60, label="Current week (Sonnet)")), NOW)
    assert only_model[0]["text"] == "週間（Sonnet）のリセットまで 30 分・残り 95%。使わないと損です"


def test_will_hit_limit_text_uses_local_weekday():
    # 開始から 2 日で 50% → 金 12:00 JST の 2 日後 = 日 12:00
    s = state(lim("weekly_all", 50, resets_in=5 * DAY))
    assert hints(s, NOW, tz=JST) == [{"kind": "will_hit_limit", "text": "このペースだと 日 12:00 に週間上限"}]


def test_hints_order_and_limit():
    s = state(
        lim("weekly_all", 50, resets_in=5 * DAY),  # 日 12:00 に上限
        lim("session", 90, resets_in=2 * H),  # 開始 3h で 90% → 20 分後に上限
        lim("weekly_model:x", 10, resets_in=10 * H, label="Current week (X)"),  # 使わないと損
    )
    hs = hints(s, NOW, tz=JST)
    assert [h["kind"] for h in hs] == ["will_hit_limit", "will_hit_limit"]
    assert hs[0]["text"] == "このペースだと 金 12:20 に5時間枠の上限"
    assert len(hints(s, NOW, max_hints=3)) == 3


def test_hints_reached_and_not_ok():
    s = state(lim("session", 100, resets_in=H))
    assert hints(s, NOW, tz=JST) == [{"kind": "will_hit_limit", "text": "5時間枠の上限に達しています（リセットは 金 13:00）"}]
    assert hints(state(lim("weekly_all", 10, resets_in=H), status="logged_out"), NOW) == []


# ---------------------------------------------------------------- history_series


def row(t, percent, window_id, resets_at, account="a", kind="session"):
    return {"account_id": account, "kind": kind, "t": t, "percent": percent,
            "resets_at": resets_at, "window_id": window_id}


def test_history_segments_split_by_window_and_gap():
    m = 600
    rows = [
        row(0, 10, 1, 5000), row(m, 20, 1, 5000), row(2 * m, 30, 1, 5060),  # 同じ枠（resets_at が揺れても window_id で判断）
        row(3 * m, 0, None, None), row(4 * m, 0, None, None),  # 枠が始まっていない
        row(5 * m, 5, 2, 30000),
        row(5 * m + 31 * 60, 9, 2, 30000),  # 31 分空いた（間隔 10 分の 3 倍超）→ 同じ枠でも線を切る
    ]
    out = history_series(rows, [], since=0, until=20000, intervals={"a": 10})
    (s,) = out["series"]
    assert [(g["window_id"], len(g["points"])) for g in s["segments"]] == [(1, 3), (None, 2), (2, 1), (2, 1)]
    assert s["segments"][0]["resets_at"] == 5060
    assert s["segments"][0]["points"][0] == [0, 10]
    # resets: 範囲内に入った枠の切り替わり（枠 2 は until より後なので出ない）
    assert out["resets"] == [{"account_id": "a", "kind": "session", "t": 5060}]


def test_history_gaps_and_errors():
    snaps = [("a", 0, "ok"), ("a", 600, "logged_out"), ("a", 600 + 1801, "ok"), ("b", 100, "ok"), ("b", 5000, "ok")]
    out = history_series([], snaps, since=0, until=10000, intervals={"a": 10}, default_interval=60)
    assert out["gaps"] == [{"account_id": "a", "from": 600, "to": 2401}]  # b は既定 60 分なので 4900 秒は抜けでない
    assert out["errors"] == [{"account_id": "a", "t": 600, "status": "logged_out"}]
    assert (out["since"], out["until"]) == (0, 10000)


def test_history_series_order():
    rows = [row(0, 1, 1, 99, account="z"), row(0, 1, 2, 99, account="a", kind="session"),
            row(0, 1, 3, 99, account="a", kind="weekly_all")]
    out = history_series(rows, [], since=0, until=10, intervals={}, account_order=["z", "a"])
    assert [(s["account_id"], s["kind"]) for s in out["series"]] == [("z", "session"), ("a", "weekly_all"), ("a", "session")]


# ---------------------------------------------------------------- window_peaks


def test_window_peaks_newest_first_in_config_order():
    ws = [
        {"id": 1, "account_id": "a", "kind": "weekly_all", "resets_at": 100, "first_seen": 0, "last_seen": 90, "peak_percent": 50},
        {"id": 2, "account_id": "a", "kind": "weekly_all", "resets_at": 200, "first_seen": 100, "last_seen": 190, "peak_percent": 80},
        {"id": 3, "account_id": "b", "kind": "weekly_all", "resets_at": 200, "first_seen": 100, "last_seen": 190, "peak_percent": 10},
        {"id": 4, "account_id": "old", "kind": "weekly_all", "resets_at": 200, "first_seen": 100, "last_seen": 190, "peak_percent": 1},
    ]
    rows = window_peaks(ws, ["b", "a"], limit=1)
    assert [r["account_id"] for r in rows] == ["b", "a", "old"]  # 設定に無い（アーカイブ）ものは後ろ
    assert rows[1]["windows"] == [{"resets_at": 200, "peak_percent": 80, "first_seen": 100}]
