"""設定サービス。

何を: config.toml の「読み込み → 検証 → 保存」と、未登録アカウント（Claude の設定フォルダ）の検出を担う。
なぜ: TOML ファイルを唯一の正にし、手で編集した場合も UI から保存した場合も同じ検証を通すため（PLAN §7.1）。
方針:
  - 検証は pydantic。保存は tomlkit で既存の文書を差分更新し、手書きのコメントや順序を保つ。
  - 競合は内容の sha256 で検出（楽観ロック）。書き込みは一時ファイル → os.replace でアトミックに。
  - 変更検知は単純な poll()。スレッドや asyncio には依存しない（呼び出し側が定期的に呼ぶ）。
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import tomlkit
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from tomlkit.items import AoT, Table

from ccsmoni.model import Account

# ---------------------------------------------------------------------------
# 置き場所
# ---------------------------------------------------------------------------


def app_home() -> Path:
    """データの置き場所。CCSMONI_HOME > %LOCALAPPDATA%\\ccsmoni > ~/.ccsmoni の順。リポジトリの外に置く。"""
    env = os.environ.get("CCSMONI_HOME")
    if env:
        return Path(env)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "ccsmoni"
    return Path.home() / ".ccsmoni"


def config_path() -> Path:
    return app_home() / "config.toml"


def db_path() -> Path:
    return app_home() / "ccsmoni.db"


# ---------------------------------------------------------------------------
# スキーマ
# ---------------------------------------------------------------------------

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class _Base(BaseModel):
    # 綴り間違いのキーを黙って捨てないよう、未知のキーは拒否する
    model_config = ConfigDict(extra="forbid")


class CollectorConfig(_Base):
    default_interval_minutes: int = Field(10, ge=1, le=1440)
    timeout_seconds: int = Field(30, ge=5, le=300)
    concurrency: int = Field(2, ge=1, le=8)
    claude_path: str = "claude"
    discover_roots: list[str] = Field(default_factory=lambda: ["~"])
    discover_depth: int = Field(2, ge=1, le=3)


class ServerConfig(_Base):
    host: str = "127.0.0.1"
    port: int = Field(8484, ge=1, le=65535)


class UiConfig(_Base):
    warn_percent: int = Field(70, ge=0, le=100)
    danger_percent: int = Field(90, ge=0, le=100)

    @model_validator(mode="after")
    def _warn_below_danger(self) -> UiConfig:
        if self.warn_percent >= self.danger_percent:
            raise ValueError("警告のしきい値は危険のしきい値より小さくしてください")
        return self


class AccountConfig(_Base):
    id: str
    label: str = Field(min_length=1)
    config_dir: str = Field(min_length=1)  # 書いたまま保存する（~ や環境変数を含んでよい）
    launch_command: str | None = None
    color: str | None = None
    interval_minutes: int | None = Field(None, ge=1, le=1440)  # None = 全体の既定値
    enabled: bool = True

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _ID_RE.match(v):
            raise ValueError("英数字・ハイフン・アンダースコアのみ、1〜40文字で指定してください")
        return v

    @field_validator("color")
    @classmethod
    def _check_color(cls, v: str | None) -> str | None:
        if v is not None and not _COLOR_RE.match(v):
            raise ValueError("色は #rrggbb の形式で指定してください")
        return v

    def expanded_dir(self) -> Path:
        """~ と環境変数を展開した実パス。"""
        return Path(os.path.expanduser(os.path.expandvars(self.config_dir)))


class AppConfig(_Base):
    collector: CollectorConfig = Field(default_factory=CollectorConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    ui: UiConfig = Field(default_factory=UiConfig)
    accounts: list[AccountConfig] = Field(default_factory=list)

    @field_validator("accounts")
    @classmethod
    def _unique_ids(cls, v: list[AccountConfig]) -> list[AccountConfig]:
        seen: set[str] = set()
        for a in v:
            if a.id in seen:
                raise ValueError(f"id「{a.id}」が重複しています")
            seen.add(a.id)
        return v

    def active_accounts(self) -> list[Account]:
        """有効なアカウントを Probe 用の形に変換する（並び順は設定のまま）。"""
        return [
            Account(id=a.id, label=a.label, config_dir=a.expanded_dir(), launch_command=a.launch_command)
            for a in self.accounts
            if a.enabled
        ]

    def interval_for(self, account_id: str) -> int:
        """そのアカウントの取得間隔（分）。個別指定がなければ全体の既定値。"""
        for a in self.accounts:
            if a.id == account_id and a.interval_minutes is not None:
                return a.interval_minutes
        return self.collector.default_interval_minutes


# ---------------------------------------------------------------------------
# エラー
# ---------------------------------------------------------------------------


class ConfigConflictError(Exception):
    """読み込み後にファイルが外部で変更されていた。"""

    def __init__(self) -> None:
        super().__init__("設定ファイルが外部で変更されました。読み込み直してください")


class ConfigValidationError(Exception):
    """検証失敗。errors は (フィールド名, 日本語の理由) のリスト。"""

    def __init__(self, errors: list[tuple[str, str]]) -> None:
        self.errors = errors
        super().__init__("\n".join(f"{f}: {m}" for f, m in errors))


_ERR_JA = {
    "missing": "必須項目です",
    "int_parsing": "整数で指定してください",
    "int_type": "整数で指定してください",
    "bool_parsing": "true / false で指定してください",
    "bool_type": "true / false で指定してください",
    "string_type": "文字列で指定してください",
    "list_type": "リストで指定してください",
    "extra_forbidden": "未知の項目です",
    "greater_than_equal": "値が小さすぎます",
    "less_than_equal": "値が大きすぎます",
    "string_too_short": "空にはできません",
    "string_too_long": "長すぎます",
}


def _to_validation_error(e: ValidationError) -> ConfigValidationError:
    out: list[tuple[str, str]] = []
    for err in e.errors():
        field = ".".join(str(p) for p in err["loc"]) or "(全体)"
        t = err["type"]
        if t == "value_error":
            msg = str(err["ctx"]["error"]) if err.get("ctx", {}).get("error") else err["msg"]
        elif t in ("greater_than_equal", "less_than_equal") and err.get("ctx"):
            msg = f"{_ERR_JA[t]}（{err['ctx'].get('ge', err['ctx'].get('le'))} が限度）"
        else:
            msg = _ERR_JA.get(t, err["msg"])
        out.append((field, msg))
    return ConfigValidationError(out)


def _validate(data: dict | AppConfig) -> AppConfig:
    if isinstance(data, AppConfig):
        data = data.model_dump()
    try:
        return AppConfig.model_validate(data)
    except ValidationError as e:
        raise _to_validation_error(e) from e


# ---------------------------------------------------------------------------
# 未登録アカウントの検出
# ---------------------------------------------------------------------------

# Claude の設定フォルダだと判断する目印のファイル
_MARKERS = (".credentials.json", ".claude.json")

# 深入りしない大きなディレクトリ（OS・開発ツールが作る一般的なもの）。隠しフォルダは別途すべて対象外
_SKIP_DIRS = {
    "appdata", "library", "node_modules", "__pycache__", "venv", "site-packages",
    "program files", "program files (x86)", "windows", "$recycle.bin", "system volume information",
}  # fmt: skip

_PALETTE = ["#4f8cff", "#f5a524", "#17c964", "#f31260", "#9353d3", "#06b7db", "#f56d3b", "#7c8aa5"]


def _is_candidate(d: Path) -> bool:
    return any((d / m).is_file() for m in _MARKERS)


def _short_path(p: Path) -> str:
    """ホーム配下なら ~ を使った短い表記にする。"""
    try:
        rel = p.relative_to(Path.home())
    except ValueError:
        return str(p)
    return "~/" + rel.as_posix() if rel.parts else "~"


def _safe_id(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", name.lstrip(".")).strip("-")[:40].strip("-")
    return s or "account"


def _scan(root: Path, depth: int) -> list[Path]:
    """root の下を depth 階層まで調べ、目印を持つディレクトリを返す。権限エラーなどは無視する。"""
    found: list[Path] = []

    def walk(d: Path, level: int) -> None:
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name.lower())
        except OSError:
            return
        for e in entries:
            try:
                if not e.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            p = Path(e.path)
            if _is_candidate(p):
                found.append(p)  # 候補の中身は調べない
                continue
            if level < depth and _should_descend(e.name):
                walk(p, level + 1)

    def _should_descend(name: str) -> bool:
        # 隠しフォルダ（.cache など）と巨大になりがちなフォルダには入らない。
        # ただし名前に "claude" を含む隠しフォルダは、複数アカウントの設定フォルダをまとめる親としてよく使われるので入る
        lowered = name.lower()
        if lowered.startswith("."):
            return "claude" in lowered
        return lowered not in _SKIP_DIRS

    walk(root, 1)
    return found


# ---------------------------------------------------------------------------
# ConfigService
# ---------------------------------------------------------------------------


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    """同じディレクトリの一時ファイルに書いてから置き換える（書きかけの状態を見せない）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


