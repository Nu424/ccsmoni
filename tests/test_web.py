"""web（FastAPI）のテスト。Scheduler・LoginService・Probe は偽物、設定と DB は tmp_path / メモリ上。

TestClient の既定の Host（testserver）は Host の確認で拒否されるので、base_url を 127.0.0.1:8484 にする。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import warnings

import pytest

with warnings.catch_warnings():
    # starlette が httpx の利用を非推奨と警告するが、テストでは dev 依存の httpx で十分
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

from ccsmoni.config import PALETTE, ConfigService
from ccsmoni.model import Limit, RawResult, Reading, Status
from ccsmoni.parser_usage import UsageTextParser
from ccsmoni.probes.base import Probe
from ccsmoni.store import Store
from ccsmoni.web import Services, app_version, create_app, host_allowed

NOW = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
BASE = "http://127.0.0.1:8484"
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

[server]
allowed_hosts = ["mypc"]
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
        self.states: dict = {}

    def start(self, account):
        self.started.append(account)
        return {"state": "waiting", "started_at": int(NOW.timestamp()), "message": "PC 側にログイン画面を開きました"}

    def state(self, account_id):
        return self.states.get(account_id)

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
    with TestClient(app, base_url=BASE) as client:
        yield client, services, cfg_path, static
    store.close()


# ---------------------------------------------------------------- state


def test_state_shape(env):
    client, svc, *_ = env
    store = svc.store
    for i in range(7):
        save(store, reading("a", NOW - timedelta(minutes=60 - 10 * i), session=10 + 10 * i))
    save(store, reading("b", NOW - timedelta(hours=2), weekly=20))
    save(store, reading("b", NOW - timedelta(hours=1), status=Status.LOGGED_OUT))
    save(store, reading("c", NOW - timedelta(days=3)))  # 無効なアカウントの古い値
    save(store, reading("old", NOW - timedelta(days=2)))  # 設定から消したアカウント
    svc.login.states["b"] = {"state": "done", "started_at": 1, "finished_at": 2, "message": "ログインしました"}

    d = client.get("/api/state").json()
    assert d["now"] == int(NOW.timestamp())
    assert d["collector"]["busy"] == []
    assert d["collector"]["last_run_at"] == int((NOW - timedelta(minutes=0)).timestamp())
    assert d["ui"] == {"warn_percent": 70, "danger_percent": 90, "tiles_per_page": 6}
    assert d["palette"] == PALETTE
    assert d["config_error"] is None
    assert d["candidates"] == [{"suggested_id": "z", "config_dir": "~/x/z"}]
    a, b, c = d["accounts"]
    assert [x["id"] for x in d["accounts"]] == ["a", "b", "c"]

    assert a["status"] == "ok" and a["plan"] == "max" and a["color"] == "#112233" and a["color_slot"] is None
    assert a["interval_minutes"] == 10 and a["stale"] is False and a["last_ok"] is None
    assert [lim["kind"] for lim in a["limits"]] == ["session", "weekly_all"]
    sess = a["limits"][0]
    assert sess["percent"] == 70 and sess["resets_at"] == int((NOW + timedelta(hours=2)).timestamp())
    assert sess["pace"]["elapsed_ratio"] == 0.6
    # 直近 1 時間で 10%→70%（1%/分）→ あと 30 分で上限。リセット（2 時間後）より前
    # （5h 枠は直近 1 時間分の履歴がそろったときだけ直近の速度を使う。平均速度なら約 77 分後）
    assert sess["pace"]["eta_full"] == int((NOW + timedelta(minutes=30)).timestamp())
    assert a["hints"][0]["kind"] == "will_hit_limit"

    assert b["status"] == "logged_out" and b["limits"] == [] and b["hints"] == []
    assert b["plan"] == "max"  # account_meta の最後のプラン
    assert b["last_ok"]["taken_at"] == int((NOW - timedelta(hours=2)).timestamp())
    assert b["last_ok"]["limits"][1]["percent"] == 20
    assert b["interval_minutes"] == 5
    assert b["stale"] is True  # 1 時間前 > 5 分 × 3

    assert b["login"]["finished_at"] == 2

    assert c["status"] == "ok" and c["enabled"] is False and c["next_run_at"] is None
    assert c["stale"] is False  # 無効なアカウントは古くても stale にしない
    assert (c["color_slot"], c["color"]) == (2, None) and c["login"] is None
    assert (b["color_slot"], b["color"]) == (1, None)  # 未設定の色は並び順の番号（独自の色でなければ color は null）

    # 設定にないが履歴はあるアカウント。色は設定のアカウントが使っていない色から
    assert d["archived"] == [{"id": "old", "label": "old", "color_slot": 0, "color": None}]
    assert d["config_hash"] == svc.config_service.file_hash()


def test_state_status_since_and_weekly_peaks(env):
    client, svc, *_ = env
    store = svc.store
    # b: ok → ログイン切れが2回続く。開始は「最初の ok 以外」
    save(store, reading("b", NOW - timedelta(hours=3)))
    save(store, reading("b", NOW - timedelta(hours=2), status=Status.LOGGED_OUT))
    save(store, reading("b", NOW - timedelta(hours=1), status=Status.LOGGED_OUT))
    # a: 一度 ng → 復旧して ok。いまは ok なので null
    save(store, reading("a", NOW - timedelta(hours=2), status=Status.LOGGED_OUT))
    save(store, reading("a", NOW - timedelta(hours=1)))
    a, b, c = client.get("/api/state").json()["accounts"]
    assert a["status_since"] is None and b["status_since"] == int((NOW - timedelta(hours=2)).timestamp())
    assert c["status"] == "never" and c["status_since"] is None
    # 一度も ok がなければ最初の取得から
    save(store, reading("c", NOW - timedelta(hours=5), status=Status.ERROR))
    save(store, reading("c", NOW - timedelta(hours=4), status=Status.TIMEOUT))
    c = client.get("/api/state").json()["accounts"][2]
    assert c["status_since"] == int((NOW - timedelta(hours=5)).timestamp())


def test_state_weekly_peaks(env):
    client, svc, *_ = env
    for w in range(8):  # 8週ぶん。最後の1つがいまの枠
        at = NOW - timedelta(weeks=7 - w)
        save(svc.store, Reading("a", at, "cli-usage", Status.OK,
                                (Limit("weekly_all", "Current week (all models)", 10.0 + w, at + timedelta(days=3)),),
                                extras={"plan": "max"}))
    save(svc.store, reading("b", NOW - timedelta(hours=2)))
    save(svc.store, reading("b", NOW - timedelta(hours=1), status=Status.LOGGED_OUT))
    a, b, c = client.get("/api/state").json()["accounts"]
    peaks = a["weekly_peaks"]
    assert [p["peak_percent"] for p in peaks] == [12, 13, 14, 15, 16, 17]  # 直近6枠、古い順
    assert [p["current"] for p in peaks] == [False] * 5 + [True]
    assert peaks[-1]["resets_at"] == int((NOW + timedelta(days=3)).timestamp())
    assert set(peaks[0]) == {"resets_at", "peak_percent", "current"}
    # ok でない b は今の limits が無いので current なし。履歴が無い c は空
    assert len(b["weekly_peaks"]) == 1 and b["weekly_peaks"][0]["current"] is False
    assert c["weekly_peaks"] == []


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


def test_history_since_until(env):
    client, svc, *_ = env
    t0 = NOW - timedelta(days=10)
    for i in range(3):  # 10日前に3点
        save(svc.store, reading("a", t0 + timedelta(minutes=10 * i), weekly=10 + i))
    save(svc.store, reading("a", NOW - timedelta(hours=1)))  # 範囲の外
    save(svc.store, reading("b", t0 + timedelta(minutes=5), status=Status.LOGGED_OUT))
    since, until = int((t0 - timedelta(hours=1)).timestamp()), int((t0 + timedelta(hours=1)).timestamp())
    d = client.get(f"/api/history?since={since}&until={until}&range=24h").json()  # range より優先
    assert (d["since"], d["until"]) == (since, until)
    weekly = next(s for s in d["series"] if s["account_id"] == "a" and s["kind"] == "weekly_all")
    assert [p[1] for seg in weekly["segments"] for p in seg["points"]] == [10, 11, 12]
    assert d["errors"] == [{"account_id": "b", "t": int((t0 + timedelta(minutes=5)).timestamp()), "status": "logged_out"}]
    # 範囲内の取得の抜けも、指定した範囲で数える
    save(svc.store, reading("a", t0 + timedelta(hours=3)))
    until2 = int((t0 + timedelta(hours=4)).timestamp())
    d = client.get(f"/api/history?since={since}&until={until2}").json()
    assert d["gaps"] == [{"account_id": "a", "from": int((t0 + timedelta(minutes=20)).timestamp()),
                          "to": int((t0 + timedelta(hours=3)).timestamp())}]
    # ちょうど120日は通り、超えれば422。since >= until・片方だけ・範囲外の値も422
    end = int(NOW.timestamp())
    assert client.get(f"/api/history?since={end - 120 * 86400}&until={end}").status_code == 200
    for q in (f"since={end - 120 * 86400 - 1}&until={end}", f"since={end}&until={end}", f"since={end + 1}&until={end}",
              f"since={end - 100}", f"until={end}", "since=-5&until=10", "since=0&until=99999999999", "since=a&until=b"):
        r = client.get(f"/api/history?{q}")
        assert r.status_code == 422 and "error" in r.json(), q


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
    # Host と同じオリジンは許可
    assert client.post("/api/refresh", headers={"Origin": BASE}).status_code == 202
    # tailscale serve 経由（https・ポートなし）でも Host が同じなら許可
    r = client.post("/api/refresh", headers={"Origin": "https://pc.example.ts.net", "Host": "pc.example.ts.net"})
    assert r.status_code == 202
    # Origin が許可リストにあっても、Host と違えば拒否（別のポートで動く別のページなど）
    r = client.post("/api/refresh", headers={"Origin": "http://127.0.0.1:9999"})
    assert r.status_code == 403
    # X-Forwarded-Host は信頼しない（以前は X-Forwarded-Host と一致すれば通っていた）
    r = client.post("/api/refresh", headers={"Origin": "http://evil.example", "X-Forwarded-Host": "evil.example"})
    assert r.status_code == 403
    # Origin: null（サンドボックスの iframe など）は拒否
    assert client.post("/api/refresh", headers={"Origin": "null"}).status_code == 403
    # GET は Origin を確認しない（Host は確認する）
    assert client.get("/api/state", headers={"Origin": "http://evil.example"}).status_code == 200


def test_host_check_blocks_dns_rebinding(env):
    client, *_ = env
    # 攻撃者のドメインを 127.0.0.1 に向け直しても、Host が evil.example なら GET も含めて拒否する
    for path in ("/api/state", "/api/config", "/api/health", "/", "/app.js"):
        r = client.get(path, headers={"Host": "evil.example"})
        assert r.status_code == 403, path
        assert r.json()["error"] == "許可されていないホストへのリクエストです"
    assert client.post("/api/refresh", headers={"Host": "evil.example:8484"}).status_code == 403
    # X-Forwarded-Host を付けても通らない
    r = client.get("/api/state", headers={"Host": "evil.example", "X-Forwarded-Host": "127.0.0.1:8484"})
    assert r.status_code == 403
    # 許可するもの: ループバック（ポートは問わない）・*.ts.net・設定の allowed_hosts
    for host in ("127.0.0.1", "localhost:8484", "[::1]:8484", "pc.tail1234.ts.net", "MyPC:8484"):
        assert client.get("/api/health", headers={"Host": host}).status_code == 200, host
    for host in ("ts.net.evil.example", "evil-ts.net", "127.0.0.1.evil.example", ""):
        assert not host_allowed(host, ["mypc"]), host


def test_health(env):
    client, *_ = env
    assert client.get("/api/health").json() == {"app": "ccsmoni", "version": app_version()}


# ---------------------------------------------------------------- config


def test_config_get_put(env):
    client, svc, cfg_path, _ = env
    save(svc.store, reading("old", NOW))
    save(svc.store, reading("a", NOW))
    d = client.get("/api/config").json()
    assert d["config"]["accounts"][0]["id"] == "a"
    assert d["error"] is None and d["candidates"][0]["suggested_id"] == "z"
    assert d["path"].endswith("config.toml")
    assert d["palette"] == PALETTE
    assert "colors" not in d
    assert d["slots"] == {
        "a": {"color_slot": None, "color": "#112233"},
        "b": {"color_slot": 1, "color": None},
        "c": {"color_slot": 2, "color": None},
    }
    assert d["history_ids"] == ["a", "old"]
    assert d["readonly"] == {"claude_path": "claude", "host": "127.0.0.1", "port": 8484}

    cfg = d["config"]
    cfg["accounts"][0]["label"] = "Aさん"
    r = client.put("/api/config", json={"config": cfg, "hash": d["hash"]})
    assert r.status_code == 200, r.text
    new_hash = r.json()["hash"]
    assert r.json() == {"hash": new_hash, "removed_keys": [], "backup_path": None}
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
    assert r.json()["fields"] == [["accounts.0.color", "色は 0〜6 の番号か #rrggbb の形式で指定してください"]]
    r = client.put("/api/config", json={"hash": new_hash})
    assert r.status_code == 422 and r.json()["error"] == "入力内容に誤りがあります"

    # claude_path・host・port は Web から変えられない（ファイルでだけ編集する）
    cfg["accounts"][0]["color"] = "#112233"
    cfg["ui"]["tiles_per_page"] = 5
    r = client.put("/api/config", json={"config": cfg, "hash": new_hash})
    assert r.status_code == 422 and r.json()["fields"][0][0] == "ui.tiles_per_page"
    cfg["ui"]["tiles_per_page"] = 6
    for sec, key, value in (("collector", "claude_path", "C:/evil/claude.exe"), ("collector", "claude_path", "calc.exe"),
                            ("server", "host", "0.0.0.0"), ("server", "port", 9999)):
        bad = {**cfg, sec: {**cfg[sec], key: value}}
        r = client.put("/api/config", json={"config": bad, "hash": new_hash})
        assert r.status_code == 422, (key, value)
        assert r.json() == {"error": "この項目は設定ファイルで編集してください",
                            "fields": [[f"{sec}.{key}", "この項目は設定ファイルで編集してください"]]}
    assert "evil" not in cfg_path.read_text(encoding="utf-8")
    # 省略したら今の値のまま（UI が readonly の項目を送らなくてもよい）
    partial = {**cfg, "collector": {k: v for k, v in cfg["collector"].items() if k != "claude_path"},
               "server": {"allowed_hosts": ["mypc", "other"]}}
    r = client.put("/api/config", json={"config": partial, "hash": new_hash})
    assert r.status_code == 200, r.text
    assert svc.config_service.current.server.port == 8484
    assert svc.config_service.current.server.allowed_hosts == ["mypc", "other"]


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


def test_account_test_runs_one_at_a_time(env):
    client, svc, *_ = env
    rt = client.app.state.runtime
    rt.testing = True  # 別の接続テストが実行中
    r = client.post("/api/accounts/test", json={"config_dir": "~/x/new"})
    assert r.status_code == 429 and r.json() == {"error": "接続テストを実行中です"}
    rt.testing = False
    assert client.post("/api/accounts/test", json={"config_dir": "~/x/new"}).status_code == 200
    assert rt.testing is False  # 終わったら次を受け付ける


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
    assert r.json()["backup_path"] is None


def test_config_syntax_error_is_fixed_by_saving(env):
    client, svc, cfg_path, _ = env
    good = client.get("/api/config").json()
    cfg_path.write_text("[collector\nbroken", encoding="utf-8")
    svc.config_service.poll()
    st = client.get("/api/state").json()
    assert st["config_error"] and st["config_hash"] != good["hash"]  # 設定画面が外部の変更に気づける
    d = client.get("/api/config").json()
    assert d["hash"] == st["config_hash"]
    r = client.put("/api/config", json={"config": d["config"], "hash": d["hash"]})
    assert r.status_code == 200, r.text
    backup = r.json()["backup_path"]
    assert backup and "config.toml.broken-" in backup
    (b,) = cfg_path.parent.glob("config.toml.broken-*")
    assert b.read_text(encoding="utf-8") == "[collector\nbroken"
    assert "取得間隔（分）" in cfg_path.read_text(encoding="utf-8")  # 初期生成と同じ体裁で書き直した
    assert client.get("/api/state").json()["config_error"] is None
    assert client.get("/api/config").json()["config"] == good["config"]


def test_config_unknown_keys_are_removed_on_save(env):
    client, svc, cfg_path, _ = env
    d = client.get("/api/config").json()
    cfg_path.write_text(CONFIG.replace("default_interval_minutes = 10", "default_interval_minutes = 10\ntypo = 1"),
                        encoding="utf-8")
    svc.config_service.poll()
    h = client.get("/api/config").json()["hash"]
    r = client.put("/api/config", json={"config": d["config"], "hash": h})
    assert r.status_code == 200 and r.json()["removed_keys"] == ["collector.typo"]
    assert "typo" not in cfg_path.read_text(encoding="utf-8")


def test_config_missing_file_keeps_last_valid(env):
    client, svc, cfg_path, _ = env
    cfg_path.unlink()
    assert svc.config_service.poll() is None
    st = client.get("/api/state").json()
    assert "見つかりません" in st["config_error"] and len(st["accounts"]) == 3
