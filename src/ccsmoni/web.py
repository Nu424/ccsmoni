"""HTTP API と静的 UI の配信（FastAPI）。

何を: docs/API.md のエンドポイントを実装し、src/ccsmoni/static/ の UI を配信する。
      起動時に Scheduler（定期取得）と設定ファイルの監視（3 秒ごとの poll）を始める。
なぜ: 常駐プロセス1つで「取得・記録・表示・設定の編集・ログイン」をまかなう（PLAN §4）。
方針:
  - 部品（ConfigService・Store・Scheduler・LoginService・Probe の作り方）は Services にまとめて注入する。
    テストでは偽物を渡し、background=False で定期処理を止められる。
  - レスポンスの形は docs/API.md が契約。時刻は epoch 秒（UTC）。エラーは {"error": "<日本語>"}。
  - すべてのリクエストで Host ヘッダーを許可リスト（ループバック・*.ts.net・server.allowed_hosts）と照合する。
    DNS rebinding（攻撃者のドメインを 127.0.0.1 に向け直して、ブラウザから読ませる）を防ぐため。
  - POST/PUT は Origin も確認する。Origin が無い（curl など）なら許可。あれば、Origin のホストが許可リストにあり、
    かつ Host と一致すること（tailnet 内の別ページから叩かれないように）。X-Forwarded-Host は信頼しない
    （誰でも付けられるため。tailscale serve は Host をそのまま中継する）。
  - 設定の claude_path・host・port は Web から変えられない（config.readonly_errors）。接続テストは同時に1件まで。
  - ログに出すのはアカウント id と状態程度（raw テキストやメールアドレスは出さない）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable, Iterable
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
    MSG_READONLY,
    PALETTE,
    ColorSpec,
    AppConfig,
    ConfigConflictError,
    ConfigService,
    ConfigValidationError,
    readonly_errors,
    readonly_values,
    resolve_colors,
    short_path,
)
from ccsmoni.model import Account, Reading, Status

log = logging.getLogger("ccsmoni.web")

STATIC_DIR = Path(__file__).parent / "static"
CONFIG_POLL_SECONDS = 3.0
CANDIDATES_REFRESH_SECONDS = 300.0  # 未登録アカウントの走査はやや重いので、たまにだけやり直す
MAX_HISTORY_SPAN = 120 * 86400  # /api/history の since〜until の上限
MAX_EPOCH = 4102444800  # 2100-01-01。datetime に直せない巨大な値を弾く
WEEKLY_PEAKS = 6  # accounts[].weekly_peaks の枠数
RANGES = {"24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
STALE_FACTOR = 3
# Host ヘッダーとして常に受け付けるホスト（ポートは問わない）。ほかに *.ts.net と server.allowed_hosts
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})
TAILNET_SUFFIX = ".ts.net"
APP_NAME = "ccsmoni"


def app_version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("ccsmoni")
    except PackageNotFoundError:
        return "unknown"


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
    """実行中に変わる状態（いまの設定・候補・接続テストの実行中か）。"""

    services: Services
    cfg: AppConfig
    cfg_hash: str
    candidates: list[dict] = field(default_factory=list)
    testing: bool = False  # 接続テストを実行中（同時に1件まで）


def _err(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def host_of(netloc: str) -> str:
    """Host ヘッダー（や Origin の netloc）からポートを除いたホスト名（小文字）。IPv6 は [::1] の形のまま返す。"""
    netloc = netloc.strip().lower()
    if netloc.startswith("["):
        end = netloc.find("]")
        return netloc[: end + 1] if end != -1 else netloc
    return netloc.rsplit(":", 1)[0].rstrip(".")


def host_allowed(netloc: str, extra: Iterable[str] = ()) -> bool:
    """許可リストにあるホストか（ポートは問わない）。ループバック・*.ts.net（tailscale serve 経由）・extra。"""
    h = host_of(netloc)
    if not h:
        return False
    return h in LOCAL_HOSTS or h.endswith(TAILNET_SUFFIX) or h in {x.lower() for x in extra}


# ---------------------------------------------------------------- /api/state の組み立て


def _api_limits(reading: Reading, now: float, rows: list[dict]) -> list[dict]:
    taken = int(round(reading.taken_at.timestamp()))
    out = []
    for lim in reading.limits:
        d = insights.limit_to_api(lim)
        # この取得の行の window_id で同じ枠の点を選ぶ（resets_at が同じでも、リセット後は別の枠になるため）
        wid = next((r.get("window_id") for r in rows if r["kind"] == d["kind"] and r["t"] == taken), None)
        pts = insights.window_points(rows, d["kind"], d["resets_at"], wid) if d["resets_at"] is not None else []
        d["pace"] = insights.pace(d, now, pts)
        out.append(d)
    return out


def build_account_state(rt: Runtime, a: Any, color: ColorSpec, latest: dict[str, Reading], now: float) -> dict:
    store, cfg = rt.services.store, rt.cfg
    interval = cfg.interval_for(a.id)
    reading = latest.get(a.id)
    meta = store.get_account_meta(a.id) or {}
    # 枯渇予測の「直近 24 時間の速度」に使う（取得時刻の揺れの分だけ少し広めに取る。insights.RECENT_SLACK）
    rows = store.history(_dt(now - 86400 - 3600), account_ids=[a.id]) if reading is not None else []
    next_run = rt.services.scheduler.next_run_at(a.id) if a.enabled else None
    st: dict[str, Any] = {
        "id": a.id,
        "label": a.label,
        "color_slot": color[0],  # パレットの番号。独自の色のときは null
        "color": color[1],  # 独自の色（#rrggbb）のときだけ。それ以外は null
        "enabled": a.enabled,
        "launch_command": a.launch_command,
        "interval_minutes": interval,
        "next_run_at": int(next_run) if next_run is not None else None,
        "status": "never",
        "message": None,
        "taken_at": None,
        "status_since": None,
        "stale": False,
        "plan": meta.get("last_plan"),
        "limits": [],
        "last_ok": None,
        "weekly_peaks": [],
        "login": rt.services.login.state(a.id),
        "hints": [],
    }
    if reading is not None:
        taken = int(reading.taken_at.timestamp())
        st.update(
            status=str(reading.status),
            message=reading.message,
            taken_at=taken,
            stale=bool(a.enabled) and now - taken > STALE_FACTOR * interval * 60,  # 無効なアカウントは古くて当然
            plan=reading.extras.get("plan") or meta.get("last_plan"),
        )
        if reading.status == Status.OK:
            st["limits"] = _api_limits(reading, now, rows)
            st["hints"] = insights.hints(st, now)
        else:
            st["status_since"] = store.status_since(a.id)
            ok = store.latest_ok(a.id)
            if ok is not None:
                st["last_ok"] = {"taken_at": int(ok.taken_at.timestamp()), "limits": _api_limits(ok, now, rows)}
    cur_weekly = next((lim["resets_at"] for lim in st["limits"] if lim["kind"] == "weekly_all"), None)
    st["weekly_peaks"] = insights.weekly_peaks(store.windows(account_id=a.id, kind="weekly_all"), cur_weekly, WEEKLY_PEAKS)
    return st


def build_state(rt: Runtime, now: float, config_hash: str | None = None) -> dict:
    sched = rt.services.scheduler
    store = rt.services.store
    latest = store.latest()
    configured = {a.id for a in rt.cfg.accounts}
    archived_ids = [aid for aid in store.account_ids() if aid not in configured]
    colors = resolve_colors(rt.cfg.accounts, archived_ids)
    accounts = [build_account_state(rt, a, colors[a.id], latest, now) for a in rt.cfg.accounts]
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
        "ui": {
            "warn_percent": rt.cfg.ui.warn_percent,
            "danger_percent": rt.cfg.ui.danger_percent,
            "tiles_per_page": rt.cfg.ui.tiles_per_page,
        },
        "palette": PALETTE,
        "config_error": rt.services.config_service.last_error,
        # いまの設定ファイルのハッシュ（壊れていても計算する）。設定画面が外部の変更に気づくのに使う
        "config_hash": config_hash if config_hash is not None else rt.services.config_service.file_hash(),
        "accounts": accounts,
        # 履歴はあるが設定にないアカウント（削除したもの）。推移グラフの凡例・色に使う
        "archived": [
            {"id": aid, "label": aid, "color_slot": colors[aid][0], "color": colors[aid][1]} for aid in archived_ids
        ],
        "candidates": rt.candidates,
    }


def _dt(t: float) -> datetime:
    return datetime.fromtimestamp(t, UTC)


def _snapshot_spans(snaps: list[tuple[str, int, str]], since: int, until: int) -> list[dict]:
    """範囲内の取得（状態・kind を問わない）の最初と最後の時刻（アカウントごと）。

    UI は取得した範囲ごとに gaps をキャッシュする。範囲の境目をまたぐ抜けは、どちらの応答の gaps にも入らないので、
    境目の両側の「最後・最初の取得」をこれで知り、手元で判定する（weekly_model:* だけの取得も数に入れるため）。
    """
    first: dict[str, int] = {}
    last: dict[str, int] = {}
    for account_id, t, _status in snaps:
        if not since <= t <= until:
            continue
        if account_id not in first or t < first[account_id]:
            first[account_id] = t
        if account_id not in last or t > last[account_id]:
            last[account_id] = t
    return [{"account_id": a, "first": first[a], "last": last[a]} for a in sorted(first)]


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
    rt = Runtime(services, cfg, cs.current_hash or cs.file_hash())

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

    # --- Host・Origin の確認 ------------------------------------------------

    @app.middleware("http")
    async def _check_host_and_origin(request: Request, call_next):
        host = request.headers.get("host", "")
        if not host_allowed(host, rt.cfg.server.allowed_hosts):
            log.warning("許可されていないホストへのリクエストを拒否しました")
            return _err(403, "許可されていないホストへのリクエストです")
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin")
            if origin is not None:
                o = urlsplit(origin).netloc.lower()
                if not o or not host_allowed(o, rt.cfg.server.allowed_hosts) or o != host.strip().lower():
                    return _err(403, "許可されていないオリジンからのリクエストです")
        return await call_next(request)

    @app.get("/api/health")
    async def get_health():
        # serve が「このポートで動いているのは ccsmoni か」を確かめるのに使う
        return {"app": APP_NAME, "version": app_version()}

    # --- 状態・推移 ----------------------------------------------------------

    @app.get("/api/state")
    async def get_state():
        # Scheduler・LoginService の状態はループ内でしか触らないので、スレッドに逃がさずここで組み立てる
        # （DB の読み出しはアカウントごとに数件の小さなクエリで、数ミリ秒で終わる）
        h = await asyncio.to_thread(cs.file_hash)
        return build_state(rt, services.clock(), h)

    @app.get("/api/history")
    async def get_history(
        range: str = "7d",
        kinds: str | None = None,
        accounts: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ):
        # since / until（epoch 秒）を両方指定したら range より優先する。片方だけは曖昧なので 422
        if since is not None or until is not None:
            if since is None or until is None:
                return _err(422, "since と until は両方指定してください")
            if not 0 <= since <= MAX_EPOCH or not 0 <= until <= MAX_EPOCH:
                return _err(422, "since / until は 2100 年までの epoch 秒で指定してください")
            if since >= until:
                return _err(422, "since は until より前にしてください")
            if until - since > MAX_HISTORY_SPAN:
                return _err(422, "範囲は最大 120 日です")
        else:
            if range not in RANGES:
                return _err(422, "range は 24h / 7d / 30d のいずれかで指定してください")
            until = int(services.clock())
            since = until - RANGES[range]
        now = until
        account_ids, kind_list = _csv(accounts), _csv(kinds)

        def work() -> dict:
            rows = services.store.history(_dt(since), _dt(now), account_ids=account_ids, kinds=kind_list)
            snaps = services.store.snapshot_times(_dt(since), account_ids=account_ids, until=_dt(now))
            intervals = {a.id: rt.cfg.interval_for(a.id) for a in rt.cfg.accounts}
            out = insights.history_series(
                rows, snaps, since, now, intervals,
                default_interval=rt.cfg.collector.default_interval_minutes,
                account_order=[a.id for a in rt.cfg.accounts],
            )
            out["spans"] = _snapshot_spans(snaps, since, now)
            return out

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
        # ファイルが壊れている（読めない・検証に通らない・空・無い）ときは、最後に有効だった設定と
        # 「いまのファイルの hash」を返す。有効だった設定の hash を返すと、保存のたびに 409 になるため。
        # 保存すると直せる: 検証に通らないだけなら差分で書き直し（スキーマ外のキーは取り除く）、
        # TOML の構文エラーなら壊れたファイルを config.toml.broken-<日時> に退避して書き出し直す（ConfigService.save）
        h = rt.cfg_hash if cs.last_error is None else await asyncio.to_thread(cs.file_hash)
        history_ids = await asyncio.to_thread(services.store.account_ids)
        return {
            "config": rt.cfg.model_dump(),
            "hash": h,
            "path": short_path(cs.path),
            "error": cs.last_error,
            "candidates": rt.candidates,
            "palette": PALETTE,
            # 設定のアカウントの解決済みの色（色が未設定のものも含む）。設定画面の色見本に使う
            "slots": {k: {"color_slot": v[0], "color": v[1]} for k, v in resolve_colors(rt.cfg.accounts).items()},
            "history_ids": history_ids,
            "readonly": readonly_values(rt.cfg),
        }

    @app.put("/api/config")
    async def put_config(request: Request):
        body = await _json_body(request)
        if not isinstance(body, dict) or not isinstance(body.get("config"), dict) or not isinstance(body.get("hash"), str):
            return _err(422, "入力内容に誤りがあります", fields=[["(全体)", "config と hash を指定してください"]])
        # claude_path・host・port はファイルでだけ編集する。省略されていれば今の値で埋める
        locked = readonly_errors(body["config"], rt.cfg)
        if locked:
            return _err(422, MSG_READONLY, fields=[[f, m] for f, m in locked])
        try:
            result = await asyncio.to_thread(cs.save, body["config"], body["hash"])
        except ConfigConflictError:
            return _err(409, "設定ファイルが外部で変更されました", hash=await asyncio.to_thread(cs.file_hash))
        except ConfigValidationError as e:
            return _err(422, "入力内容に誤りがあります", fields=[[f, m] for f, m in e.errors])
        new_cfg = cs.current
        assert new_cfg is not None
        log.info("画面から設定を保存しました")
        if result.removed_keys:
            log.info("設定ファイルからスキーマ外のキーを取り除きました: %s", ", ".join(result.removed_keys))
        if result.backup_path is not None:
            log.info("壊れた設定ファイルを退避しました: %s", short_path(result.backup_path))
        apply_config(new_cfg, result.hash)
        return {
            "hash": result.hash,
            "removed_keys": result.removed_keys,
            "backup_path": short_path(result.backup_path) if result.backup_path is not None else None,
        }

    # --- 接続テスト ----------------------------------------------------------

    @app.post("/api/accounts/test")
    async def post_test(request: Request):
        body = await _json_body(request)
        config_dir = body.get("config_dir") if isinstance(body, dict) else None
        if not isinstance(config_dir, str) or not config_dir.strip():
            return _err(422, "入力内容に誤りがあります", fields=[["config_dir", "空にはできません"]])
        # claude を起動するので、同時に1件までにする（連打や複数の画面から、プロセスが積み上がらないように）
        if rt.testing:
            return _err(429, "接続テストを実行中です")
        from ccsmoni.config import AccountConfig

        expanded = AccountConfig(id="test", label="test", config_dir=config_dir).expanded_dir()
        account = Account(id="test", label="test", config_dir=expanded)
        probe = services.probe_factory(rt.cfg)
        now = services.clock()
        rt.testing = True
        try:
            _raw, reading = await asyncio.to_thread(probe.run, account)
        except Exception as e:
            log.error("接続テストで例外が発生しました（%s）", type(e).__name__)
            return {"status": "error", "message": f"{type(e).__name__}: {e}", "plan": None, "limits": []}
        finally:
            rt.testing = False
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


def build_services(demo: bool = False, config_service: ConfigService | None = None) -> Services:
    """CCSMONI_HOME（app_home）の設定と DB から、serve 用の部品を作る。

    config_service を渡すと、それ（読み込み済み）を使う（serve が起動前に設定を確かめるため）。
    設定が検証に通らなければ ConfigValidationError。
    """
    from ccsmoni.config import app_home, config_path, db_path
    from ccsmoni.login import LoginService
    from ccsmoni.parser_usage import UsageTextParser
    from ccsmoni.probes.base import Probe
    from ccsmoni.probes.cli_usage import CliUsageSource
    from ccsmoni.scheduler import Scheduler, default_probe_factory
    from ccsmoni.store import Store

    home = app_home()
    home.mkdir(parents=True, exist_ok=True)
    cs = config_service or ConfigService(config_path())
    cfg = cs.current
    if cfg is None:
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
            on_logged_in=scheduler.refresh_soon,
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
        on_logged_in=scheduler.refresh_soon,
    )
    return Services(cs, store, scheduler, login, default_probe_factory)

