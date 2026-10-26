"""分析（Insights）。

何を: 保存済みの値から、画面に出す「ペース」「枯渇の予測」「気の利くヒント」「推移グラフの線」「週ごとのピーク」を作る。
なぜ: 生の使用率だけでは「このままで足りるのか」「使わないと損なのか」がわからない（PLAN §6.1、U1・U2）。
方針: すべて純粋関数。時計は引数 now（epoch 秒）で受け取り、DB や設定には触れない（呼び出し側が渡す）。
      入出力は docs/API.md の形（時刻は epoch 秒、limit は {kind, label, percent, resets_at} の dict）。
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timezone, tzinfo
from typing import Any

from ccsmoni.model import WINDOW_TOLERANCE_SEC, Limit

# ---------------------------------------------------------------- 枠の長さ・しきい値

SESSION_SEC = 5 * 3600
WEEK_SEC = 7 * 24 * 3600

# 枯渇予測の速度の取り方:
#   基本は「枠の開始（resets_at - 枠の長さ）から今までの平均速度」。
#   直近の履歴が RECENT_LOOKBACK 分そろっているときだけ、その区間の増加速度（最小二乗の傾き）を使う。
#   以前は 20 分〜3 時間ぶんの点で傾きを取っていたため、使い始めの 1 時間の勢いをそのまま 5 日分延ばして
#   「今日の夜に週間上限」のような早すぎる予測が出た。週間枠は 1 日単位の使い方（寝ている時間を含む）で、
#   5h 枠は 1 時間単位で見る。
# RECENT_SLACK は取得の時刻の揺れ（10 分おき＋数十秒）を吸収するための余裕。
RECENT_LOOKBACK = {"session": 3600, "weekly": 24 * 3600}
RECENT_SLACK = {"session": 10 * 60, "weekly": 30 * 60}
MIN_POINTS = 3
# 予測を出す最低条件: 枠が始まってからこれだけたっていること。
# 始まった直後は、少し使っただけで平均速度が極端に大きくなり、当てにならないため。
MIN_ELAPSED = {"session": 30 * 60, "weekly": 12 * 3600}

# 「使わないと損」: 週間リセットまで 36 時間以内、かつ残量が 30% 以上
LOSE_WITHIN_HOURS = 36
LOSE_MIN_REMAINING = 30

MAX_HINTS = 2

# 同じ枠とみなす resets_at の許容幅は model.WINDOW_TOLERANCE_SEC（store と共通）

# 推移グラフで「取得の抜け」とみなす間隔（取得間隔の何倍か）
GAP_FACTOR = 3

_WEEKDAYS_JA = "月火水木金土日"


def _family(kind: str) -> str | None:
    """枠の種類を session / weekly にまとめる。知らない種類は None。"""
    if kind == "session":
        return "session"
    if kind.startswith("weekly"):
        return "weekly"
    return None


def window_length(kind: str) -> int | None:
    """枠の長さ（秒）。5h 枠 = 5時間、週間枠 = 7日。"""
    return {"session": SESSION_SEC, "weekly": WEEK_SEC}.get(_family(kind) or "")


def limit_to_api(lim: Limit) -> dict[str, Any]:
    """model.Limit を API の形（epoch 秒）にする。"""
    return {
        "kind": lim.kind,
        "label": lim.label,
        "percent": lim.percent,
        "resets_at": int(round(lim.resets_at.timestamp())) if lim.resets_at else None,
    }


# ---------------------------------------------------------------- ペース・枯渇予測


def window_points(
    rows: Iterable[Mapping[str, Any]], kind: str, resets_at: float, window_id: int | None = None
) -> list[tuple[float, float]]:
    """store.history の行から、同じ枠の (t, percent) を取り出す。

    window_id が分かっていればそれで選ぶ（resets_at が同じでも、使用率が大きく下がって別の枠になった場合を分けるため）。
    分からなければ、kind が同じで resets_at が許容幅内のものを選ぶ。
    """
    if window_id is not None:
        return [(r["t"], r["percent"]) for r in rows if r["kind"] == kind and r.get("window_id") == window_id]
    return [
        (r["t"], r["percent"])
        for r in rows
        if r["kind"] == kind
        and r.get("resets_at") is not None
        and abs(r["resets_at"] - resets_at) <= WINDOW_TOLERANCE_SEC
    ]


def _slope(points: Sequence[tuple[float, float]]) -> float:
    """最小二乗法の傾き（%/秒）。整数表示の丸めによるガタつきを、端点だけで見るより和らげる。"""
    n = len(points)
    mt = sum(t for t, _ in points) / n
    mp = sum(p for _, p in points) / n
    den = sum((t - mt) ** 2 for t, _ in points)
    if den == 0:
        return 0.0
    return sum((t - mt) * (p - mp) for t, p in points) / den


def _eta_full(
    kind: str, percent: float, resets_at: float, now: float, points: Sequence[tuple[float, float]]
) -> float | None:
    """このペースだと 100% に達する時刻。リセットまでに達しないなら None。

    基本は枠の開始からの平均速度。直近 RECENT_LOOKBACK 分の履歴がそろっているときだけ、その区間の増加速度を使う。
    枠が始まって MIN_ELAPSED たつまでは予測しない（すでに 100% のときを除く）。
    """
    length = window_length(kind)
    family = _family(kind)
    if length is None or family is None or resets_at <= now:
        return None
    if percent >= 100:
        return now  # すでに上限
    elapsed = now - (resets_at - length)
    if elapsed < MIN_ELAPSED[family]:
        return None

    lookback, slack = RECENT_LOOKBACK[family], RECENT_SLACK[family]
    recent = sorted((t, p) for t, p in points if now - lookback - slack <= t <= now)
    if len(recent) >= MIN_POINTS and recent[-1][0] - recent[0][0] >= lookback - slack:
        rate = _slope(recent)
        anchor_t, anchor_p = recent[-1][0], max(recent[-1][1], percent)
    else:
        rate = percent / elapsed
        anchor_t, anchor_p = now, percent
    if rate <= 0:
        return None
    eta = anchor_t + (100 - anchor_p) / rate
    eta = max(eta, now)
    return eta if eta < resets_at else None


def pace(limit: Mapping[str, Any], now: float, points: Sequence[tuple[float, float]] = ()) -> dict | None:
    """API.md の pace。resets_at が無い（枠が始まっていない）・枠の長さがわからないときは None。

    points は同じ枠の履歴 (t, percent)。window_points() で作る。
    """
    resets_at = limit.get("resets_at")
    length = window_length(limit["kind"])
    if resets_at is None or length is None:
        return None
    ratio = min(1.0, max(0.0, 1 - (resets_at - now) / length))
    eta = _eta_full(limit["kind"], float(limit["percent"]), resets_at, now, points)
    return {
        "elapsed_ratio": round(ratio, 4),
        "expected_percent": round(ratio * 100, 1),
        "eta_full": int(round(eta)) if eta is not None else None,
    }


# ---------------------------------------------------------------- ヒント


def format_when(t: float, tz: tzinfo | None = None) -> str:
    """「金 14:00」のようなローカルの曜日と時刻。tz を省略するとこの PC のタイムゾーン。"""
    d = datetime.fromtimestamp(t, timezone.utc)
    d = d.astimezone(tz) if tz is not None else d.astimezone()
    return f"{_WEEKDAYS_JA[d.weekday()]} {d:%H:%M}"


def _model_name(limit: Mapping[str, Any]) -> str:
    m = re.search(r"\(([^)]*)\)", limit.get("label") or "")
    return m.group(1) if m else limit["kind"].split(":", 1)[-1]


def _limit_name(limit: Mapping[str, Any]) -> str:
    """ヒント文中の枠の呼び名。"""
    kind = limit["kind"]
    if kind == "session":
        return "5時間枠"
    if kind == "weekly_all":
        return "週間"
    return f"週間（{_model_name(limit)}）"


def _fmt_percent(x: float) -> str:
    return f"{round(x, 1):g}"


def _fmt_duration(sec: float) -> str:
    if sec >= 3600:
        return f"{int(sec // 3600)} 時間"
    return f"{max(1, int(sec // 60))} 分"


def hints(
    account_state: Mapping[str, Any],
    now: float,
    tz: tzinfo | None = None,
    lose_within_hours: float = LOSE_WITHIN_HOURS,
    lose_min_remaining: float = LOSE_MIN_REMAINING,
    max_hints: int = MAX_HINTS,
) -> list[dict[str, str]]:
    """API.md の hints（重要な順に最大 max_hints 件）。

    account_state は /api/state の accounts[] の形（limits[].pace が計算済みであること）。
    重要度: 上限に達しそう（早く達するものから）> 使わないと損。
    """
    if account_state.get("status") != "ok":
        return []
    limits = list(account_state.get("limits") or [])

    will: list[tuple[float, dict[str, str]]] = []
    for lim in limits:
        eta = (lim.get("pace") or {}).get("eta_full")
        if eta is None:
            continue
        name = _limit_name(lim)
        upper = "週間上限" if lim["kind"] == "weekly_all" else f"{name}の上限"
        if lim["percent"] >= 100:
            when = format_when(lim["resets_at"], tz) if lim.get("resets_at") else None
            text = f"{upper}に達しています" + (f"（リセットは {when}）" if when else "")
        else:
            text = f"このペースだと {format_when(eta, tz)} に{upper}"
        will.append((eta, {"kind": "will_hit_limit", "text": text}))
    will.sort(key=lambda x: x[0])

    # 使わないと損: 全モデルの週間枠を優先し、1件だけ出す（モデル別の枠は同じ時刻にリセットされることが多く、重複になる）
    lose: list[dict[str, str]] = []
    weekly = sorted(
        (lim for lim in limits if _family(lim["kind"]) == "weekly"),
        key=lambda lim: lim["kind"] != "weekly_all",
    )
    for lim in weekly:
        if lim.get("resets_at") is None:
            continue
        left = lim["resets_at"] - now
        remaining = 100 - lim["percent"]
        if 0 < left <= lose_within_hours * 3600 and remaining >= lose_min_remaining:
            lead = "週間リセット" if lim["kind"] == "weekly_all" else f"{_limit_name(lim)}のリセット"
            lose.append({
                "kind": "use_it_or_lose_it",
                "text": f"{lead}まで {_fmt_duration(left)}・残り {_fmt_percent(remaining)}%。使わないと損です",
            })
            break

    return ([h for _, h in will] + lose)[:max_hints]


# ---------------------------------------------------------------- 推移グラフ


def history_series(
    rows: Sequence[Mapping[str, Any]],
    snapshots: Sequence[tuple[str, int, str]],
    since: int,
    until: int,
    intervals: Mapping[str, int],
    default_interval: int = 10,
    account_order: Sequence[str] = (),
) -> dict[str, Any]:
    """store.history の行と store.snapshot_times から、API.md の /api/history の本体を作る。

    - segments: 枠（window_id）ごとに線を分ける。リセットをまたいで線をつながないため。
      window_id が無い点（0%・枠が始まっていない）が続く部分は window_id=null の segment にする。
      さらに、同じ枠の中でも点の間隔が「取得間隔 × 3」を超えたら segment を分ける
      （PC のスリープ・ログイン切れの間に嘘の線を引かないため）。
    - resets: 範囲内に入る枠の切り替わり。枠の resets_at（最後に観測した値）が [since, until] に入るもの。
    - gaps: 同じアカウントの取得（状態を問わない）の間隔が interval の 3 倍を超えた区間。
    - errors: ok 以外の取得。
    intervals はアカウント id → 取得間隔（分）。無い id は default_interval。
    """
    def threshold(account_id: str) -> int:
        return GAP_FACTOR * 60 * intervals.get(account_id, default_interval)

    order = {a: i for i, a in enumerate(account_order)}

    # --- series / segments
    by_series: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for r in rows:
        by_series.setdefault((r["account_id"], r["kind"]), []).append(r)

    series: list[dict[str, Any]] = []
    resets: list[dict[str, Any]] = []
    for (account_id, kind), pts in by_series.items():
        pts = sorted(pts, key=lambda r: r["t"])
        gap = threshold(account_id)
        segments: list[dict[str, Any]] = []
        cur: dict[str, Any] | None = None
        last_t: int | None = None
        window_resets: dict[int, int] = {}  # window_id → 最後に観測した resets_at
        for r in pts:
            wid = r["window_id"]
            if wid is not None and r["resets_at"] is not None:
                window_resets[wid] = r["resets_at"]
            if cur is None or cur["window_id"] != wid or (last_t is not None and r["t"] - last_t > gap):
                cur = {"window_id": wid, "resets_at": r["resets_at"], "points": []}
                segments.append(cur)
            cur["points"].append([r["t"], r["percent"]])
            if r["resets_at"] is not None:
                cur["resets_at"] = r["resets_at"]
            last_t = r["t"]
        series.append({"account_id": account_id, "kind": kind, "segments": segments})
        for wid, ra in window_resets.items():
            if since <= ra <= until:
                resets.append({"account_id": account_id, "kind": kind, "t": ra})

    series.sort(key=lambda s: (order.get(s["account_id"], len(order)), s["account_id"], _kind_rank(s["kind"])))
    resets.sort(key=lambda x: (x["t"], x["account_id"], x["kind"]))

    # --- gaps / errors
    gaps: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    prev: dict[str, int] = {}
    for account_id, t, status in sorted(snapshots, key=lambda s: s[1]):
        if not since <= t <= until:
            continue
        p = prev.get(account_id)
        if p is not None and t - p > threshold(account_id):
            gaps.append({"account_id": account_id, "from": p, "to": t})
        prev[account_id] = t
        if status != "ok":
            errors.append({"account_id": account_id, "t": t, "status": status})

    return {"since": since, "until": until, "series": series, "resets": resets, "gaps": gaps, "errors": errors}


def _kind_rank(kind: str) -> tuple[int, str]:
    return ({"weekly_all": 0, "session": 1}.get(kind, 2), kind)


# ---------------------------------------------------------------- 週ごとのピーク


def window_peaks(
    windows: Sequence[Mapping[str, Any]], account_order: Sequence[str] = (), limit: int = 8
) -> list[dict[str, Any]]:
    """store.windows の行から、API.md の /api/windows の rows を作る（アカウントは設定順、枠は新しい順）。"""
    by_account: dict[str, list[Mapping[str, Any]]] = {}
    for w in windows:
        by_account.setdefault(w["account_id"], []).append(w)
    order = {a: i for i, a in enumerate(account_order)}
    rows = []
    for account_id in sorted(by_account, key=lambda a: (order.get(a, len(order)), a)):
        ws = sorted(by_account[account_id], key=lambda w: (w["first_seen"], w["id"]), reverse=True)[:limit]
        rows.append({
            "account_id": account_id,
            "windows": [
                {"resets_at": w["resets_at"], "peak_percent": w["peak_percent"], "first_seen": w["first_seen"]}
                for w in ws
            ],
        })
    return rows


def weekly_peaks(
    windows: Sequence[Mapping[str, Any]], current_resets_at: float | None, limit: int = 6
) -> list[dict[str, Any]]:
    """1アカウント分の store.windows（weekly_all）から、/api/state の weekly_peaks を作る（直近 limit 枠、古い順）。

    current は「今の limits の weekly_all と同じ枠」。resets_at が許容幅内の枠のうち最も新しい1つだけを true にする
    （current_resets_at が None = ok でない・枠が始まっていないときは、すべて false）。
    """
    ws = sorted(windows, key=lambda w: (w["first_seen"], w["id"]))
    cur_id = None
    if current_resets_at is not None:
        cur_id = next(
            (w["id"] for w in reversed(ws) if abs(w["resets_at"] - current_resets_at) <= WINDOW_TOLERANCE_SEC), None
        )
    return [
        {"resets_at": w["resets_at"], "peak_percent": w["peak_percent"], "current": w["id"] == cur_id}
        for w in ws[-limit:]
    ]
