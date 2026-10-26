"""ConfigService のテスト。すべて tmp_path の中で完結させる（実環境のパスに触れない）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from ccsmoni.config import (
    PALETTE,
    AppConfig,
    ConfigConflictError,
    ConfigService,
    ConfigValidationError,
    app_home,
    readonly_errors,
    resolve_colors,
    short_path,
)

HAND_WRITTEN = """\
# 手書きのメモ: 先頭
[collector]
default_interval_minutes = 10  # 行末メモ
discover_roots = []

[ui]
warn_percent = 70
danger_percent = 90

# 一つ目のアカウントのメモ
[[accounts]]
id = "a1"
label = "first"
config_dir = "~/x/a1"
color = "#112233"  # 色メモ

# 二つ目のアカウントのメモ
[[accounts]]
id = "a2"
label = "second"
config_dir = "~/x/a2"
"""


@pytest.fixture
def svc(tmp_path: Path) -> ConfigService:
    return ConfigService(tmp_path / "config.toml")


def write(svc: ConfigService, text: str) -> None:
    svc.path.write_text(text, encoding="utf-8", newline="\n")


def test_app_home_env(monkeypatch, tmp_path):
    monkeypatch.setenv("CCSMONI_HOME", str(tmp_path / "h"))
    assert app_home() == tmp_path / "h"


def test_initial_generation_discovers(tmp_path):
    roots = tmp_path / "roots"
    (roots / ".conf one").mkdir(parents=True)
    (roots / ".conf one" / ".credentials.json").write_text("{}")
    (roots / "plain").mkdir()
    (roots / "node_modules" / "deep").mkdir(parents=True)
    (roots / "node_modules" / "deep" / ".claude.json").write_text("{}")
    svc = ConfigService(tmp_path / "home" / "config.toml", discover_roots=[str(roots)])
    loaded, _ = svc.load()  # ファイルが無いので初期生成される
    assert len(loaded.accounts) == 1  # node_modules の中には入らない
    a = loaded.accounts[0]
    assert a.id == "conf-one" and a.label == "conf-one" and a.color == 0
    assert a.expanded_dir() == roots / ".conf one"
    text = svc.path.read_text(encoding="utf-8")
    assert "取得間隔（分）" in text and "tiles_per_page = 6" in text and "1ページに並べるタイル" in text
    # 登録済みは候補から外れる
    assert svc.discover_candidates(loaded) == []


def test_initial_empty(tmp_path):
    (tmp_path / "empty").mkdir()
    svc = ConfigService(tmp_path / "config.toml", discover_roots=[str(tmp_path / "empty")])
    cfg, _ = svc.load()
    assert isinstance(cfg, AppConfig)
    assert cfg.interval_for("nope") == cfg.collector.default_interval_minutes


def test_save_keeps_comments(svc):
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    d = cfg.model_dump()
    d["accounts"][0]["label"] = "renamed"
    d["collector"]["default_interval_minutes"] = 15
    h2 = svc.save(d, h).hash
    text = svc.path.read_text(encoding="utf-8")
    for s in ("手書きのメモ: 先頭", "行末メモ", "一つ目のアカウントのメモ", "二つ目のアカウントのメモ", "色メモ"):
        assert s in text
    cfg2, h3 = svc.load()
    assert h2 == h3
    assert cfg2.accounts[0].label == "renamed"
    assert cfg2.collector.default_interval_minutes == 15


def test_reorder_add_remove(svc):
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    d = cfg.model_dump()
    a1, a2 = d["accounts"]
    d["accounts"] = [a2, a1, {"id": "a3", "label": "third", "config_dir": "~/x/a3"}]
    h = svc.save(d, h).hash
    cfg, _ = svc.load()
    assert [a.id for a in cfg.accounts] == ["a2", "a1", "a3"]
    assert "色メモ" in svc.path.read_text(encoding="utf-8")

    d = cfg.model_dump()
    d["accounts"] = [x for x in d["accounts"] if x["id"] != "a2"]
    d["accounts"][0]["color"] = None  # None は項目ごと消える
    h = svc.save(d, h).hash
    cfg, _ = svc.load()
    assert [a.id for a in cfg.accounts] == ["a1", "a3"]
    assert cfg.accounts[0].color is None

    d = cfg.model_dump()
    d["accounts"] = []
    svc.save(d, h)
    assert svc.load()[0].accounts == []


def test_conflict(svc):
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    write(svc, HAND_WRITTEN + "\n# 外部の追記\n")
    assert svc.file_hash() != h
    with pytest.raises(ConfigConflictError):
        svc.save(cfg, h)


def test_validation_errors(svc):
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    base = cfg.model_dump()

    d = {**base, "accounts": [base["accounts"][0], base["accounts"][0]]}
    with pytest.raises(ConfigValidationError) as e:
        svc.save(d, h)
    assert "重複" in str(e.value)

    d = {**base, "ui": {"warn_percent": 90, "danger_percent": 90}}
    with pytest.raises(ConfigValidationError) as e:
        svc.save(d, h)
    assert "ui" in str(e.value)

    bad = dict(base["accounts"][0], color="red")
    with pytest.raises(ConfigValidationError) as e:
        svc.save({**base, "accounts": [bad]}, h)
    assert e.value.errors[0][0] == "accounts.0.color"
    assert "#rrggbb" in e.value.errors[0][1]

    # 色の番号は 0〜6 の整数。範囲外・bool・小数・番号を表す文字列は弾く
    for v in (7, -1, True, 1.5, "3"):
        with pytest.raises(ConfigValidationError) as e:
            svc.save({**base, "accounts": [dict(base["accounts"][0], color=v)]}, h)
        assert e.value.errors[0][0] == "accounts.0.color", v

    # tiles_per_page は 4/6/8/9/12 のどれか
    assert AppConfig().ui.tiles_per_page == 6
    for v in (5, 0, 13, 6.5):
        with pytest.raises(ConfigValidationError) as e:
            svc.save({**base, "ui": {"tiles_per_page": v}}, h)
        assert e.value.errors[0][0] == "ui.tiles_per_page", v
    for v in (4, 6, 8, 9, 12):
        assert AppConfig.model_validate({"ui": {"tiles_per_page": v}}).ui.tiles_per_page == v

    bad = dict(base["accounts"][0], id="bad id!")
    with pytest.raises(ConfigValidationError):
        svc.save({**base, "accounts": [bad]}, h)
    # 失敗してもファイルは変わらない
    assert svc.file_hash() == h


def test_active_accounts_and_interval(svc):
    write(svc, HAND_WRITTEN + "enabled = false\ninterval_minutes = 5\n")
    cfg, _ = svc.load()
    assert [a.id for a in cfg.active_accounts()] == ["a1"]
    assert cfg.interval_for("a2") == 5
    assert cfg.interval_for("a1") == 10


def test_poll(svc):
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    assert svc.poll() is None

    write(svc, HAND_WRITTEN.replace('"first"', '"changed"'))
    new = svc.poll()
    assert new is not None and new.accounts[0].label == "changed"
    assert svc.poll() is None

    write(svc, "[collector\nbroken")
    assert svc.poll() is None
    assert svc.last_error
    write(svc, HAND_WRITTEN.replace("warn_percent = 70", "warn_percent = 95"))
    assert svc.poll() is None
    assert "ui" in svc.last_error
    # 直ったら復帰
    write(svc, HAND_WRITTEN)
    assert svc.poll() is not None
    assert svc.last_error is None


# ---------------------------------------------------------------- 起動するコマンド・待ち受け先の制限


@pytest.mark.parametrize("path", ["claude", "claude.exe", r"C:\tools\Claude.CMD", "/usr/local/bin/claude", "~/bin/claude"])
def test_claude_path_accepts_claude_only(path):
    assert AppConfig.model_validate({"collector": {"claude_path": path}}).collector.claude_path == path


@pytest.mark.parametrize(
    "path", ["evil.exe", "cmd", "claude-evil.exe", "claude.exe.bat", r"\\server\share\claude.exe", "//server/share/claude", ""]
)
def test_claude_path_rejects_others(path):
    with pytest.raises(ValueError):
        AppConfig.model_validate({"collector": {"claude_path": path}})


def test_server_host_loopback_only_and_allowed_hosts():
    for h in ("127.0.0.1", "::1", "localhost", "LocalHost"):
        AppConfig.model_validate({"server": {"host": h}})
    for h in ("0.0.0.0", "192.168.1.2", "example.com", "::"):
        with pytest.raises(ValueError):
            AppConfig.model_validate({"server": {"host": h}})
    cfg = AppConfig.model_validate({"server": {"allowed_hosts": ["MyPC", "pc.lan", "[::1]"]}})
    assert cfg.server.allowed_hosts == ["mypc", "pc.lan", "[::1]"]
    for bad in ("pc:8484", "*.example", "http://pc", ""):
        with pytest.raises(ValueError):
            AppConfig.model_validate({"server": {"allowed_hosts": [bad]}})


def test_readonly_errors_fill_and_detect():
    cur = AppConfig.model_validate({"collector": {"claude_path": "C:/x/claude.exe"}, "server": {"port": 9000}})
    new = {"collector": {"default_interval_minutes": 5}, "ui": {}}
    assert readonly_errors(new, cur) == []
    assert new["collector"]["claude_path"] == "C:/x/claude.exe" and new["server"] == {"host": "127.0.0.1", "port": 9000}
    new = cur.model_dump()
    new["collector"]["claude_path"] = "claude"
    new["server"]["port"] = 9001
    assert readonly_errors(new, cur) == [
        ("collector.claude_path", "この項目は設定ファイルで編集してください"),
        ("server.port", "この項目は設定ファイルで編集してください"),
    ]


# ---------------------------------------------------------------- 保存で壊れたファイルを残さない


def test_save_removes_unknown_keys_in_known_sections(svc):
    write(svc, HAND_WRITTEN)
    cfg, _ = svc.load()
    # 手で綴りを間違えた（検証に通らない）ファイル → poll は失敗し、画面からの保存で直す
    write(svc, HAND_WRITTEN.replace("discover_roots = []", "discover_roots = []\ntypo_key = 1").replace(
        'color = "#112233"  # 色メモ', 'color = "#112233"  # 色メモ\ncolour = "red"'))
    assert svc.poll() is None and "typo_key" in svc.last_error
    r = svc.save(cfg.model_dump(), svc.file_hash())
    assert r.removed_keys == ["collector.typo_key", "accounts.0.colour"]
    assert r.backup_path is None
    text = svc.path.read_text(encoding="utf-8")
    assert "typo_key" not in text and "colour" not in text and "色メモ" in text
    assert svc.load()[0] == cfg  # 保存したファイルは読み込みでも通る


def test_save_refuses_when_written_file_would_not_validate(svc):
    write(svc, HAND_WRITTEN + "\n[unknown_section]\nx = 1\n")
    cfg = AppConfig.model_validate({"collector": {"discover_roots": []}})
    h = svc.file_hash()
    with pytest.raises(ConfigValidationError) as e:
        svc.save(cfg, h)
    assert e.value.errors[0][0] == "unknown_section"
    assert svc.file_hash() == h  # 置き換えていない


def test_save_rechecks_hash_just_before_replace(tmp_path):
    class Racy(ConfigService):
        race = False

        def _parse(self, data):
            out = super()._parse(data)
            if self.race:  # 書き出す内容の検証中に、外部でファイルが変わった
                self.race = False
                self.path.write_text(HAND_WRITTEN + "# 外部の変更\n", encoding="utf-8")
            return out

    svc = Racy(tmp_path / "config.toml")
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    svc.race = True
    with pytest.raises(ConfigConflictError):
        svc.save(cfg, h)
    assert "外部の変更" in svc.path.read_text(encoding="utf-8")  # 外部の変更を上書きしない
    assert not list(tmp_path.glob("*.tmp"))


def test_save_over_syntax_error_backs_up_and_regenerates(svc):
    write(svc, HAND_WRITTEN)
    cfg, _ = svc.load()
    write(svc, "[collector\nbroken = ")
    assert svc.poll() is None and svc.last_error
    r = svc.save(cfg, svc.file_hash())
    assert r.backup_path is not None and r.backup_path.name.startswith("config.toml.broken-")
    assert r.backup_path.read_text(encoding="utf-8") == "[collector\nbroken = "
    text = svc.path.read_text(encoding="utf-8")
    assert "取得間隔（分）" in text  # 初期生成と同じコメント付きの体裁
    assert svc.load()[0] == cfg and svc.last_error is None


def test_save_over_missing_or_empty_file_writes_initial_layout(svc):
    write(svc, HAND_WRITTEN)
    cfg, _ = svc.load()
    svc.path.unlink()
    r = svc.save(cfg, svc.file_hash())
    assert r.backup_path is None and "取得間隔（分）" in svc.path.read_text(encoding="utf-8")
    assert svc.load()[0] == cfg


# ---------------------------------------------------------------- 空・存在しない設定ファイル


def test_poll_treats_missing_and_empty_file_as_error(svc):
    write(svc, HAND_WRITTEN)
    cfg, _ = svc.load()
    write(svc, "   \n")
    assert svc.poll() is None and "空" in svc.last_error
    assert svc.current == cfg  # 最後に有効だった設定を保つ
    svc.path.unlink()
    assert svc.poll() is None and "見つかりません" in svc.last_error
    assert svc.current == cfg
    write(svc, HAND_WRITTEN)
    assert svc.poll() is None and svc.last_error is None  # 元の内容に戻った


def test_load_regenerates_empty_file(tmp_path):
    svc = ConfigService(tmp_path / "config.toml", discover_roots=[])
    write(svc, "")
    svc.load()
    assert "取得間隔（分）" in svc.path.read_text(encoding="utf-8")


# ---------------------------------------------------------------- 色・パス表記


def _accts(*colors):
    return AppConfig.model_validate({"accounts": [
        {"id": f"a{i}", "label": "x", "config_dir": "x", **({} if c is None else {"color": c})}
        for i, c in enumerate(colors)
    ]}).accounts


def test_palette_shape():
    assert len(PALETTE["light"]) == len(PALETTE["dark"]) == 7
    assert all(len(c) == 7 and c.startswith("#") for c in PALETTE["light"] + PALETTE["dark"])


def test_resolve_colors_auto_slot_hex():
    # 自動は並び順の番号。hex は (None, hex)、整数はその番号（色は None）
    colors = resolve_colors(_accts("#4F8CFF", None, None, 5))
    assert colors["a0"] == (None, "#4F8CFF")
    assert colors["a1"] == (1, None) and colors["a2"] == (2, None)
    assert colors["a3"] == (5, None)
    # 全部自動なら 0,1,2,...。7件を超えたら巡回して重複を許す
    colors = resolve_colors(_accts(*[None] * 9))
    assert [colors[f"a{i}"][0] for i in range(9)] == [0, 1, 2, 3, 4, 5, 6, 0, 1]


def test_resolve_colors_avoids_explicit_slots():
    # 後ろのアカウントが明示した番号も、先の自動は避ける。次の空き番号（巡回）にずらす
    colors = resolve_colors(_accts(None, None, 1, 0))
    assert colors["a2"] == (1, None) and colors["a3"] == (0, None)
    assert colors["a0"] == (2, None) and colors["a1"] == (3, None)
    # 明示の番号が6のとき、自動は 6 を避けて 0〜5 を使う
    colors = resolve_colors(_accts(6, None, None, None, None, None, None))
    assert colors["a0"] == (6, None)
    assert sorted(colors[f"a{i}"][0] for i in range(1, 7)) == [0, 1, 2, 3, 4, 5]


def test_resolve_colors_archived():
    accounts = _accts(0, None, "#112233")  # 使用中の番号: 0 と 自動の 1
    colors = resolve_colors(accounts, ["z", "y", "a0"])
    assert colors["a1"] == (1, None)
    # アーカイブは id の昇順に、設定のアカウントが使っていない番号から（2,3,...）。設定にある a0 は対象外
    assert colors["y"] == (2, None) and colors["z"] == (3, None)
    assert resolve_colors(accounts, ["z", "y"]) == colors  # 決定的
    # 番号が全部使われていれば全体から
    full = resolve_colors(_accts(0, 1, 2, 3, 4, 5, 6), ["q", "p"])
    assert full["p"] == (0, None) and full["q"] == (1, None)


def test_color_int_roundtrip_in_toml(tmp_path):
    svc = ConfigService(tmp_path / "config.toml", discover_roots=[])
    write(svc, HAND_WRITTEN)
    cfg, h = svc.load()
    d = cfg.model_dump()
    d["accounts"][0]["color"] = 3
    svc.save(d, h)
    text = svc.path.read_text(encoding="utf-8")
    assert "color = 3" in text and '"3"' not in text  # 整数のまま保存される
    assert svc.load()[0].accounts[0].color == 3
    d = svc.current.model_dump()
    d["accounts"][0]["color"] = "#abcdef"
    svc.save(d, svc.current_hash)
    assert svc.load()[0].accounts[0].color == "#abcdef"


def test_short_path(tmp_path):
    assert short_path(Path.home() / "AppData" / "Local" / "ccsmoni" / "config.toml") == "~/AppData/Local/ccsmoni/config.toml"
    assert short_path(Path.home()) == "~"
    outside = Path(Path.home().anchor) / "definitely-outside-home-xyz"
    assert short_path(outside) == str(outside)
