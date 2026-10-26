"""Scheduler のテスト。Probe・Store・時計は偽物（claude は呼ばない）。"""

from __future__ import annotations

import asyncio
import threading
from datetime import UTC, datetime

from ccsmoni.config import AccountConfig, AppConfig
from ccsmoni.model import Limit, RawResult, Reading, Status
from ccsmoni.probes.base import Probe
from ccsmoni.scheduler import Scheduler

T0 = 1_800_000_000.0


class Clock:
    def __init__(self, t: float = T0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class FakeSource:
    kind = "fake"

    def __init__(self, fail: set[str] | None = None, gate: threading.Event | None = None) -> None:
        self.calls: list[str] = []
        self.fail = fail or set()
        self.gate = gate
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def fetch(self, account):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append(account.id)
        try:
            if self.gate is not None:
                self.gate.wait(5)
            else:
                threading.Event().wait(0.02)
            if account.id in self.fail:
                raise RuntimeError("boom")
            return RawResult("fake", datetime.now(UTC), 1, "10")
        finally:
            with self._lock:
                self.active -= 1


class FakeParser:
    def parse(self, raw, account_id):
        return Reading(account_id, raw.started_at, "fake", Status.OK,
                       (Limit("session", "s", float(raw.text), None),))


class FakeStore:
    def __init__(self) -> None:
        self.saved: list[Reading] = []

    def save(self, raw, reading):
        self.saved.append(reading)
        return len(self.saved)


def cfg(*ids: str, interval: int = 10, concurrency: int = 2, **per: int) -> AppConfig:
    return AppConfig.model_validate({
        "collector": {"default_interval_minutes": interval, "concurrency": concurrency, "discover_roots": []},
        "accounts": [
            AccountConfig(id=i, label=i, config_dir=f"/x/{i}", interval_minutes=per.get(i)).model_dump()
            for i in ids
        ],
    })


def make(config: AppConfig, source: FakeSource, clock: Clock, store: FakeStore | None = None):
    store = store or FakeStore()
    sched = Scheduler(store, config, lambda c: Probe("fake", source, FakeParser()), clock=clock, max_sleep=0.01)
    return sched, store


async def until(cond, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError("条件を満たしませんでした")
        await asyncio.sleep(0.005)


async def settle() -> None:
    await asyncio.sleep(0.1)


def run(coro_fn):
    asyncio.run(coro_fn())


def test_startup_fetches_all_with_concurrency_limit():
    async def main():
        src, clock = FakeSource(), Clock()
        sched, store = make(cfg("a", "b", "c", "d", "e", concurrency=2), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(store.saved) == 5)
        await settle()
        assert sorted(src.calls) == ["a", "b", "c", "d", "e"]
        assert src.calls[:2] == ["a", "b"] or set(src.calls[:2]) == {"a", "b"}  # 設定の並び順に始まる
        assert src.max_active <= 2
        assert sched.busy == [] and sched.last_run_at == T0
        assert sched.next_run_at("a") == T0 + 600
        await sched.stop()
        task.cancel()

    run(main)


def test_interval_and_single_catch_up_after_sleep():
    async def main():
        src, clock = FakeSource(), Clock()
        sched, store = make(cfg("a", "b", b=5), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(store.saved) == 2)
        clock.t = T0 + 5 * 60  # b だけ予定が来る
        await until(lambda: len(store.saved) == 3)
        await settle()
        assert src.calls[-1] == "b"
        # PC のスリープ: 10 時間後に復帰。たまった分は実行せず、各アカウント 1 回だけ取得する
        clock.t = T0 + 10 * 3600
        await until(lambda: len(store.saved) == 5)
        await settle()
        assert len(store.saved) == 5
        assert sched.next_run_at("a") == clock.t + 600
        await sched.stop()
        task.cancel()

    run(main)


def test_exception_is_saved_as_error_and_loop_continues():
    async def main():
        src, clock = FakeSource(fail={"a"}), Clock()
        sched, store = make(cfg("a", "b"), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(store.saved) == 2)
        by_id = {r.account_id: r for r in store.saved}
        assert by_id["a"].status == Status.ERROR and "boom" in by_id["a"].message
        assert by_id["b"].status == Status.OK
        clock.t += 600
        await until(lambda: len(store.saved) == 4)  # 次の回も動く
        await sched.stop()
        task.cancel()

    run(main)


def test_refresh_does_not_double_start():
    async def main():
        gate = threading.Event()
        src, clock = FakeSource(gate=gate), Clock()
        sched, store = make(cfg("a", "b"), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(src.calls) == 2)
        assert sched.refresh() == []  # どちらも取得中
        assert sched.busy == ["a", "b"]
        gate.set()
        await until(lambda: len(store.saved) == 2 and not sched.busy)
        assert sched.refresh("a") == ["a"]
        assert sched.refresh("a") == []
        await until(lambda: len(store.saved) == 3)
        try:
            sched.refresh("zzz")
            raise AssertionError("KeyError になるはず")
        except KeyError:
            pass
        await sched.stop()
        task.cancel()

    run(main)


def test_update_config_adds_removes_and_changes_interval():
    async def main():
        src, clock = FakeSource(), Clock()
        sched, store = make(cfg("a", "b"), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(store.saved) == 2)
        await settle()
        # b を外して c を足し、a の間隔を 30 分にする
        sched.update_config(cfg("a", "c", a=30))
        await until(lambda: len(store.saved) == 3)
        assert src.calls[-1] == "c"
        assert sched.next_run_at("a") == T0 + 30 * 60
        assert sched.next_run_at("b") is None
        clock.t = T0 + 10 * 60  # 以前なら a・b の予定だった時刻。c だけが取られる
        await until(lambda: len(store.saved) == 4)
        await settle()
        assert src.calls[-1] == "c" and "b" not in src.calls[2:]
        # 同時実行数の変更も受け付ける
        sched.update_config(cfg("a", "c", a=30, concurrency=1))
        assert sched.config.collector.concurrency == 1
        await sched.stop()
        task.cancel()

    run(main)


def test_refresh_soon_while_busy_fetches_again_after():
    async def main():
        gate = threading.Event()
        src, clock = FakeSource(gate=gate), Clock()
        sched, store = make(cfg("a", "b"), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(src.calls) == 2)
        sched.refresh_soon("a")  # 取得中: 終わったらもう一度
        assert sched.refresh() == []  # 普通の「今すぐ更新」は印を付けない
        sched.refresh_soon("zzz")  # 無効な id は何もしない
        gate.set()
        await until(lambda: len(store.saved) == 3)
        await settle()
        assert sorted(src.calls) == ["a", "a", "b"] and src.calls[-1] == "a"
        assert len(store.saved) == 3  # b はもう一度取らない
        assert sched.next_run_at("a") == clock.t + 600
        await sched.stop()
        task.cancel()

    run(main)


def test_config_dir_change_while_busy_fetches_again():
    async def main():
        gate = threading.Event()
        src, clock = FakeSource(gate=gate), Clock()
        sched, store = make(cfg("a"), src, clock)
        task = asyncio.create_task(sched.run())
        await until(lambda: len(src.calls) == 1)
        changed = cfg("a")
        changed.accounts[0].config_dir = "/y/a"
        sched.update_config(changed)  # 取得中に取得先が変わった
        gate.set()
        await until(lambda: len(store.saved) == 2)
        assert src.calls == ["a", "a"]
        await sched.stop()
        task.cancel()

    run(main)


def test_limiter_never_exceeds_limit_across_changes():
    from ccsmoni.scheduler import _Limiter

    async def main():
        lim = _Limiter(2)
        log: list[str] = []
        releases = {n: asyncio.Event() for n in "abcd"}

        async def worker(n: str) -> None:
            async with lim:
                log.append(f"+{n}")
                assert lim.active <= max(lim.limit, 2)
                await releases[n].wait()
                log.append(f"-{n}")

        tasks = [asyncio.create_task(worker(n)) for n in "abcd"]
        await until(lambda: lim.active == 2)
        lim.set_limit(1)  # 2 件実行中に上限を 1 に下げる
        releases["a"].set()
        await until(lambda: "-a" in log)
        await asyncio.sleep(0.02)
        assert "+c" not in log and lim.active == 1  # まだ 1 件実行中なので、新しく始めない
        releases["b"].set()
        await until(lambda: "+c" in log)
        assert lim.active == 1 and "+d" not in log
        lim.set_limit(3)  # 上げると、待っていたものがすぐ始まる
        await until(lambda: "+d" in log)
        assert lim.active == 2
        releases["c"].set()
        releases["d"].set()
        await asyncio.gather(*tasks)
        assert lim.active == 0
        assert [x for x in log if x.startswith("+")] == ["+a", "+b", "+c", "+d"]  # 先着順

    run(main)


def test_limiter_cancelled_waiter_does_not_leak_slot():
    from ccsmoni.scheduler import _Limiter

    async def main():
        lim = _Limiter(1)
        hold = asyncio.Event()

        async def holder():
            async with lim:
                await hold.wait()

        async def waiter():
            async with lim:
                pass

        h = asyncio.create_task(holder())
        await until(lambda: lim.active == 1)
        w = asyncio.create_task(waiter())
        await asyncio.sleep(0.01)
        w.cancel()
        await asyncio.gather(w, return_exceptions=True)
        hold.set()
        await h
        assert lim.active == 0
        async with lim:
            assert lim.active == 1

    run(main)
