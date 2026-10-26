"""`/usage` のテキストを Reading に変換するパーサー。

何を: `claude -p "/usage"` の出力（と auth status の結果）から、状態・枠ごとの使用率・リセット時刻を取り出す。
なぜ: 下流（保存・分析・表示）が「テキストの見た目」を知らずに済むよう、ここで共通データ形式にそろえる（PLAN §4.1）。
方針: parse_usage_text は時計も外部も見ない純粋関数。判定順は PLAN §4.3 に従う。
      「What's contributing…」以降は構造化しない（raw は別途保存されるので、ここでは読み捨てる）。
      形式の揺れ（区切り記号、分なしの時刻、小数の %）には寛容に、それ以外は無理に読まず PARSE_ERROR にする。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ccsmoni.model import Limit, RawResult, Reading, Status

PROBE_NAME = "cli-usage"

MSG_LOGGED_OUT = "ログインが切れています（サブスクリプションで認証されていません）"
MSG_PARSE_ERROR = "/usage の出力形式が変わった可能性があります"

# --- 正規表現 -------------------------------------------------------------

# 枠の行。例:
#   Current session: 47% used · resets Oct 27, 3:09am (Asia/Tokyo)
#   Current week (Fable): 15% used · resets Nov 1, 8:59pm (Asia/Tokyo)
#   Current session: 0% used            ← 枠が始まっていないと resets が無い
# 区切り（· の揺れ）は記号の連続を許す。resets 部分は任意で、読めなければ resets_at=None にする。
_LIMIT_LINE = re.compile(
    r"""
    ^\s*
    (?P<heading>
        Current\ session
        |
        Current\ week (?:\s*\((?P<scope>[^)]*)\))?
    )
    \s*:\s*
    (?P<percent>\d+(?:\.\d+)?)\s*%\s*used
    (?P<rest>.*)$
    """,
    re.IGNORECASE | re.VERBOSE,
)

# 行の残り部分から「resets Oct 27, 3:09am (Asia/Tokyo)」を取り出す。分なし（4pm）・タイムゾーンなしも許す。
_RESETS = re.compile(
    r"""
    resets\s+
    (?P<month>[A-Za-z]+)\.?\s+
    (?P<day>\d{1,2}),?\s+
    (?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*
    (?P<ampm>[ap])\.?m\.?
    (?:\s*\((?P<tz>[^)]*)\))?
    """,
    re.IGNORECASE | re.VERBOSE,
)

_COST_VIEW = re.compile(r"^\s*Total cost:", re.IGNORECASE | re.MULTILINE)
_CONTRIBUTING = re.compile(r"What's contributing", re.IGNORECASE)

_MONTHS = {
    name: i
    for i, name in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1
    )
}


# --- リセット時刻の解釈 -----------------------------------------------------


def _resolve_resets_at(m: re.Match[str], taken_at: datetime) -> datetime | None:
    """resets 表記を UTC の datetime にする。読めなければ None。

    年は表示されないので、取得時刻から見て [-1日, +8日] に入る年を選ぶ（PLAN §4.2。年末年始をまたぐ対策）。
    タイムゾーン名が無い・不正なときは、この PC のローカルタイムとして解釈する。
    """
    month = _MONTHS.get(m["month"][:3].lower())
    hour12 = int(m["hour"])
    if month is None or not 1 <= hour12 <= 12:
        return None
    hour = hour12 % 12 + (12 if m["ampm"].lower() == "p" else 0)
    minute = int(m["minute"] or 0)

    tz = None
    if m["tz"]:
        try:
            tz = ZoneInfo(m["tz"].strip())
        except (ZoneInfoNotFoundError, ValueError, OSError):
            tz = None  # 不正な名前はローカルタイム扱い

    if taken_at.tzinfo is None:
        taken_at = taken_at.replace(tzinfo=timezone.utc)
    lo, hi = taken_at - timedelta(days=1), taken_at + timedelta(days=8)

    # 表示地域での「今年」が UTC の年とずれることがあるので、前後1年も候補にする
    for year in range(taken_at.year - 1, taken_at.year + 2):
        try:
            naive = datetime(year, month, int(m["day"]), hour, minute)
        except ValueError:
            continue  # 存在しない日付（うるう年でない年の 2/29 など）
        local = naive.replace(tzinfo=tz) if tz else naive.astimezone()
        if lo <= local <= hi:
            return local.astimezone(timezone.utc)
    return None


# --- kind の決定 ----------------------------------------------------------


def _kind_of(heading: str, scope: str | None) -> str:
    if heading.lower().startswith("current session"):
        return "session"
    name = (scope or "").strip().lower()
    if name in ("", "all models"):
        return "weekly_all"
    return f"weekly_model:{name}"


# --- 本体 -----------------------------------------------------------------


def parse_usage_text(text: str, taken_at: datetime) -> tuple[Status, list[Limit], str | None]:
    """`/usage` のテキストを (status, limits, message) にする。判定順は PLAN §4.3。"""
    text = text.lstrip("﻿")  # 先頭の BOM
    limits: list[Limit] = []

    for line in text.splitlines():
        if _CONTRIBUTING.search(line):
            break  # ここから先は構造化しない
        m = _LIMIT_LINE.match(line.strip())
        if not m:
            continue
        resets = _RESETS.search(m["rest"])
        limits.append(
            Limit(
                kind=_kind_of(m["heading"], m["scope"]),
                label=re.sub(r"\s+", " ", m["heading"]).strip(),
                percent=float(m["percent"]),
                resets_at=_resolve_resets_at(resets, taken_at) if resets else None,
            )
        )

    if limits:
        return Status.OK, limits, None
    if _COST_VIEW.search(text):
        return Status.LOGGED_OUT, [], MSG_LOGGED_OUT
    return Status.PARSE_ERROR, [], MSG_PARSE_ERROR


class UsageTextParser:
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

        # プラン・orgId は auth status にあれば付ける（ログイン後の別アカウント検知に使う）
        extras: dict = {}
        auth = raw.meta.get("auth")
        if isinstance(auth, dict):
            if auth.get("subscriptionType"):
                extras["plan"] = auth["subscriptionType"]
            if auth.get("orgId"):
                extras["org_id"] = auth["orgId"]

        if raw.timed_out:
            return reading(Status.TIMEOUT, "取得がタイムアウトしました", extras=extras)
        if raw.error:
            return reading(Status.ERROR, raw.error, extras=extras)
        if isinstance(auth, dict) and auth.get("loggedIn") is False:
            return reading(Status.LOGGED_OUT, MSG_LOGGED_OUT, extras=extras)  # テキストは見ない

        status, limits, message = parse_usage_text(raw.text, taken_at)
        return reading(status, message, limits, extras)
