"""デモ用の架空データ。

何を: 架空の 4 アカウント（acct-a〜acct-d）の設定と、30 日分の合成履歴を入れた DB を作る（`ccsmoni demo --home <dir>`）。
      `ccsmoni serve --demo` では、実際の claude を呼ばずに同じモデルの続きを返す偽の Source を使う。
なぜ: 実アカウントを使わずに UI を確認・撮影できるようにするため（スクリーンショットに機密が写らない）。
方針:
  - 利用のモデルは決定的（アカウントごとの乱数の種で、10 分刻みに状態を進める）。
    履歴の生成と serve 中の取得は同じモデルを使うので、DB の続きとして自然につながる。
  - 生成するのは /usage と同じ形式のテキストと auth status 相当の meta。保存は本物のパーサー → Store を通す
    （raw も本物と同じ形なので reparse もできる）。
  - 見せたいもの: 5h 枠のノコギリ形、週間枠の増加とリセット、PC のスリープによる抜け、ログイン切れの期間、
    プランの違い、「使わないと損」「上限に達しそう」のヒント、モデル別の週間枠。
  - config_dir は存在しない架空のパス。未登録の検出（discover_roots）は空にして、実環境を走査しない。
"""

from __future__ import annotations

import json
import random
import threading
import time
import zlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from ccsmoni.model import Account, RawResult

DEMO_MARKER = "demo.json"  # CCSMONI_HOME にこれがあるときだけ serve --demo を許す（実データに混ぜないため）
STEP = 600  # 10 分
TZ_NAME = "Asia/Tokyo"
TZ = ZoneInfo(TZ_NAME)
DAY = 86400
HOUR = 3600


@dataclass(frozen=True)
class DemoSpec:
    id: str
    label: str
    plan: str
    color: str
    profile: str  # 利用の時間帯の傾向（_p_start を参照）
    intensity: float  # 使っている 10 分あたりの 5h 枠の増え方（%）
    weekly_ratio: float  # 5h 枠 1% あたりの週間枠の増え方（%）
    weekly_reset_in_h: float  # 作成時刻から見た次の週間リセットまでの時間
    model_week: str | None = None  # モデル別の週間枠を出すならそのモデル名
    logged_out: tuple[tuple[float, float | None], ...] = ()  # ログイン切れの期間（作成時刻からの時間。None = 続いている）
    busy_now: bool = False  # 作成時刻の直前は使っていることにする（画面が寂しくならないように）
    interval_minutes: int | None = None


SPECS: tuple[DemoSpec, ...] = (
    # 個人（Pro）: 夜型でよく使う。週間枠を使い切りそう → 「このペースだと…に上限」
    DemoSpec("acct-a", "個人", "pro", "#4f8cff", "night_owl", 5.5, 0.065, 3.4 * 24, busy_now=True),
    # 仕事（Max）: 平日の日中。モデル別の週間枠あり。取得間隔は 5 分
    DemoSpec("acct-b", "仕事", "max", "#f5a524", "work", 3.2, 0.10, 5.2 * 24, model_week="Sonnet",
             busy_now=True, interval_minutes=5),
    # 検証用（Max）: たまにしか使わない。リセットが近いのに余っている → 「使わないと損」。途中でログイン切れ
    DemoSpec("acct-c", "検証用", "max", "#17c964", "light", 2.5, 0.09, 20, logged_out=((-13 * 24, -10.5 * 24),)),
    # チーム（Team）: 平日の日中。いまログインが切れている
    DemoSpec("acct-d", "チーム", "team", "#9353d3", "work", 3.5, 0.075, 2.4 * 24, logged_out=((-38, None),)),
)


def _seed(*parts: Any) -> int:
    return zlib.crc32("/".join(map(str, parts)).encode())


def _spec_for(account_id: str) -> DemoSpec:
    for s in SPECS:
        if s.id == account_id:
            return s
    # 画面から足された・接続テストなど、知らない id は控えめな利用にする
    return DemoSpec(account_id, account_id, "pro", "#7c8aa5", "light", 2.0, 0.08, 4 * 24)


