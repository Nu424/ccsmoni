"""HTTP API と静的 UI の配信（FastAPI）。

何を: docs/API.md のエンドポイントを実装し、src/ccsmoni/static/ の UI を配信する。
      起動時に Scheduler（定期取得）と設定ファイルの監視（3 秒ごとの poll）を始める。
なぜ: 常駐プロセス1つで「取得・記録・表示・設定の編集・ログイン」をまかなう（PLAN §4）。
方針:
  - 部品（ConfigService・Store・Scheduler・LoginService・Probe の作り方）は Services にまとめて注入する。
    テストでは偽物を渡し、background=False で定期処理を止められる。
  - レスポンスの形は docs/API.md が契約。時刻は epoch 秒（UTC）。エラーは {"error": "<日本語>"}。
  - POST/PUT は Origin を確認する（無い・Host と同じなら許可。tailnet 内の別ページから叩かれないように）。
  - ログに出すのはアカウント id と状態程度（raw テキストやメールアドレスは出さない）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from ccsmoni import insights
from ccsmoni.config import (
    _PALETTE,
    AppConfig,
    ConfigConflictError,
    ConfigService,
    ConfigValidationError,
)
from ccsmoni.model import Account, Reading, Status

log = logging.getLogger("ccsmoni.web")

STATIC_DIR = Path(__file__).parent / "static"
CONFIG_POLL_SECONDS = 3.0
CANDIDATES_REFRESH_SECONDS = 300.0  # 未登録アカウントの走査はやや重いので、たまにだけやり直す
RANGES = {"24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
STALE_FACTOR = 3


@dataclass
class Services:
    """アプリが使う部品。serve では build_services、テストでは偽物を渡す。"""

    config_service: ConfigService
    store: Any  # ccsmoni.store.Store
    scheduler: Any  # ccsmoni.scheduler.Scheduler と同じ口（busy / last_run_at / next_run_at / refresh / update_config / run / stop）
    login: Any  # ccsmoni.login.LoginService と同じ口（start / state / stop）
    probe_factory: Callable[[AppConfig], Any]  # 接続テスト用の Probe を作る
    candidates_fn: Callable[[AppConfig], list[dict]] | None = None  # None なら config_service.discover_candidates
    clock: Callable[[], float] = time.time
    demo: bool = False


@dataclass
class Runtime:
    """実行中に変わる状態（いまの設定・候補・起動時の host/port）。"""

    services: Services
    cfg: AppConfig
    cfg_hash: str
    server_addr: tuple[str, int]
    candidates: list[dict] = field(default_factory=list)


def _err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def _short_path(p: Path) -> str:
    """ホーム配下なら ~ を使った表記にする（画面やスクリーンショットにユーザー名を出さないため）。"""
    try:
        return str(Path("~") / p.resolve().relative_to(Path.home().resolve()))
    except ValueError:
        return str(p)


# ---------------------------------------------------------------- /api/state の組み立て


def _api_limits(reading: Reading, now: float, rows: list[dict]) -> list[dict]:
    out = []
    for lim in reading.limits:
        d = insights.limit_to_api(lim)
        pts = insights.window_points(rows, d["kind"], d["resets_at"]) if d["resets_at"] is not None else []
        d["pace"] = insights.pace(d, now, pts)
        out.append(d)
    return out


def build_account_state(rt: Runtime, index: int, a: Any, latest: dict[str, Reading], now: float) -> dict:
    store, cfg = rt.services.store, rt.cfg
    interval = cfg.interval_for(a.id)
    reading = latest.get(a.id)
    meta = store.get_account_meta(a.id) or {}
    rows = store.history(_dt(now - 86400), account_ids=[a.id]) if reading is not None else []
    next_run = rt.services.scheduler.next_run_at(a.id) if a.enabled else None
    st: dict[str, Any] = {
        "id": a.id,
        "label": a.label,
        "color": a.color or _PALETTE[index % len(_PALETTE)],
        "enabled": a.enabled,
        "launch_command": a.launch_command,
        "interval_minutes": interval,
        "next_run_at": int(next_run) if next_run is not None else None,
        "status": "never",
        "message": None,
        "taken_at": None,
        "stale": False,
        "plan": meta.get("last_plan"),
        "limits": [],
        "last_ok": None,
        "login": rt.services.login.state(a.id),
        "hints": [],
    }
    if reading is not None:
        taken = int(reading.taken_at.timestamp())
        st.update(
            status=str(reading.status),
            message=reading.message,
            taken_at=taken,
            stale=now - taken > STALE_FACTOR * interval * 60,
            plan=reading.extras.get("plan") or meta.get("last_plan"),
        )
        if reading.status == Status.OK:
            st["limits"] = _api_limits(reading, now, rows)
            st["hints"] = insights.hints(st, now)
        else:
            ok = store.latest_ok(a.id)
            if ok is not None:
                st["last_ok"] = {"taken_at": int(ok.taken_at.timestamp()), "limits": _api_limits(ok, now, rows)}
    return st


def build_state(rt: Runtime, now: float) -> dict:
    sched = rt.services.scheduler
    latest = rt.services.store.latest()
    accounts = [build_account_state(rt, i, a, latest, now) for i, a in enumerate(rt.cfg.accounts)]
    last_run = sched.last_run_at
    if last_run is None and latest:  # 再起動直後は DB の最新値で代用する
        last_run = max(r.taken_at.timestamp() for r in latest.values())
    next_run = sched.next_run_at()
    return {
        "now": int(now),
        "collector": {
            "busy": list(sched.busy),
            "last_run_at": int(last_run) if last_run is not None else None,
            "next_run_at": int(next_run) if next_run is not None else None,
        },
        "ui": {"warn_percent": rt.cfg.ui.warn_percent, "danger_percent": rt.cfg.ui.danger_percent},
        "config_error": rt.services.config_service.last_error,
        "accounts": accounts,
        "candidates": rt.candidates,
    }


def _dt(t: float) -> datetime:
    return datetime.fromtimestamp(t, UTC)


def _csv(v: str | None) -> list[str] | None:
    if v is None:
        return None
    items = [x.strip() for x in v.split(",") if x.strip()]
    return items or None


async def _json_body(request: Request) -> Any:
    body = await request.body()
    if not body.strip():
        return {}
    try:
        return json.loads(body)
    except ValueError:
        return None


# ---------------------------------------------------------------- アプリ


def create_app(
    services: Services,
    background: bool = True,
    poll_seconds: float = CONFIG_POLL_SECONDS,
    static_dir: Path = STATIC_DIR,
) -> FastAPI:
    cs = services.config_service
    cfg = cs.current
    if cfg is None:
        cfg, _ = cs.load()
    rt = Runtime(services, cfg, cs.current_hash or cs.file_hash(), (cfg.server.host, cfg.server.port))

    def find_candidates(c: AppConfig) -> list[dict]:
        fn = services.candidates_fn or cs.discover_candidates
        try:
            return fn(c)
        except Exception as e:
            log.error("未登録アカウントの検出に失敗しました（%s）", type(e).__name__)
            return []

    async def refresh_candidates() -> None:
        rt.candidates = await asyncio.to_thread(find_candidates, rt.cfg)

    def apply_config(new: AppConfig, h: str) -> None:
        rt.cfg, rt.cfg_hash = new, h
        services.scheduler.update_config(new)
        asyncio.get_running_loop().create_task(refresh_candidates())

    async def poll_loop() -> None:
        last_scan = time.monotonic()
        while True:
            await asyncio.sleep(poll_seconds)
            try:
                new = await asyncio.to_thread(cs.poll)
            except Exception as e:  # ファイルが一時的に読めないなど。次の poll でやり直す
                log.error("設定ファイルの確認に失敗しました（%s）", type(e).__name__)
                continue
            if new is not None:
                log.info("設定ファイルの変更を読み込みました")
                apply_config(new, cs.current_hash or rt.cfg_hash)
            elif time.monotonic() - last_scan > CANDIDATES_REFRESH_SECONDS:
                last_scan = time.monotonic()
                await refresh_candidates()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        tasks: list[asyncio.Task] = []
        await refresh_candidates()
        if background:
            tasks.append(asyncio.create_task(services.scheduler.run(), name="scheduler"))
            tasks.append(asyncio.create_task(poll_loop(), name="config-poll"))
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            await services.scheduler.stop()
            await services.login.stop()
            await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(title="ccsmoni", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runtime = rt

    # --- エラーの形をそろえる -------------------------------------------------

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        return _err(exc.status_code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        fields = [[".".join(str(x) for x in e["loc"]), e["msg"]] for e in exc.errors()]
        return _err(422, "入力内容に誤りがあります", fields=fields)

    # --- Origin の確認 -------------------------------------------------------

    @app.middleware("http")
    async def _check_origin(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin")
            if origin is not None:
                o = urlsplit(origin).netloc.lower()
                allowed = {
                    h.lower()
                    for h in (request.headers.get("host"), request.headers.get("x-forwarded-host"))
                    if h
                }
                if not o or o not in allowed:
                    return _err(403, "許可されていないオリジンからのリクエストです")
        return await call_next(request)

    # --- 状態・推移 ----------------------------------------------------------

    @app.get("/api/state")
    async def get_state():
        # Scheduler・LoginService の状態はループ内でしか触らないので、スレッドに逃がさずここで組み立てる
        # （DB の読み出しはアカウントごとに数件の小さなクエリで、数ミリ秒で終わる）
        return build_state(rt, services.clock())

    @app.get("/api/history")
    async def get_history(range: str = "7d", kinds: str | None = None, accounts: str | None = None):
        if range not in RANGES:
            return _err(422, "range は 24h / 7d / 30d のいずれかで指定してください")
        now = int(services.clock())
        since = now - RANGES[range]
        account_ids, kind_list = _csv(accounts), _csv(kinds)

        def work() -> dict:
            rows = services.store.history(_dt(since), _dt(now), account_ids=account_ids, kinds=kind_list)
            snaps = services.store.snapshot_times(_dt(since), account_ids=account_ids)
            intervals = {a.id: rt.cfg.interval_for(a.id) for a in rt.cfg.accounts}
            return insights.history_series(
                rows, snaps, since, now, intervals,
                default_interval=rt.cfg.collector.default_interval_minutes,
                account_order=[a.id for a in rt.cfg.accounts],
            )

        return await asyncio.to_thread(work)

    @app.get("/api/windows")
    async def get_windows(kind: str = "weekly_all", limit: int = 8):
        if not 1 <= limit <= 52:
            return _err(422, "limit は 1〜52 で指定してください")

        def work() -> dict:
            ws = services.store.windows(kind=kind)
            rows = insights.window_peaks(ws, [a.id for a in rt.cfg.accounts], limit)
            return {"kind": kind, "rows": rows}

        return await asyncio.to_thread(work)

    # --- 今すぐ更新 ----------------------------------------------------------

    @app.post("/api/refresh", status_code=202)
    async def post_refresh(request: Request):
        body = await _json_body(request)
        if not isinstance(body, dict) or not isinstance(body.get("account_id", ""), (str, type(None))):
            return _err(422, "本文は {\"account_id\": \"...\"} の形で指定してください")
        account_id = body.get("account_id") or None
        try:
            started = services.scheduler.refresh(account_id)
        except KeyError:
            return _err(404, f"有効なアカウント「{account_id}」が見つかりません")
        return JSONResponse({"started": started, "busy": list(services.scheduler.busy)}, status_code=202)

    # --- 設定 ----------------------------------------------------------------

    @app.get("/api/config")
    async def get_config():
        # ファイルが壊れている（検証に通らない）ときは、最後に有効だった設定と「いまのファイルの hash」を返す。
        # こうしないと UI は 409 → 読み込み直し → 409 を繰り返す。保存すれば壊れた内容を上書きして直せる
        h = rt.cfg_hash if cs.last_error is None else await asyncio.to_thread(cs.file_hash)
        return {
            "config": rt.cfg.model_dump(),
            "hash": h,
            "path": _short_path(cs.path),
            "error": cs.last_error,
            "candidates": rt.candidates,
        }

    @app.put("/api/config")
    async def put_config(request: Request):
        body = await _json_body(request)
        if not isinstance(body, dict) or not isinstance(body.get("config"), dict) or not isinstance(body.get("hash"), str):
            return _err(422, "入力内容に誤りがあります", fields=[["(全体)", "config と hash を指定してください"]])
        try:
            new_hash = await asyncio.to_thread(cs.save, body["config"], body["hash"])
        except ConfigConflictError:
            return _err(409, "設定ファイルが外部で変更されました", hash=await asyncio.to_thread(cs.file_hash))
        except ConfigValidationError as e:
            return _err(422, "入力内容に誤りがあります", fields=[[f, m] for f, m in e.errors])
        new_cfg = cs.current
        assert new_cfg is not None
        log.info("画面から設定を保存しました")
        apply_config(new_cfg, new_hash)
        out: dict[str, Any] = {"hash": new_hash}
        if (new_cfg.server.host, new_cfg.server.port) != rt.server_addr:
            out["restart_required"] = True
        return out

    # --- 接続テスト ----------------------------------------------------------

    @app.post("/api/accounts/test")
    async def post_test(request: Request):
        body = await _json_body(request)
        config_dir = body.get("config_dir") if isinstance(body, dict) else None
        if not isinstance(config_dir, str) or not config_dir.strip():
            return _err(422, "入力内容に誤りがあります", fields=[["config_dir", "空にはできません"]])
        from ccsmoni.config import AccountConfig

        expanded = AccountConfig(id="test", label="test", config_dir=config_dir).expanded_dir()
        account = Account(id="test", label="test", config_dir=expanded)
        probe = services.probe_factory(rt.cfg)
        now = services.clock()
        try:
            _raw, reading = await asyncio.to_thread(probe.run, account)
        except Exception as e:
            log.error("接続テストで例外が発生しました（%s）", type(e).__name__)
            return {"status": "error", "message": f"{type(e).__name__}: {e}", "plan": None, "limits": []}
        log.info("接続テスト: %s", reading.status)
        return {
            "status": str(reading.status),
            "message": reading.message,
            "plan": reading.extras.get("plan"),
            "limits": _api_limits(reading, now, []) if reading.status == Status.OK else [],
        }

    # --- ログイン ------------------------------------------------------------

    @app.post("/api/accounts/{account_id}/login", status_code=202)
    async def post_login(account_id: str):
        a = next((x for x in rt.cfg.accounts if x.id == account_id), None)
        if a is None:
            return _err(404, f"アカウント「{account_id}」が見つかりません")
        account = Account(id=a.id, label=a.label, config_dir=a.expanded_dir(), launch_command=a.launch_command)
        state = services.login.start(account)
        return JSONResponse({"login": state}, status_code=202)

    # --- 静的 UI -------------------------------------------------------------

    @app.get("/", include_in_schema=False)
    async def index():
        p = static_dir / "index.html"
        if p.is_file():
            return FileResponse(p, headers={"Cache-Control": "no-cache"})
        return HTMLResponse("<!doctype html><meta charset=utf-8><title>ccsmoni</title><p>ccsmoni は起動しています（UI はまだありません）。</p>")

    # UI は相対パス（app.js, vendor/...）でも /static/... でも参照できるようにする。
    # static/ が無くても起動できるよう check_dir=False。/api/ に無いパスもここに落ちて 404 になる。
    app.mount("/static", StaticFiles(directory=static_dir, check_dir=False), name="static")
    app.mount("/", StaticFiles(directory=static_dir, check_dir=False), name="root")
    return app


# ---------------------------------------------------------------- 本番・デモの部品の組み立て


def build_services(demo: bool = False) -> Services:
    """CCSMONI_HOME（app_home）の設定と DB から、serve 用の部品を作る。"""
    from ccsmoni.config import app_home, config_path, db_path
    from ccsmoni.login import LoginService
    from ccsmoni.parser_usage import UsageTextParser
    from ccsmoni.probes.base import Probe
    from ccsmoni.probes.cli_usage import CliUsageSource
    from ccsmoni.scheduler import Scheduler, default_probe_factory
    from ccsmoni.store import Store

    home = app_home()
    home.mkdir(parents=True, exist_ok=True)
    cs = ConfigService(config_path())
    cfg, _ = cs.load()
    store = Store(db_path())

    if demo:
        from ccsmoni import demo as demo_mod

        source = demo_mod.DemoSource(home)

        def probe_factory(c: AppConfig) -> Probe:
            return Probe(name="cli-usage", source=source, parser=UsageTextParser())

        scheduler = Scheduler(store, cfg, probe_factory)
        login = LoginService(
            command=lambda: ["claude"],
            auth_status=source.auth_status,
            last_org_id=lambda aid: (store.get_account_meta(aid) or {}).get("last_org_id"),
            on_logged_in=lambda aid: _safe_refresh(scheduler, aid),
            popen=lambda args, env=None, **kw: demo_mod.DemoConsole(source, Path(env["CLAUDE_CONFIG_DIR"]).name),
            poll_seconds=2.0,
        )
        return Services(cs, store, scheduler, login, probe_factory,
                        candidates_fn=lambda c: list(demo_mod.DEMO_CANDIDATES), demo=True)

    scheduler = Scheduler(store, cfg, default_probe_factory)

    def auth_status(account: Account) -> dict | None:
        c = scheduler.config.collector
        return CliUsageSource(c.claude_path, c.timeout_seconds).auth_status(account)

    def command() -> list[str]:
        return CliUsageSource(scheduler.config.collector.claude_path)._base_command()

    login = LoginService(
        command=command,
        auth_status=auth_status,
        last_org_id=lambda aid: (store.get_account_meta(aid) or {}).get("last_org_id"),
        on_logged_in=lambda aid: _safe_refresh(scheduler, aid),
    )
    return Services(cs, store, scheduler, login, default_probe_factory)


def _safe_refresh(scheduler: Any, account_id: str) -> None:
    try:
        scheduler.refresh(account_id)
    except KeyError:
        pass  # ログインの間に無効化された