_ACCOUNT_KEYS = ("id", "label", "config_dir", "launch_command", "color", "interval_minutes", "enabled")


class ConfigService:
    def __init__(self, path: Path, discover_roots: list[str] | None = None) -> None:
        self.path = Path(path)
        # 初期生成時の検出先。None なら既定（~）。テストや特殊な環境で差し替える用
        self._initial_roots = discover_roots
        self.last_error: str | None = None  # poll() が検証に失敗したときの理由
        self._hash: str | None = None  # 最後に load/save/poll で取り込んだ内容のハッシュ
        self._current: AppConfig | None = None

    # --- 読み込み ---------------------------------------------------------

    def _read(self) -> tuple[bytes, str]:
        data = self.path.read_bytes() if self.path.exists() else b""
        return data, _sha(data)

    def _parse(self, data: bytes) -> AppConfig:
        try:
            raw = tomlkit.parse(data.decode("utf-8")).unwrap()
        except Exception as e:  # TOML の構文エラー・文字コードの不正
            raise ConfigValidationError([("(ファイル)", f"TOML として読めません: {e}")]) from e
        return _validate(raw)

    def load(self) -> tuple[AppConfig, str]:
        """設定とファイル内容のハッシュを返す。ファイルが無ければ初期設定を作ってから読む。"""
        if not self.path.exists():
            self.generate_initial()
        data, h = self._read()
        cfg = self._parse(data)
        self._hash, self._current, self.last_error = h, cfg, None
        return cfg, h

    # --- 初期生成・検出 ---------------------------------------------------

    def discover_candidates(self, cfg: AppConfig) -> list[dict]:
        """discover_roots 以下から未登録の設定フォルダ候補を探す。"""
        registered = {a.expanded_dir().resolve() for a in cfg.accounts}
        used_ids = {a.id for a in cfg.accounts}
        seen: set[Path] = set()
        out: list[dict] = []
        for r in cfg.collector.discover_roots:
            root = Path(os.path.expanduser(os.path.expandvars(r)))
            for p in _scan(root, cfg.collector.discover_depth):
                rp = p.resolve()
                if rp in registered or rp in seen:
                    continue
                seen.add(rp)
                base = _safe_id(p.name)
                sid, n = base, 2
                while sid in used_ids:
                    sid = f"{base[:36]}-{n}"
                    n += 1
                used_ids.add(sid)
                out.append({"suggested_id": sid, "config_dir": _short_path(p)})
        return out

    def generate_initial(self) -> None:
        """検出した候補を登録した初期設定を、コメント付きで書き出す。"""
        cfg = AppConfig()
        if self._initial_roots is not None:
            cfg.collector.discover_roots = list(self._initial_roots)
        for i, c in enumerate(self.discover_candidates(cfg)):
            cfg.accounts.append(
                AccountConfig(
                    id=c["suggested_id"],
                    label=c["suggested_id"],
                    config_dir=c["config_dir"],
                    color=_PALETTE[i % len(_PALETTE)],
                )
            )
        _atomic_write(self.path, _render_initial(cfg).encode("utf-8"))

    # --- 保存 -------------------------------------------------------------

    def save(self, new: dict | AppConfig, expected_hash: str) -> str:
        """検証して保存し、新しいハッシュを返す。既存のコメント・順序は保つ。"""
        data, current = self._read()
        if current != expected_hash:
            raise ConfigConflictError()
        cfg = _validate(new)
        try:
            doc = tomlkit.parse(data.decode("utf-8"))
        except Exception as e:
            raise ConfigValidationError([("(ファイル)", f"既存の TOML が読めないため保存できません: {e}")]) from e
        _apply(doc, cfg.model_dump(exclude_none=True))
        out = tomlkit.dumps(doc).encode("utf-8")
        _atomic_write(self.path, out)
        h = _sha(out)
        self._hash, self._current, self.last_error = h, cfg, None
        return h

    # --- 変更検知 ---------------------------------------------------------

    @property
    def current(self) -> AppConfig | None:
        """最後に load/save/poll で取り込んだ（検証済みの）設定。"""
        return self._current

    @property
    def current_hash(self) -> str | None:
        """current に対応するファイル内容のハッシュ（UI の楽観ロックに渡す値）。"""
        return self._hash

    def file_hash(self) -> str:
        """いまのファイル内容のハッシュ（壊れていても計算する。409 で UI に返す用）。"""
        return self._read()[1]

    def changed_since(self, h: str) -> bool:
        return self._read()[1] != h

    def poll(self) -> AppConfig | None:
        """外部で変更され、かつ検証に通った新しい設定を返す。それ以外は None。

        検証に失敗したら最後に有効だった設定を保ち、理由を last_error に入れる。
        """
        data, h = self._read()
        if h == self._hash:
            self.last_error = None  # 元の内容に戻った場合も含め、問題なし
            return None
        try:
            cfg = self._parse(data)
        except ConfigValidationError as e:
            self.last_error = str(e)
            return None
        self._hash, self._current, self.last_error = h, cfg, None
        return cfg


