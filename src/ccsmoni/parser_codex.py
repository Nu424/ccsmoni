"""codex app-server の rateLimits を Reading に変換するパーサー。

何を: CodexAppServerSource の raw（rateLimits/read の結果のうち残したもの）と auth から、状態・枠ごとの使用率・リセット時刻を取り出す。
なぜ: 下流（保存・分析・表示）が Claude と同じ形（session / weekly_all など）だけを見ればよいようにする（docs/design/CODEX.md）。
方針: 枠の種類は、位置（primary / secondary）ではなく windowDurationMins で決める（プランによって週間枠だけが primary に入るため）。
      時計も外部も見ない純粋関数。読めなければ PARSE_ERROR にする。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from ccsmoni.model import Limit, RawResult, Reading, Status

PROBE_NAME = "codex-app-server"
MAIN_LIMIT_ID = "codex"  # 全体の枠の limitId。それ以外はモデル別などの枠

SESSION_MINS = 5 * 60
WEEK_MINS = 7 * 24 * 60

MSG_LOGGED_OUT = "ログインが切れています（codex login が必要です）"
MSG_PARSE_ERROR = "codex app-server の応答の形式が変わった可能性があります"


def _limit(window: Any, limit_id: str, name: str | None) -> Limit | None:
    if not isinstance(window, dict):
        return None
    pct, mins, resets = window.get("usedPercent"), window.get("windowDurationMins"), window.get("resetsAt")
    if isinstance(pct, bool) or not isinstance(pct, (int, float)):
        return None
    main = limit_id == MAIN_LIMIT_ID
    tag = name or limit_id
    if mins == SESSION_MINS:
        kind, label = ("session", "5h limit") if main else (f"session_model:{tag}", f"5h limit ({tag})")
    elif mins == WEEK_MINS:
        kind, label = ("weekly_all", "Weekly limit") if main else (f"weekly_model:{tag}", f"Weekly limit ({tag})")
    else:
        size = f"{mins}m" if isinstance(mins, int) else "unknown"
        kind = f"window_{size}" if main else f"window_{size}:{tag}"
        label = f"{size} limit" if main else f"{size} limit ({tag})"
    at = None
    if isinstance(resets, (int, float)) and not isinstance(resets, bool) and resets > 0:
        at = datetime.fromtimestamp(resets, UTC)
    return Limit(kind=kind, label=label, percent=float(pct), resets_at=at)


def parse_rate_limits(text: str) -> tuple[list[Limit], dict[str, Any]]:
    """raw の本文（JSON）を (limits, extras) にする。読めなければ ([], {})。"""
    try:
        data = json.loads(text)
    except ValueError:
        return [], {}
    if not isinstance(data, dict):
        return [], {}
    snaps = data.get("rateLimitsByLimitId")
    if not isinstance(snaps, dict) or not snaps:
        one = data.get("rateLimits")
        snaps = {(one or {}).get("limitId") or MAIN_LIMIT_ID: one} if isinstance(one, dict) else {}
    limits: list[Limit] = []
    seen: set[str] = set()
    extras: dict[str, Any] = {}
    for key, snap in snaps.items():
        if not isinstance(snap, dict):
            continue
        limit_id = snap.get("limitId") or key
        for w in ("primary", "secondary"):
            lim = _limit(snap.get(w), limit_id, snap.get("limitName"))
            if lim is not None and lim.kind not in seen:
                seen.add(lim.kind)
                limits.append(lim)
        if limit_id == MAIN_LIMIT_ID:
            if snap.get("planType") and snap["planType"] != "unknown":
                extras["plan"] = snap["planType"]
            if snap.get("rateLimitReachedType"):
                extras["reached"] = snap["rateLimitReachedType"]
    if data.get("ordinaryUsageAllowed") is False:
        extras["usage_allowed"] = False
    # Claude と同じ並び（session → weekly_all → その他）にする
    order = {"session": 0, "weekly_all": 1}
    limits.sort(key=lambda lim: order.get(lim.kind, 2))
    return limits, extras


class CodexRateLimitsParser:
    """probes/base.py の Parser。RawResult だけから Reading を作る（reparse でも同じ結果になる）。"""

    def parse(self, raw: RawResult, account_id: str) -> Reading:
        taken_at = raw.started_at

        def reading(status: Status, message: str | None = None, limits=(), extras=None) -> Reading:
            return Reading(
                account_id=account_id,
                taken_at=taken_at,
                probe=PROBE_NAME,
                status=status,
                limits=tuple(limits),
                message=message,
                extras=extras or {},
            )

        extras: dict[str, Any] = {}
        auth = raw.meta.get("auth")
        if isinstance(auth, dict):
            if auth.get("planType") and auth["planType"] != "unknown":
                extras["plan"] = auth["planType"]
            if auth.get("orgId"):
                extras["org_id"] = auth["orgId"]

        if raw.timed_out:
            return reading(Status.TIMEOUT, "取得がタイムアウトしました", extras=extras)
        if raw.error:
            return reading(Status.ERROR, raw.error, extras=extras)
        if isinstance(auth, dict) and auth.get("loggedIn") is False:
            return reading(Status.LOGGED_OUT, MSG_LOGGED_OUT, extras=extras)

        limits, more = parse_rate_limits(raw.text)
        if not limits:
            return reading(Status.PARSE_ERROR, MSG_PARSE_ERROR, extras=extras)
        return reading(Status.OK, None, limits, {**more, **extras})
