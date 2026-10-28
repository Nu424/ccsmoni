"""CodexRateLimitsParser の単体テスト。"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from ccsmoni.model import RawResult, Status
from ccsmoni.parser_codex import CodexRateLimitsParser
from ccsmoni.probes.routing import RoutingParser

AT = datetime(2026, 10, 29, 3, 0, tzinfo=UTC)
AUTH = {"loggedIn": True, "authMethod": "chatgpt", "planType": "plus", "orgId": "abcd"}


def raw(text: str = "", auth: dict | None = AUTH, **kw) -> RawResult:
    meta = {"auth": auth} if auth is not None else {}
    return RawResult("codex-app-server", AT, 3000, text, exit_code=kw.pop("exit_code", 0), meta=meta, **kw)


def snap(primary, secondary=None, limit_id="codex", name=None, plan="plus"):
    return {"limitId": limit_id, "limitName": name, "primary": primary, "secondary": secondary,
            "planType": plan, "rateLimitReachedType": None}


def body(*snaps, top=None) -> str:
    return json.dumps({"rateLimits": top or snaps[0], "rateLimitsByLimitId": {s["limitId"]: s for s in snaps}})


def parse(r: RawResult):
    return CodexRateLimitsParser().parse(r, "codex-a")


def test_session_and_weekly():
    r = parse(raw(body(snap({"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1793790000},
                            {"usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1794200000}))))
    assert r.status == Status.OK and r.probe == "codex-app-server"
    assert [(lim.kind, lim.label, lim.percent) for lim in r.limits] == [
        ("session", "5h limit", 12.0), ("weekly_all", "Weekly limit", 40.0)]
    assert r.limit("session").resets_at == datetime.fromtimestamp(1793790000, UTC)
    assert r.extras == {"plan": "plus", "org_id": "abcd"}


def test_weekly_only_in_primary_is_classified_by_length():
    # プランによっては週間枠だけが primary に入る（secondary は null）
    r = parse(raw(body(snap({"usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1793817986}, plan="unknown")),
                  auth={"loggedIn": True, "planType": "unknown"}))
    assert r.status == Status.OK
    assert [lim.kind for lim in r.limits] == ["weekly_all"]
    assert "plan" not in r.extras  # unknown は記録しない


def test_other_limit_ids_become_model_limits():
    main = snap({"usedPercent": 5, "windowDurationMins": 300, "resetsAt": None},
                {"usedPercent": 30, "windowDurationMins": 10080, "resetsAt": 1794200000})
    other = snap({"usedPercent": 7, "windowDurationMins": 300, "resetsAt": 1793790000},
                 {"usedPercent": 50, "windowDurationMins": 10080, "resetsAt": 1794200000}, limit_id="codex_x", name="Spark")
    odd = snap({"usedPercent": 1, "windowDurationMins": 60, "resetsAt": 1793790000}, limit_id="codex_y")
    r = parse(raw(body(main, other, odd)))
    kinds = [lim.kind for lim in r.limits]
    assert kinds[:2] == ["session", "weekly_all"]
    assert set(kinds[2:]) == {"session_model:Spark", "weekly_model:Spark", "window_60m:codex_y"}
    assert r.limit("session").resets_at is None  # 枠が始まっていない
    assert r.limit("weekly_model:Spark").label == "Weekly limit (Spark)"


def test_falls_back_to_single_bucket_view():
    one = snap({"usedPercent": 9, "windowDurationMins": 300, "resetsAt": 1793790000})
    r = parse(raw(json.dumps({"rateLimits": one})))
    assert [lim.kind for lim in r.limits] == ["session"]


def test_logged_out_timeout_error_and_parse_error():
    assert parse(raw("", auth={"loggedIn": False})).status == Status.LOGGED_OUT
    assert parse(raw("", timed_out=True, exit_code=None)).status == Status.TIMEOUT
    e = parse(raw("", error="account/rateLimits/read: boom"))
    assert e.status == Status.ERROR and e.message == "account/rateLimits/read: boom"
    assert parse(raw("not json")).status == Status.PARSE_ERROR
    assert parse(raw(json.dumps({"rateLimits": {"primary": {"windowDurationMins": 300}}}))).status == Status.PARSE_ERROR


def test_routing_parser_dispatches_by_source():
    p = RoutingParser()
    codex = raw(body(snap({"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1793790000})))
    assert p.parse(codex, "x").probe == "codex-app-server"
    claude = RawResult("cli-usage", AT, 10, "Current session: 6% used", exit_code=0)
    assert p.parse(claude, "x").probe == "cli-usage"
    # 知らない source（例外時の raw など）は Claude のパーサーに渡す
    assert p.parse(RawResult("cli", AT, 10, "", error="boom"), "x").status == Status.ERROR