# ---------------------------------------------------------------- 時間帯ごとの利用の傾向


def _p_start(profile: str, t: float) -> float:
    """その 10 分に使い始める確率。"""
    d = datetime.fromtimestamp(t, TZ)
    h, weekend = d.hour, d.weekday() >= 5
    if profile == "work":
        if weekend:
            return 0.03 if 10 <= h < 22 else 0.0
        if 9 <= h < 12 or 13 <= h < 19:
            return 0.22
        if 20 <= h < 24:
            return 0.04
        return 0.0
    if profile == "night_owl":
        if 13 <= h < 18:
            return 0.10
        if h >= 20 or h < 2:
            return 0.25
        return 0.01 if 10 <= h < 13 else 0.0
    # light
    if 10 <= h < 23:
        return 0.025 if not weekend else 0.05
    return 0.0


def _pc_asleep(t: float, anchor: float) -> bool:
    """PC がスリープしていたか（全アカウント共通）。直近 1 日と、作成時刻より後は寝かせない。"""
    if t > anchor - DAY:
        return False
    if anchor - 17 * DAY + 18 * HOUR <= t < anchor - 15 * DAY + 10 * HOUR:
        return True  # 週末の外出で丸 1 日半止まっていた
    d = datetime.fromtimestamp(t, TZ)
    day = d.date().toordinal() - (1 if d.hour < 12 else 0)  # 夜をまたいで同じ「晩」とみなす
    rng = random.Random(_seed("sleep", day))
    if rng.random() >= 0.3:
        return False
    start = 1.0 + rng.random() * 1.5  # 1:00〜2:30 に寝て
    end = 7.5 + rng.random() * 1.5  # 7:30〜9:00 に起きる
    hh = d.hour + d.minute / 60
    return start <= hh < end


# ---------------------------------------------------------------- 状態を進めるモデル


@dataclass
class _State:
    t: float  # 最後に進めた刻みの時刻
    rng: random.Random
    week_reset: float
    session_pct: float = 0.0
    session_reset: float | None = None
    week_pct: float = 0.0
    model_pct: float = 0.0
    active: bool = False


