"""定期取得のスケジューラ。

何を: 有効なアカウントごとに「次に取得する時刻」を持ち、取得間隔（アカウントごと）ごとに Probe.run → Store.save を行う。
      「今すぐ更新」と、設定の変更（アカウントの増減・間隔の変更）の反映も受け持つ。
なぜ: 常駐プロセス1つの中で、アカウントごとに違う間隔で取りたい（PLAN D4）。取得は数秒かかるブロッキング処理なので、
      イベントループを止めないように別スレッドで動かす。
方針:
  - asyncio の1本のループ。取得は asyncio.to_thread。同時実行数は collector.concurrency（_Limiter）。
    上限は実行中でも変えられる（Semaphore を作り直すと、新旧の Semaphore で合わせて上限を超えてしまうため）。
  - 取得中に「取り直し」が求められたら（取得先の変更・ログインの完了など）、もう一度の印を付け、終わったらすぐ取り直す。
    取得中の結果は古い前提のものなので、その後の予定（間隔）で上書きしてしまわないように。
  - 時刻は壁時計（clock、既定 time.time）で判断する。待機は最大 MAX_SLEEP 秒ずつにして、そのたびに予定と比べ直す。
    PC がスリープから復帰して予定を大きく過ぎていても、その時点で1回取得するだけ（たまった分を何回も実行しない）。
    次の予定は「取得を始めた時刻 + 間隔」。それも過ぎていれば「今 + 間隔」。
  - 1回の取得で起きた例外はログに出し、status=error として保存する。ループは止めない。
  - Probe と Store は注入する（テストでは偽物に差し替える）。Probe は設定（claude / codex のパス・タイムアウト）から作り直す。
    Probe は1つだけで、provider（claude / codex）の違いは Probe の中で振り分ける（probes/routing.py）。
  - ログには id・状態・使用率・所要時間だけを出す（raw テキストやメールアドレスは出さない）。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from ccsmoni.config import AppConfig
from ccsmoni.model import Account, Provider, RawResult, Reading, Status
from ccsmoni.probes.base import Probe
from ccsmoni.probes.routing import RoutingParser, RoutingSource

log = logging.getLogger("ccsmoni.scheduler")

# 1回の待機の上限（秒）。スリープ復帰や時計の変更に、この時間以内に気づける
MAX_SLEEP = 15.0


class _Limiter:
    """上限を後から変えられるセマフォ（待ちは先着順）。

    上限を下げても、実行中のものはそのまま終わらせる（中断しない）。新しく始める分は、実行中の数が新しい上限を
    下回るまで待つ。1つのカウンタで数えるので、変更の前後で上限を超えて新しく始めることはない。
    set_limit は同期で呼べる（設定の反映は同期の update_config から行うため）。
    """

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def active(self) -> int:
        return self._active

    def set_limit(self, limit: int) -> None:
        self._limit = limit
        self._wake()  # 上限が上がったなら、待っているものを始めさせる

    def _wake(self) -> None:
        while self._waiters and self._active < self._limit:
            fut = self._waiters.popleft()
            if not fut.done():
                self._active += 1  # 起こす側で枠を確保してから渡す（起きるまでの間に横取りされないように）
                fut.set_result(None)

    async def __aenter__(self) -> None:
        if self._active < self._limit and not self._waiters:
            self._active += 1
            return
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.append(fut)
        try:
            await fut
        except asyncio.CancelledError:
            if fut.done() and not fut.cancelled():
                self._active -= 1  # 枠をもらった直後に取り消された。枠を返す
                self._wake()
            else:
                try:
                    self._waiters.remove(fut)
                except ValueError:
                    pass
            raise

    async def __aexit__(self, *exc: object) -> None:
        self._active -= 1
        self._wake()


class StoreLike(Protocol):
    def save(self, raw: RawResult, reading: Reading) -> int: ...


ProbeFactory = Callable[[AppConfig], Probe]


def default_sources(cfg: AppConfig) -> RoutingSource:
    """設定から本番用の Source（provider ごとに振り分ける）を作る。"""
    from ccsmoni.probes.cli_usage import CliUsageSource
    from ccsmoni.probes.codex_app_server import CodexAppServerSource

    c = cfg.collector
    return RoutingSource({
        Provider.CLAUDE: CliUsageSource(c.claude_path, c.timeout_seconds),
        Provider.CODEX: CodexAppServerSource(c.codex_path, c.timeout_seconds),
    })


def default_probe_factory(cfg: AppConfig) -> Probe:
    """設定から本番用の Probe（claude CLI の /usage・codex app-server と、それぞれのパーサー）を作る。"""
    return Probe(name="cli", source=default_sources(cfg), parser=RoutingParser())


def summarize(reading: Reading, duration_ms: int | None = None) -> str:
    """ログ用の1行要約。id・状態・使用率だけ（機密に配慮して message や raw は出さない）。"""
    parts = [reading.account_id, str(reading.status)]
    for lim in reading.limits:
        if lim.kind in ("session", "weekly_all"):
            parts.append(f"{'5h' if lim.kind == 'session' else 'week'}={lim.percent:g}%")
    if duration_ms is not None:
        parts.append(f"({duration_ms / 1000:.1f}s)")
    return " ".join(parts)


class Scheduler:
    def __init__(
        self,
        store: StoreLike,
        config: AppConfig,
        probe_factory: ProbeFactory = default_probe_factory,
        clock: Callable[[], float] = time.time,
        max_sleep: float = MAX_SLEEP,
    ) -> None:
        self.store = store
        self.probe_factory = probe_factory
        self.clock = clock
        self.max_sleep = max_sleep
        self.last_run_at: float | None = None  # 最後にどれかのアカウントを取得し終えた時刻
        self._cfg = config
        self._probe = probe_factory(config)
        self._limiter = _Limiter(config.collector.concurrency)
        self._accounts: dict[str, Account] = {}  # 有効なアカウント（設定の並び順）
        self._next: dict[str, float] = {}  # id → 次に取得する予定の時刻
        self._started: dict[str, float] = {}  # id → 最後に取得を始めた時刻（間隔の変更の反映に使う）
        self._tasks: dict[str, asyncio.Task] = {}  # 取得中（同時実行数の空き待ちを含む）
        self._again: set[str] = set()  # 取得中に取り直しを求められた id（終わったらすぐもう一度取得する）
        self._wake: asyncio.Event | None = None
        self._stopping = False
        self._apply_accounts(config, initial=True)

    # ------------------------------------------------------------ 外から見る状態

    @property
    def busy(self) -> list[str]:
        """取得中（順番待ちを含む）のアカウント id。設定の並び順。"""
        order = list(self._accounts)
        return sorted(self._tasks, key=lambda a: order.index(a) if a in order else len(order))

    def next_run_at(self, account_id: str | None = None) -> float | None:
        """そのアカウントの次の予定時刻（取得中・無効なら None）。省略すると、取得中でないアカウントのうち最も早いもの。"""
        if account_id is not None:
            if account_id not in self._accounts or account_id in self._tasks:
                return None
            return self._next.get(account_id)
        pending = [t for a, t in self._next.items() if a in self._accounts and a not in self._tasks]
        return min(pending) if pending else None

    @property
    def config(self) -> AppConfig:
        return self._cfg

    # ------------------------------------------------------------ 設定の反映

    def _apply_accounts(self, cfg: AppConfig, initial: bool = False) -> None:
        now = self.clock()
        new = {a.id: a for a in cfg.active_accounts()}
        for aid in list(self._next):
            if aid not in new:
                self._next.pop(aid, None)  # 取得中のものはそのまま終わらせる（結果は保存してよい）
                self._again.discard(aid)
        for aid, acc in new.items():
            old = self._accounts.get(aid)
            interval = cfg.interval_for(aid) * 60
            if old is None or initial:
                self._next[aid] = now  # 追加されたアカウント・起動直後は、すぐに取得する
            elif (old.config_dir, old.provider) != (acc.config_dir, acc.provider):
                self._next[aid] = now  # 取得先が変わったので取り直す
                if aid in self._tasks:
                    self._again.add(aid)  # 取得中の結果は古い取得先のもの。終わったらすぐ取り直す
            elif aid in self._started:
                # 間隔の変更: 最後に始めた時刻から数え直す（過ぎていればすぐ）
                self._next[aid] = self._started[aid] + interval
            self._next.setdefault(aid, now)
        self._accounts = new

    def update_config(self, cfg: AppConfig) -> None:
        """設定の変更を反映する（ConfigService.poll や UI からの保存のあとに呼ぶ）。"""
        old = self._cfg
        self._cfg = cfg

        def probe_key(c: AppConfig) -> tuple:
            return (c.collector.claude_path, c.collector.codex_path, c.collector.timeout_seconds)

        if probe_key(old) != probe_key(cfg):
            self._probe = self.probe_factory(cfg)
        if old.collector.concurrency != cfg.collector.concurrency:
            # 実行中のものはそのまま終わる。新しく始める分から新しい上限で数える（同じカウンタなので超えない）
            self._limiter.set_limit(cfg.collector.concurrency)
        self._apply_accounts(cfg)
        log.info("設定を反映しました（有効なアカウント %d 件）", len(self._accounts))
        self._poke()

    # ------------------------------------------------------------ 今すぐ更新

    def refresh(self, account_id: str | None = None, again: bool = False) -> list[str]:
        """その場で取得を始める。すでに取得中のアカウントは二重に起動しない。

        again=True なら、取得中のアカウントには「もう一度」の印を付け、終わったらすぐ取り直す
        （設定の変更・ログインの完了など、取得中の結果が古い前提になった場合）。
        戻り値は新しく始めた id。存在しない（無効な）id を指定したら KeyError。
        イベントループの中から呼ぶこと。
        """
        if account_id is not None and account_id not in self._accounts:
            raise KeyError(account_id)
        targets = [account_id] if account_id is not None else list(self._accounts)
        started = [aid for aid in targets if aid not in self._tasks]
        for aid in started:
            self._spawn(aid)
        if again:
            self._again.update(aid for aid in targets if aid not in started)
        return started

    def refresh_soon(self, account_id: str) -> None:
        """取り直しを依頼する（ログインの完了時に LoginService から呼ぶ）。取得中なら終わったあとにもう一度。

        無効な id（ログインの間に無効化・削除された）は何もしない。イベントループの中から呼ぶこと。
        """
        try:
            self.refresh(account_id, again=True)
        except KeyError:
            pass

    # ------------------------------------------------------------ ループ

    def _poke(self) -> None:
        if self._wake is not None:
            self._wake.set()

    def _spawn(self, account_id: str) -> None:
        self._tasks[account_id] = asyncio.get_running_loop().create_task(
            self._run_one(account_id), name=f"collect-{account_id}"
        )

    async def run(self) -> None:
        """予定の来たアカウントを取得し続ける。stop() で止まる。"""
        self._wake = asyncio.Event()
        log.info("取得を開始します（有効なアカウント %d 件）", len(self._accounts))
        while not self._stopping:
            now = self.clock()
            # 設定の並び順に起動するので、起動直後は上から順に concurrency 件ずつ取得される
            for aid in list(self._accounts):
                if aid not in self._tasks and self._next.get(aid, now) <= now:
                    self._spawn(aid)
            pending = self.next_run_at()
            wait = self.max_sleep if pending is None else min(self.max_sleep, max(0.0, pending - now))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=max(wait, 0.05))
            except TimeoutError:
                pass

    async def stop(self) -> None:
        self._stopping = True
        self._poke()
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_one(self, account_id: str) -> None:
        try:
            async with self._limiter:
                account = self._accounts.get(account_id)
                if account is None:
                    return  # 順番待ちの間に無効化・削除された
                started = self.clock()
                self._started[account_id] = started
                probe = self._probe
                t0 = time.monotonic()
                try:
                    raw, reading = await asyncio.to_thread(probe.run, account)
                except Exception as e:  # Probe は例外を投げない約束だが、念のためループを守る
                    log.error("%s: 取得中に例外が発生しました（%s）", account_id, type(e).__name__)
                    raw, reading = _error_result(probe.name, account_id, started, t0, e)
                try:
                    await asyncio.to_thread(self.store.save, raw, reading)
                except Exception as e:
                    log.error("%s: 保存に失敗しました（%s）", account_id, type(e).__name__)
                log.info("取得: %s", summarize(reading, raw.duration_ms))
                now = self.clock()
                self.last_run_at = now
                if account_id in self._accounts:
                    nxt = started + self._cfg.interval_for(account_id) * 60
                    self._next[account_id] = nxt if nxt > now else now + self._cfg.interval_for(account_id) * 60
        finally:
            self._tasks.pop(account_id, None)
            if account_id in self._again:
                self._again.discard(account_id)
                if account_id in self._accounts and not self._stopping:
                    self._next[account_id] = self.clock()  # すぐ取り直す（run のループが拾う）
            self._poke()


def _error_result(
    probe_name: str, account_id: str, started: float, t0: float, e: Exception
) -> tuple[RawResult, Reading]:
    at = datetime.fromtimestamp(started, UTC)
    msg = f"{type(e).__name__}: {e}"
    raw = RawResult(
        source=probe_name,
        started_at=at,
        duration_ms=int((time.monotonic() - t0) * 1000),
        text="",
        error=msg,
    )
    reading = Reading(account_id=account_id, taken_at=at, probe=probe_name, status=Status.ERROR, message=msg)
    return raw, reading
