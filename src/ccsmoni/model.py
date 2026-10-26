"""共通データ形式。

何を: 取得（Probe）→ 保存（Store）→ 分析（Insights）→ 表示（Web）の間で受け渡す型を定める。
なぜ: 取得方法を差し替えても下流が変わらないように、「最終的にこの形にそろえる」という約束を1か所に置く。
方針: 不変の dataclass。時刻はすべて timezone-aware の UTC。JSON へは to_dict() で変換する。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- 利用枠（window）の識別の規則（PLAN §4.2）
# 保存（store）と分析（insights）の両方が使うので、ここに1か所だけ置く。

# 同じ枠とみなす resets_at の許容幅。表示の丸めで 4:20am ↔ 4:19am と揺れるのを吸収する。
WINDOW_TOLERANCE_SEC = 15 * 60
# resets_at が同じでも、直前の値からこれだけ（ポイント）以上下がったら、新しい枠とみなす。
# リセット直後に同じ時刻の表示が続く場合や、丸めの揺れで resets_at が許容幅に入ってしまう場合でも、リセットを取りこぼさないため。
WINDOW_DROP_POINTS = 10.0


class Status(StrEnum):
    """1回の取得結果の状態。"""

    OK = "ok"
    LOGGED_OUT = "logged_out"  # ログインが切れている（auth status で確認、またはコスト表示）
    ERROR = "error"  # 起動失敗・想定外の終了など
    TIMEOUT = "timeout"
    PARSE_ERROR = "parse_error"  # 出力は得られたが読めなかった（形式が変わった可能性）


@dataclass(frozen=True)
class Account:
    """監視対象のアカウント（設定から作られる）。Probe が必要とする最小限の情報だけを持つ。"""

    id: str  # 履歴のキー。変更しない
    label: str
    config_dir: Path  # CLAUDE_CONFIG_DIR に渡す（展開済みの絶対パス）
    launch_command: str | None = None  # 案内・コピー用（例: "claude-xxx"）


@dataclass(frozen=True)
class RawResult:
    """Source が取ってきた生の結果。Parser の入力であり、そのまま DB に保存される（後で reparse するため）。"""

    source: str  # Source の kind（例: "cli-usage"）
    started_at: datetime
    duration_ms: int
    text: str  # パース対象の本文（/usage なら JSON の result）
    exit_code: int | None = None  # None = タイムアウト・起動失敗
    timed_out: bool = False
    error: str | None = None  # 起動失敗などのメッセージ
    meta: dict[str, Any] = field(default_factory=dict)  # CLI バージョン、auth status の結果など


@dataclass(frozen=True)
class Limit:
    """1つの利用枠の現在値。"""

    kind: str  # "session" | "weekly_all" | "weekly_model:<name>"
    label: str  # 表示用（例: "Current week (all models)"）
    percent: float
    resets_at: datetime | None = None  # UTC。表示されない場合（枠が始まっていない）は None


@dataclass(frozen=True)
class Reading:
    """1アカウント・1回分の取得結果を正規化したもの。下流はこれだけを見る。"""

    account_id: str
    taken_at: datetime  # UTC
    probe: str
    status: Status
    limits: tuple[Limit, ...] = ()
    message: str | None = None  # 利用者向けの説明（ログイン切れの直し方、エラー内容など）
    extras: dict[str, Any] = field(default_factory=dict)  # プラン・orgId など、枠以外の付随情報

    def limit(self, kind: str) -> Limit | None:
        return next((lim for lim in self.limits if lim.kind == kind), None)

    def to_dict(self) -> dict[str, Any]:
        def conv(v: Any) -> Any:
            if isinstance(v, datetime):
                return v.isoformat()
            if isinstance(v, dict):
                return {k: conv(x) for k, x in v.items()}
            if isinstance(v, (list, tuple)):
                return [conv(x) for x in v]
            return v

        return conv(asdict(self))