# ---------------------------------------------------------------------------
# TOML の書き出し（tomlkit）
# ---------------------------------------------------------------------------


def _set_if_changed(table: Any, key: str, value: Any) -> None:
    """値が違うときだけ代入する（同じなら項目に付いたコメントごと触らない）。"""
    if key in table:
        cur = table[key]
        if (list(cur) if isinstance(value, list) else cur) == value:
            return
    table[key] = value


def _update_table(table: Table, values: dict[str, Any], order: tuple[str, ...] | None = None) -> None:
    for k, v in values.items():
        _set_if_changed(table, k, v)
    if order is not None:  # None を指す項目（exclude_none で消えたもの）を取り除く
        for k in list(table.keys()):
            if k in order and k not in values:
                del table[k]


def _apply(doc: Any, values: dict[str, Any]) -> None:
    """検証済みの値を既存の文書へ差分で反映する。"""
    for sec in ("collector", "server", "ui"):
        if sec not in doc:
            doc[sec] = tomlkit.table()
        _update_table(doc[sec], values[sec])

    new_accounts: list[dict[str, Any]] = values["accounts"]
    existing: AoT | None = doc.get("accounts")
    if existing is None:
        if new_accounts:
            doc["accounts"] = tomlkit.aot()
            existing = doc["accounts"]
        else:
            return

    # 既存テーブルを id で引き、並び順は new に合わせて作り直す（テーブル内のコメントは使い回す）
    by_id = {t.get("id"): t for t in existing}
    tables: list[Table] = []
    for acc in new_accounts:
        t = by_id.get(acc["id"])
        if t is None:
            t = tomlkit.table()
            for k in _ACCOUNT_KEYS:
                if k in acc:
                    t[k] = acc[k]
        else:
            _update_table(t, acc, _ACCOUNT_KEYS)
        tables.append(t)

    # 並びが同じで追加・削除もなければそのまま。違えば AoT の中身を入れ替える
    if [t.get("id") for t in existing] != [a["id"] for a in new_accounts] or len(existing) != len(tables):
        while len(existing):
            existing.pop()
        for t in tables:
            existing.append(t)
    if not new_accounts:
        del doc["accounts"]


