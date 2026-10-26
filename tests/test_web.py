"""web（FastAPI）のテスト。Scheduler・LoginService・Probe は偽物、設定と DB は tmp_path / メモリ上。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import warnings

import pytest

with warnings.catch_warnings():
    # starlette が httpx の利用を非推奨と警告するが、テストでは dev 依存の httpx で十分
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

from ccsmoni.config import ConfigService
from ccsmoni.model import Limit, RawResult, Reading, Status
from ccsmoni.parser_usage import UsageTextParser
from ccsmoni.probes.base import Probe
from ccsmoni.store import Store
from ccsmoni.web import Services, create_app

NOW = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
CONFIG = """\
# 手書きのメモ
[collector]
default_interval_minutes = 10
discover_roots = []

[[accounts]]
id = "a"
label = "A"
config_dir = "~/x/a"
color = "#112233"

[[accounts]]
id = "b"
label = "B"
config_dir = "~/x/b"
interval_minutes = 5

[[accounts]]
id = "c"
label = "C"
config_dir = "~/x/c"
enabled = false
"""


class FakeScheduler:
    def __init__(self, ids: list[str]) -> None:
        self.ids = ids
        self.busy: list[str] = []
        self.last_run_at: float | None = None
        self.refreshed: list[str | None] = []
        self.configs: list = []

    def next_run_at(self, account_id=None):
        return NOW.timestamp() + 300

    def refresh(self, account_id=None):
        if account_id is not None and account_id not in self.ids:
            raise KeyError(account_id)
        self.refreshed.append(account_id)
        return [account_id] if account_id else list(self.ids)

    def update_config(self, cfg):
        self.configs.append(cfg)
        self.ids = [a.id for a in cfg.active_accounts()]

    async def run(self):  # background=False なので呼ばれない
        raise AssertionError

    async def stop(self):
        pass


class FakeLogin:
    def __init__(self) -> None:
        self.started: list = []

    def start(self, account):
        self.started.append(account)
        return {"state": "waiting", "started_at": int(NOW.timestamp()), "message": "PC 側にログイン画面を開きました"}

    def state(self, account_id):
        return None

    async def stop(self):
        pass


class FakeSource:
    kind = "cli-usage"

    def __init__(self) -> None:
        self.accounts: list = []

    def fetch(self, account):
        self.accounts.append(account)
        return RawResult("cli-usage", NOW, 10, "Current session: 6% used · resets Oct 27, 11:00pm (UTC)",
                         exit_code=0, meta={"auth": {"loggedIn": True, "subscriptionType": "max"}})


def reading(account, at, status=Status.OK, session=10.0, weekly=40.0, plan="max"):
    limits = () if status != Status.OK else (
        Limit("session", "Current session", session, NOW + timedelta(hours=2)),
        Limit("weekly_all", "Current week (all models)", weekly, NOW + timedelta(days=3)),
    )
    return Reading(account, at, "cli-usage", status, limits,
                   message=None if status == Status.OK else "ログインが切れています",
                   extras={"plan": plan, "org_id": "org"} if status == Status.OK else {})


def save(store, r):
    store.save(RawResult("cli-usage", r.taken_at, 1, "", exit_code=0), r)


@pytest.fixture
def env(tmp_path: Path):
    cfg_path = tmp_path / "config.toml"
    cfg_path.write_text(CONFIG, encoding="utf-8")
    cs = ConfigService(cfg_path, discover_roots=[])
    cs.load()
    store = Store(":memory:")
    sched = FakeScheduler(["a", "b"])
    login = FakeLogin()
    source = FakeSource()
    static = tmp_path / "static"
    static.mkdir()
    (static / "app.js").write_text("console.log(1)", encoding="utf-8")
    services = Services(
        config_service=cs, store=store, scheduler=sched, login=login,
        probe_factory=lambda c: Probe("cli-usage", source, UsageTextParser()),
        candidates_fn=lambda c: [{"suggested_id": "z", "config_dir": "~/x/z"}],
        clock=lambda: NOW.timestamp(),
    )
    app = create_app(services, background=False, static_dir=static)
    with TestClient(app) as client:
        yield client, services, cfg_path, static
    store.close()


# ---------------------------------------------------------------- state


def test_state_shape(env):
    client, svc, *_ = env
    store = svc.store
    for i in range(4):
        save(store, reading("a", NOW - timedelta(minutes=30 - 10 * i), session=10 + 10 * i))
    save(store, reading("b", NOW - timedelta(hours=2), weekly=20))
    save(store, reading("b", NOW - timedelta(hours=1), status=Status.LOGGED_OUT))

    d = client.get("/api/state").json()
    assert d["now"] == int(NOW.timestamp())
    assert d["collector"]["busy"] == []
    assert d["collector"]["last_run_at"] == int((NOW - timedelta(minutes=0)).timestamp())
    assert d["ui"] == {"warn_percent": 70, "danger_percent": 90}
    assert d["config_error"] is None
    assert d["candidates"] == [{"suggested_id": "z", "config_dir": "~/x/z"}]
    a, b, c = d["accounts"]
    assert [x["id"] for x in d["accounts"]] == ["a", "b", "c"]

    assert a["status"] == "ok" and a["plan"] == "max" and a["color"] == "#112233"
    assert a["interval_minutes"] == 10 and a["stale"] is False and a["last_ok"] is None
    assert [lim["kind"] for lim in a["limits"]] == ["session", "weekly_all"]
    sess = a["limits"][0]
    assert sess["percent"] == 40 and sess["resets_at"] == int((NOW + timedelta(hours=2)).timestamp())
    assert sess["pace"]["elapsed_ratio"] == 0.6
    # 直近 30 分で 10%→40%（1%/分）→ あと 60 分で上限。リセット（2 時間後）より前
    assert sess["pace"]["eta_full"] == int((NOW + timedelta(minutes=60)).timestamp())
    assert a["hints"][0]["kind"] == "will_hit_limit"

    assert b["status"] == "logged_out" and b["limits"] == [] and b["hints"] == []
    assert b["plan"] == "max"  # account_meta の最後のプラン
    assert b["last_ok"]["taken_at"] == int((NOW - timedelta(hours=2)).timestamp())
    assert b["last_ok"]["limits"][1]["percent"] == 20
    assert b["interval_minutes"] == 5
    assert b["stale"] is True  # 1 時間前 > 5 分 × 3

    assert c["status"] == "never" and c["enabled"] is False and c["next_run_at"] is None
    assert c["color"].startswith("#") and c["login"] is None


# ---------------------------------------------------------------- history / windows


def test_history_and_windows(env):
    client, svc, *_ = env
    for i in range(3):
        save(svc.store, reading("a", NOW - timedelta(hours=3) + timedelta(minutes=10 * i), weekly=10 + i))
    save(svc.store, reading("b", NOW - timedelta(hours=1), status=Status.LOGGED_OUT))
    d = client.get("/api/history?range=24h").json()
    assert d["until"] == int(NOW.timestamp()) and d["since"] == d["until"] - 86400
    kinds = {(s["account_id"], s["kind"]) for s in d["series"]}
    assert kinds == {("a", "session"), ("a", "weekly_all")}
    weekly = next(s for s in d["series"] if s["kind"] == "weekly_all")
    assert [p[1] for p in weekly["segments"][0]["points"]] == [10, 11, 12]
    assert d["errors"] == [{"account_id": "b", "t": int((NOW - timedelta(hours=1)).timestamp()), "status": "logged_out"}]
    assert set(d) == {"since", "until", "series", "resets", "gaps", "errors"}

    d = client.get("/api/history?kinds=weekly_all&accounts=a").json()
    assert [s["kind"] for s in d["series"]] == ["weekly_all"]
    assert d["until"] - d["since"] == 7 * 86400

    r = client.get("/api/history?range=1y")
    assert r.status_code == 422 and "error" in r.json()

    w = client.get("/api/windows?kind=weekly_all&limit=8").json()
    assert w["kind"] == "weekly_all"
    assert w["rows"][0]["account_id"] == "a" and w["rows"][0]["windows"][0]["peak_percent"] == 12
    assert client.get("/api/windows?limit=0").status_code == 422


# ---------------------------------------------------------------- refresh / Origin


def test_refresh(env):
    client, svc, *_ = env
    r = client.post("/api/refresh", json={"account_id": "a"})
    assert r.status_code == 202 and r.json()["started"] == ["a"]
    r = client.post("/api/refresh")
    assert r.status_code == 202 and svc.scheduler.refreshed == ["a", None]
    r = client.post("/api/refresh", json={"account_id": "nope"})
    assert r.status_code == 404 and "error" in r.json()


def test_origin_check(env):
    client, svc, *_ = env
    r = client.post("/api/refresh", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and r.json()["error"]
    r = client.put("/api/config", json={}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    # Host と同じオリジンは許可（TestClient の Host は testserver）
    assert client.post("/api/refresh", headers={"Origin": "http://testserver"}).status_code == 202
    # tailscale serve 経由（https・ポートなし）でも Host が同じなら許可
    r = client.post("/api/refresh", headers={"Origin": "https://pc.example.ts.net", "Host": "pc.example.ts.net"})
    assert r.status_code == 202
    # GET は確認しない
    assert client.get("/api/state", headers={"Origin": "http://evil.example"}).status_code == 200


# ---------------------------------------------------------------- config


def test_config_get_put(env):
    client, svc, cfg_path, _ = env
    d = client.get("/api/config").json()
    assert d["config"]["accounts"][0]["id"] == "a"
    assert d["error"] is None and d["candidates"][0]["suggested_id"] == "z"
    assert d["path"].endswith("config.toml")

    cfg = d["config"]
    cfg["accounts"][0]["label"] = "Aさん"
    r = client.put("/api/config", json={"config": cfg, "hash": d["hash"]})
    assert r.status_code == 200, r.text
    new_hash = r.json()["hash"]
    assert "restart_required" not in r.json()
    text = cfg_path.read_text(encoding="utf-8")
    assert 'label = "Aさん"' in text and "# 手書きのメモ" in text  # コメントは残る
    assert svc.scheduler.configs[-1].accounts[0].label == "Aさん"  # すぐ反映
    assert client.get("/api/config").json()["hash"] == new_hash

    # 409: 古い hash
    r = client.put("/api/config", json={"config": cfg, "hash": d["hash"]})
    assert r.status_code == 409
    assert r.json() == {"error": "設定ファイルが外部で変更されました", "hash": new_hash}

    # 422: 検証エラー
    cfg["accounts"][0]["color"] = "red"
    r = client.put("/api/config", json={"config": cfg, "hash": new_hash})
    assert r.status_code == 422
    assert r.json()["fields"] == [["accounts.0.color", "色は #rrggbb の形式で指定してください"]]
    r = client.put("/api/config", json={"hash": new_hash})
    assert r.status_code == 422 and r.json()["error"] == "入力内容に誤りがあります"

    # ポートの変更は再起動が必要
    cfg["accounts"][0]["color"] = "#112233"
    cfg["server"]["port"] = 9999
    r = client.put("/api/config", json={"config": cfg, "hash": new_hash})
    assert r.status_code == 200 and r.json()["restart_required"] is True


# ---------------------------------------------------------------- 接続テスト / ログイン


def test_account_test_does_not_save(env):
    client, svc, *_ = env
    r = client.post("/api/accounts/test", json={"config_dir": "~/x/new"})
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "ok" and d["plan"] == "max" and d["limits"][0]["percent"] == 6
    assert d["limits"][0]["pace"] is not None
    assert svc.store.latest() == {}  # 保存しない
    assert client.post("/api/accounts/test", json={}).status_code == 422


def test_login(env):
    client, svc, *_ = env
    r = client.post("/api/accounts/b/login")
    assert r.status_code == 202 and r.json()["login"]["state"] == "waiting"
    (acc,) = svc.login.started
    assert acc.id == "b" and acc.config_dir.name == "b"
    assert client.post("/api/accounts/zzz/login").status_code == 404


# ---------------------------------------------------------------- 静的配信


def test_static(env):
    client, _, _, static = env
    r = client.get("/")
    assert r.status_code == 200 and "ccsmoni" in r.text  # index.html が無くても起動する
    (static / "index.html").write_text("<html>ui</html>", encoding="utf-8")
    assert client.get("/").text == "<html>ui</html>"
    assert client.get("/app.js").text == "console.log(1)"
    assert client.get("/static/app.js").text == "console.log(1)"
    r = client.get("/api/nothing")
    assert r.status_code == 404 and "error" in r.json()


def test_config_broken_file_can_be_overwritten(env):
    client, svc, cfg_path, _ = env
    good = client.get("/api/config").json()
    cfg_path.write_text(CONFIG.replace('color = "#112233"', 'color = "red"'), encoding="utf-8")
    assert svc.config_service.poll() is None and svc.config_service.last_error  # 壊れた → 最後に有効な設定で動き続ける
    d = client.get("/api/config").json()
    assert d["error"] and d["config"] == good["config"] and d["hash"] != good["hash"]
    assert client.get("/api/state").json()["config_error"]
    r = client.put("/api/config", json={"config": d["config"], "hash": d["hash"]})
    assert r.status_code == 200
    assert 'color = "#112233"' in cfg_path.read_text(encoding="utf-8")
