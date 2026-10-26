"""parser_usage のテスト。fixture 6種と境界ケース。取得時刻は fixture の採取時刻付近に固定する。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ccsmoni.model import RawResult, Status
from ccsmoni.parser_usage import UsageTextParser, parse_usage_text

FIXTURES = Path(__file__).parent / "fixtures"
JST = timezone(timedelta(hours=9))
UTC = timezone.utc
# fixture の採取時刻（2026-10-27 02:50 JST）
TAKEN = datetime(2026, 10, 27, 2, 50, tzinfo=JST)


def load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def by_kind(limits):
    return {lim.kind: lim for lim in limits}


# --- fixture ---------------------------------------------------------------


def test_ok_basic_minute_less_time():
    status, limits, msg = parse_usage_text(load("ok_basic.txt"), TAKEN)
    assert status is Status.OK and msg is None
    d = by_kind(limits)
    assert list(d) == ["session", "weekly_all"]
    assert d["session"].percent == 6
    assert d["session"].resets_at == utc(2026, 10, 26, 19, 20)
    assert d["weekly_all"].label == "Current week (all models)"
    assert d["weekly_all"].resets_at == utc(2026, 10, 30, 7, 0)  # Oct 30, 4pm JST


def test_ok_with_model_week():
    status, limits, _ = parse_usage_text(load("ok_with_model_week.txt"), TAKEN)
    assert status is Status.OK
    d = by_kind(limits)
    assert list(d) == ["session", "weekly_all", "weekly_model:fable"]
    assert d["session"].percent == 47
    assert d["session"].resets_at == utc(2026, 10, 26, 18, 9)
    assert d["weekly_all"].percent == 63
    assert d["weekly_all"].resets_at == utc(2026, 11, 1, 11, 59)
    assert d["weekly_model:fable"].label == "Current week (Fable)"
    assert d["weekly_model:fable"].percent == 15
    assert d["weekly_model:fable"].resets_at == utc(2026, 11, 1, 11, 59)


def test_ok_24h_and_7d_ignores_contributing_section():
    status, limits, _ = parse_usage_text(load("ok_24h_and_7d.txt"), TAKEN)
    assert status is Status.OK
    d = by_kind(limits)
    assert len(limits) == 3  # 「Last 24h」以降の行を枠と誤認しない
    assert d["session"].percent == 0
    assert d["session"].resets_at == utc(2026, 10, 26, 21, 19)
    assert d["weekly_all"].percent == 97
    assert d["weekly_all"].resets_at == utc(2026, 10, 31, 17, 59)


def test_ok_no_reset_no_week():
    status, limits, _ = parse_usage_text(load("ok_no_reset_no_week.txt"), TAKEN)
    assert status is Status.OK
    assert len(limits) == 1
    assert limits[0].kind == "session" and limits[0].percent == 0
    assert limits[0].resets_at is None


def test_ok_week_near_reset():
    status, limits, _ = parse_usage_text(load("ok_week_near_reset.txt"), TAKEN)
    assert status is Status.OK
    d = by_kind(limits)
    assert d["weekly_all"].resets_at == utc(2026, 10, 27, 2, 59)  # 取得の9分後
    assert d["weekly_model:fable"].percent == 94


def test_logged_out_cost_view():
    status, limits, msg = parse_usage_text(load("logged_out_cost_view.txt"), TAKEN)
    assert status is Status.LOGGED_OUT
    assert limits == []
    assert msg and "ログイン" in msg


# --- 境界ケース ------------------------------------------------------------


def test_year_rollover_jan_seen_in_december():
    taken = datetime(2026, 12, 30, 12, 0, tzinfo=JST)
    text = "Current week (all models): 10% used · resets Jan 2, 3:00am (Asia/Tokyo)"
    _, limits, _ = parse_usage_text(text, taken)
    assert limits[0].resets_at == utc(2027, 1, 1, 18, 0)


def test_year_rollover_dec_seen_in_january():
    # 取得直後の過去（-1日以内）が前年にならないこと、直前の12月が前年として解釈されること
    taken = datetime(2027, 1, 1, 0, 30, tzinfo=JST)
    text = "Current session: 5% used · resets Dec 31, 11:00pm (Asia/Tokyo)"
    _, limits, _ = parse_usage_text(text, taken)
    assert limits[0].resets_at == utc(2026, 12, 31, 14, 0)


def test_noon_and_midnight_12h_clock():
    text = (
        "Current session: 1% used · resets Oct 27, 12pm (Asia/Tokyo)\n"
        "Current week (all models): 1% used · resets Oct 28, 12am (Asia/Tokyo)\n"
    )
    _, limits, _ = parse_usage_text(text, TAKEN)
    assert limits[0].resets_at == utc(2026, 10, 27, 3, 0)
    assert limits[1].resets_at == utc(2026, 10, 27, 15, 0)


def test_decimal_percent():
    _, limits, _ = parse_usage_text("Current session: 12.5% used · resets Oct 27, 4pm (Asia/Tokyo)", TAKEN)
    assert limits[0].percent == 12.5


@pytest.mark.parametrize("sep", ["·", "-", "|", "・", "•", "｜", "—", " "])
def test_separator_variations(sep):
    text = f"Current session: 47% used {sep} resets Oct 27, 3:09am (Asia/Tokyo)"
    _, limits, _ = parse_usage_text(text, TAKEN)
    assert limits[0].percent == 47
    assert limits[0].resets_at == utc(2026, 10, 26, 18, 9)


def test_unknown_model_name_is_lowercased_into_kind():
    text = "Current week (Some New Model): 20% used · resets Nov 1, 8:59pm (Asia/Tokyo)"
    _, limits, _ = parse_usage_text(text, TAKEN)
    assert limits[0].kind == "weekly_model:some new model"
    assert limits[0].label == "Current week (Some New Model)"


def test_other_timezone_is_converted_to_utc():
    text = "Current session: 1% used · resets Oct 27, 9:00am (America/Los_Angeles)"
    _, limits, _ = parse_usage_text(text, TAKEN)
    assert limits[0].resets_at == utc(2026, 10, 27, 16, 0)  # PDT = UTC-7


def test_missing_or_invalid_timezone_falls_back_to_local_time():
    expected = datetime(2026, 10, 27, 4, 0).astimezone().astimezone(UTC)
    for tail in ("", " (Not/AZone)"):
        text = f"Current session: 1% used · resets Oct 27, 4:00am{tail}"
        _, limits, _ = parse_usage_text(text, TAKEN)
        assert limits[0].resets_at == expected


def test_unreadable_resets_keeps_the_limit_with_none():
    _, limits, _ = parse_usage_text("Current session: 9% used · resets soon", TAKEN)
    assert limits[0].percent == 9 and limits[0].resets_at is None


def test_empty_string_is_parse_error():
    status, limits, msg = parse_usage_text("", TAKEN)
    assert status is Status.PARSE_ERROR and limits == []
    assert "形式が変わった" in msg


def test_unknown_format_is_parse_error():
    status, _, msg = parse_usage_text("Something completely different\nUsage: n/a", TAKEN)
    assert status is Status.PARSE_ERROR
    assert "形式が変わった" in msg


# --- UsageTextParser -------------------------------------------------------


def raw(text: str = "", **kw) -> RawResult:
    return RawResult(source="cli-usage", started_at=TAKEN.astimezone(UTC), duration_ms=100, text=text, **kw)


def test_parser_ok_with_auth_extras():
    r = raw(load("ok_with_model_week.txt"), exit_code=0, meta={"auth": {"loggedIn": True, "subscriptionType": "max", "orgId": "org-1"}})
    reading = UsageTextParser().parse(r, "acct-a")
    assert reading.status is Status.OK
    assert reading.account_id == "acct-a" and reading.probe == "cli-usage"
    assert reading.taken_at == r.started_at
    assert reading.extras == {"plan": "max", "org_id": "org-1"}
    assert reading.limit("weekly_model:fable").percent == 15
    reading.to_dict()  # JSON 化できる


def test_parser_ok_without_auth_meta():
    reading = UsageTextParser().parse(raw(load("ok_basic.txt"), exit_code=0), "a")
    assert reading.status is Status.OK and reading.extras == {}


def test_parser_timed_out():
    reading = UsageTextParser().parse(raw(timed_out=True), "a")
    assert reading.status is Status.TIMEOUT


def test_parser_error():
    reading = UsageTextParser().parse(raw(error="claude が見つかりません"), "a")
    assert reading.status is Status.ERROR
    assert "claude" in reading.message


def test_parser_auth_logged_out_ignores_text():
    r = raw(load("ok_basic.txt"), exit_code=0, meta={"auth": {"loggedIn": False, "subscriptionType": "pro"}})
    reading = UsageTextParser().parse(r, "a")
    assert reading.status is Status.LOGGED_OUT
    assert reading.limits == ()
    assert reading.extras == {"plan": "pro"}


def test_parser_cost_view_without_auth_is_logged_out():
    reading = UsageTextParser().parse(raw(load("logged_out_cost_view.txt"), exit_code=0), "a")
    assert reading.status is Status.LOGGED_OUT