@dataclass
class DemoModel:
    """1 アカウント分の利用モデル。advance(t) で t まで 10 分刻みに進める（決定的）。"""

    spec: DemoSpec
    anchor: float  # demo を作った時刻
    start: float  # 履歴の最初の時刻
    login_at: float | None = None  # serve --demo で［ログイン］したら、その時刻以降はログイン済み
    _s: _State | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        week = 7 * DAY
        first = self.anchor + self.spec.weekly_reset_in_h * HOUR
        first = first - ((first - self.start) // week + 1) * week
        while first <= self.start:
            first += week
        self._s = _State(t=self.start - STEP, rng=random.Random(_seed("usage", self.spec.id)), week_reset=first)

    def logged_in(self, t: float) -> bool:
        if self.login_at is not None and t >= self.login_at:
            return True
        for a, b in self.spec.logged_out:
            if self.anchor + a * HOUR <= t and (b is None or t < self.anchor + b * HOUR):
                return False
        return True

    def _step(self, t: float) -> None:
        s = self._s
        assert s is not None
        rng = s.rng
        r1, r2 = rng.random(), rng.random()  # 状態にかかわらず毎回同じ数だけ引く（決定性のため）
        while t >= s.week_reset:
            s.week_pct = s.model_pct = 0.0
            s.week_reset += 7 * DAY
        if s.session_reset is not None and t >= s.session_reset:
            s.session_pct, s.session_reset = 0.0, None
        can_use = self.logged_in(t) and not _pc_asleep(t, self.anchor)
        p = _p_start(self.spec.profile, t)
        if self.spec.busy_now and self.anchor - 1.5 * HOUR <= t <= self.anchor:
            p = 0.9
        s.active = can_use and (r1 < (0.85 if s.active else p))
        if not s.active:
            return
        if s.session_reset is None:
            s.session_reset = t + 5 * HOUR - (int(r2 * 10) * 60)  # 表示が 3:09am のように半端になるよう少しずらす
        if s.session_pct >= 100 or s.week_pct >= 100:
            return  # 上限に達していて使えない
        inc = self.spec.intensity * (0.4 + 1.2 * r2)
        inc = min(inc, 100 - s.session_pct)
        s.session_pct += inc
        s.week_pct = min(100.0, s.week_pct + inc * self.spec.weekly_ratio)
        if self.spec.model_week:
            s.model_pct = min(100.0, s.model_pct + inc * self.spec.weekly_ratio * 0.45)

    def advance(self, t: float) -> _State:
        s = self._s
        assert s is not None
        while s.t + STEP <= t:
            s.t += STEP
            self._step(s.t)
        return s


# ---------------------------------------------------------------- /usage 形式のテキスト


def _fmt_reset(t: float) -> str:
    d = datetime.fromtimestamp(t, TZ)
    h12 = d.hour % 12 or 12
    return f"{d:%b} {d.day}, {h12}:{d.minute:02d}{'am' if d.hour < 12 else 'pm'} ({TZ_NAME})"


def render_usage(s: _State, spec: DemoSpec) -> str:
    lines = ["You are currently using your subscription to power your Claude Code usage", ""]
    if s.session_reset is not None:
        lines.append(f"Current session: {round(s.session_pct)}% used · resets {_fmt_reset(s.session_reset)}")
    else:
        lines.append("Current session: 0% used")
    lines.append(f"Current week (all models): {round(s.week_pct)}% used · resets {_fmt_reset(s.week_reset)}")
    if spec.model_week:
        lines.append(f"Current week ({spec.model_week}): {round(s.model_pct)}% used · resets {_fmt_reset(s.week_reset)}")
    lines += ["", "What's contributing to your limits usage?", "Approximate · demo data"]
    return "\n".join(lines) + "\n"


def _raw(model: DemoModel, t: float, rng: random.Random) -> RawResult:
    """時刻 t の取得結果（本物の CliUsageSource と同じ形）。"""
    spec = model.spec
    started = datetime.fromtimestamp(t, UTC)
    meta: dict[str, Any] = {"cli_version": "2.0.0 (Claude Code, demo)"}
    if not model.logged_in(t):
        meta["auth"] = {"loggedIn": False, "authMethod": "none"}
        return RawResult("cli-usage", started, int(250 + rng.random() * 150), "", exit_code=1, meta=meta)
    if rng.random() < 0.003:
        return RawResult("cli-usage", started, 30000, "", exit_code=None, timed_out=True, meta=meta)
    meta["auth"] = {
        "loggedIn": True,
        "authMethod": "claude.ai",
        "subscriptionType": spec.plan,
        "orgId": f"00000000-0000-4000-8000-demo{_seed(spec.id) % 100000000:08d}",
    }
    meta.update({"total_cost_usd": 0, "num_turns": 0})
    s = model.advance(t)
    return RawResult("cli-usage", started, int(2000 + rng.random() * 2000), render_usage(s, spec), exit_code=0, meta=meta)


# ---------------------------------------------------------------- serve --demo 用の偽 Source


class DemoSource:
    """claude を呼ばずに、デモのモデルの「いま」を返す Source。"""

    kind = "cli-usage"

    def __init__(self, home: Path, clock=time.time, delay: float = 1.5) -> None:
        info = json.loads((Path(home) / DEMO_MARKER).read_text(encoding="utf-8"))
        self.anchor = float(info["anchor"])
        self.start = float(info["start"])
        self.clock = clock
        self.delay = delay  # 本物らしく少し待つ（UI のスピナーを確認できるように）
        self._models: dict[str, DemoModel] = {}
        self._lock = threading.Lock()
        self._rng = random.Random()

    def _model(self, account_id: str) -> DemoModel:
        with self._lock:
            m = self._models.get(account_id)
            if m is None:
                m = DemoModel(_spec_for(account_id), self.anchor, self.start)
                self._models[account_id] = m
            return m

    def fetch(self, account: Account) -> RawResult:
        time.sleep(self.delay)
        m = self._model(account.id)
        with self._lock:
            return _raw(m, self.clock(), self._rng)

    def auth_status(self, account: Account) -> dict | None:
        m = self._model(account.id)
        ok = m.logged_in(self.clock())
        spec = m.spec
        return {"loggedIn": ok, "orgId": f"00000000-0000-4000-8000-demo{_seed(spec.id) % 100000000:08d}" if ok else None}

    def mark_login_soon(self, account_id: str, seconds: float = 6.0) -> None:
        """デモの［ログイン］: 数秒後にログインが完了したことにする。"""
        self._model(account_id).login_at = self.clock() + seconds


class DemoConsole:
    """デモの［ログイン］で Popen の代わりに使う。ウィンドウは開かない。"""

    def __init__(self, source: DemoSource, account_id: str) -> None:
        source.mark_login_soon(account_id)

    def poll(self) -> None:
        return None


DEMO_CANDIDATES = [{"suggested_id": "acct-e", "config_dir": "~/claude-demo/acct-e"}]


# ---------------------------------------------------------------- ccsmoni demo --home


def create_demo_home(home: Path, days: float = 30, force: bool = False, now: float | None = None) -> dict[str, int]:
    """home に架空の設定と合成履歴の DB を作る。戻り値は件数の要約。"""
    from ccsmoni.config import AccountConfig, ConfigService
    from ccsmoni.parser_usage import UsageTextParser
    from ccsmoni.store import Store

    home = Path(home)
    cfg_path, db_file, marker = home / "config.toml", home / "ccsmoni.db", home / DEMO_MARKER
    if (cfg_path.exists() or db_file.exists()) and not marker.exists():
        raise FileExistsError(f"{home} にはデモ以外の設定・DB があります。別のディレクトリを指定してください")
    if (cfg_path.exists() or db_file.exists()) and not force:
        raise FileExistsError(f"{home} にはすでにデモがあります。作り直すなら --force を付けてください")
    home.mkdir(parents=True, exist_ok=True)
    for p in (cfg_path, db_file, home / "ccsmoni.db-wal", home / "ccsmoni.db-shm"):
        p.unlink(missing_ok=True)

    anchor = float(int(now if now is not None else time.time()) // 60 * 60)
    start = anchor - days * DAY
    marker.write_text(json.dumps({"anchor": anchor, "start": start, "days": days}), encoding="utf-8")

    # 設定: 初期生成（検出なし）→ アカウントを足して保存（ConfigService の検証を通す）
    svc = ConfigService(cfg_path, discover_roots=[])
    cfg, h = svc.load()
    cfg.collector.discover_roots = []  # 実環境を走査しない
    cfg.accounts = [
        AccountConfig(
            id=s.id,
            label=s.label,
            config_dir=f"~/claude-demo/{s.id}",
            launch_command=f"claude-{s.id}",
            color=s.color,
            interval_minutes=s.interval_minutes,
        )
        for s in SPECS
    ]
    svc.save(cfg, h)

    store = Store(db_file)
    store._conn.execute("PRAGMA synchronous=OFF")  # 大量の挿入を速くする（デモの生成時だけ）
    parser = UsageTextParser()
    counts: dict[str, int] = {}
    try:
        for spec in SPECS:
            model = DemoModel(spec, anchor, start)
            rng = random.Random(_seed("snap", spec.id))
            step = (spec.interval_minutes or 10) * 60
            n = 0
            t = start
            while t <= anchor:
                if not _pc_asleep(t, anchor):
                    at = t + rng.random() * 20  # 取得の時刻は少し揺れる
                    raw = _raw(model, at, rng)
                    store.save(raw, parser.parse(raw, spec.id))
                    n += 1
                t += step
            counts[spec.id] = n
    finally:
        store.close()
    return counts