def _render_initial(cfg: AppConfig) -> str:
    """初期設定の TOML。セクションごとに日本語の短いコメントを付ける。"""
    d = cfg.model_dump(exclude_none=True)
    doc = tomlkit.document()
    doc.add(tomlkit.comment("ccsmoni の設定。手で編集しても、画面から保存してもよい（コメントは保たれる）"))
    doc.add(tomlkit.nl())

    def section(name: str, comment: str, extra: dict[str, str]) -> None:
        t = tomlkit.table()
        t.add(tomlkit.comment(comment))
        for k, v in d[name].items():
            t.add(k, v)
            if k in extra:
                t[k].comment(extra[k])
        doc.add(name, t)
        doc.add(tomlkit.nl())

    section(
        "collector",
        "取得間隔（分）。アカウントごとに interval_minutes で上書きできる",
        {
            "timeout_seconds": "1回の取得を待つ上限（秒）",
            "concurrency": "同時に取得するアカウント数",
            "discover_roots": "未登録アカウントを探す場所",
            "discover_depth": "探す深さ（1〜3）",
        },
    )
    section("server", "画面を配信する場所。通常は 127.0.0.1（この PC のみ）のままにする", {})
    section("ui", "使用率の色分け（%）。warn < danger", {})

    accounts = tomlkit.aot()
    for a in d["accounts"]:
        t = tomlkit.table()
        for k in _ACCOUNT_KEYS:
            if k in a:
                t.add(k, a[k])
        accounts.append(t)
    if len(accounts):
        doc.add(tomlkit.comment("監視するアカウント。id は履歴のキーなので変更しない"))
        doc.add("accounts", accounts)
    return tomlkit.dumps(doc)
