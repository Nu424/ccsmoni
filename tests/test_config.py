"""ConfigService のテスト。すべて tmp_path の中で完結させる（実環境のパスに触れない）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from ccsmoni.config import (
    AppConfig,
    ConfigConflictError,
    ConfigService,
    ConfigValidationError,
    app_home,
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
    assert a.id == "conf-one" and a.label == "conf-one" and a.color == "#4f8cff"
    assert a.expanded_dir() == roots / ".conf one"
    assert "取得間隔（分）" in svc.path.read_text(encoding="utf-8")
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
    h2 = svc.save(d, h)
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
    h = svc.save(d, h)
    cfg, _ = svc.load()
    assert [a.id for a in cfg.accounts] == ["a2", "a1", "a3"]
    assert "色メモ" in svc.path.read_text(encoding="utf-8")

    d = cfg.model_dump()
    d["accounts"] = [x for x in d["accounts"] if x["id"] != "a2"]
    d["accounts"][0]["color"] = None  # None は項目ごと消える
    h = svc.save(d, h)
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
    assert svc.changed_since(h)
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

    bad = dict(base["accounts"][0], id="bad id!")
    with pytest.raises(ConfigValidationError):
        svc.save({**base, "accounts": [bad]}, h)
    # 失敗してもファイルは変わらない
    assert not svc.changed_since(h)


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
