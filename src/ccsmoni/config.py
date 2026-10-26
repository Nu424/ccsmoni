"""設定サービス。

何を: config.toml の「読み込み → 検証 → 保存」と、未登録アカウント（Claude の設定フォルダ）の検出を担う。
なぜ: TOML ファイルを唯一の正にし、手で編集した場合も UI から保存した場合も同じ検証を通すため（PLAN §7.1）。
方針:
  - 検証は pydantic。保存は tomlkit で既存の文書を差分更新し、手書きのコメントや順序を保つ。
  - 競合は内容の sha256 で検出（楽観ロック）。書き込みは一時ファイル → os.replace でアトミックに。
    置き換える直前にもう一度ハッシュを確かめる（読んでから書くまでの間に外部で変更された場合も上書きしない）。
  - 保存では、書き出す予定の TOML 全体を、読み込みと同じ検証に通してから置き換える（壊れたファイルを残さない）。
  - 変更検知は単純な poll()。スレッドや asyncio には依存しない（呼び出し側が定期的に呼ぶ）。
  - 起動するコマンド（collector.claude_path）と待ち受け先（server.host / port）は、ファイルでだけ編集する
    （Web から変えられると、tailnet 内のページから任意のコマンドを実行させられるため）。検証でも claude 本体と
    ループバックだけに絞る。Web 側の確認は readonly_errors()。
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path, PureWindowsPath
from typing import Any

import tomlkit
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from tomlkit.items import AoT, InlineTable, Table

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
# server.allowed_hosts に書けるホスト名（ポート・ワイルドカードなし）。[::1] のような角括弧付きの IPv6 も許す
_HOSTNAME_RE = re.compile(r"^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$")
# server.host に指定できる値（ループバックだけ。外部への公開は tailscale serve に任せる）
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


class _Base(BaseModel):
    # 綴り間違いのキーを黙って捨てないよう、未知のキーは拒否する
    model_config = ConfigDict(extra="forbid")


class CollectorConfig(_Base):
    default_interval_minutes: int = Field(10, ge=1, le=1440)
    timeout_seconds: int = Field(30, ge=5, le=300)
    concurrency: int = Field(2, ge=1, le=8)
    claude_path: str = "claude"  # ファイルでだけ編集する（Web の保存では変えられない）
    discover_roots: list[str] = Field(default_factory=lambda: ["~"])
    discover_depth: int = Field(2, ge=1, le=3)

    @field_validator("claude_path")
    @classmethod
    def _check_claude_path(cls, v: str) -> str:
        # 起動できるのは claude 本体だけ（PLAN §8「最低限の防御」）。ファイル名の stem で判断する
        # （claude / claude.exe / C:\...\claude.cmd など）。ネットワーク上のパスは置き換えられうるので拒否する
        s = v.strip()
        if s.startswith(("\\\\", "//")):
            raise ValueError(r"ネットワーク上のパス（\\ や // で始まるもの）は指定できません")
        if PureWindowsPath(s).stem.lower() != "claude":
            raise ValueError(r"claude 本体（ファイル名が claude のもの。例: claude、C:\...\claude.exe）だけを指定できます")
        return s


class ServerConfig(_Base):
    host: str = "127.0.0.1"  # host / port はファイルでだけ編集する（Web の保存では変えられない）
    port: int = Field(8484, ge=1, le=65535)
    # Host ヘッダーとして受け付ける追加のホスト名（MagicDNS の短い名前など）。
    # 127.0.0.1 / localhost / [::1] と *.ts.net は常に受け付ける（web の Host の確認）
    allowed_hosts: list[str] = Field(default_factory=list)

    @field_validator("host")
    @classmethod
    def _check_host(cls, v: str) -> str:
        if v.strip().lower() not in LOOPBACK_HOSTS:
            raise ValueError("127.0.0.1 / ::1 / localhost のいずれかを指定してください（外への公開は tailscale serve で行います）")
        return v.strip().lower()

    @field_validator("allowed_hosts")
    @classmethod
    def _check_allowed_hosts(cls, v: list[str]) -> list[str]:
        out = []
        for h in v:
            h = h.strip().lower()
            if not _HOSTNAME_RE.match(h):
                raise ValueError(f"「{h}」はホスト名として使えません（ポートや * は付けず、ホスト名だけを書いてください）")
            out.append(h)
        return out


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

def _is_candidate(d: Path) -> bool:
    return any((d / m).is_file() for m in _MARKERS)


def short_path(p: Path) -> str:
    """ホーム配下なら ~/ を使った短い表記にする（区切りは / にそろえる）。

    画面やスクリーンショットにユーザー名を出さないため。設定ファイルの config_dir にもこの形で書く
    （expanduser で戻せる。TOML でバックスラッシュのエスケープが要らない）。ホームの外はそのまま返す。
    """
    p = Path(p)
    home = Path.home()
    for base, target in ((home, p), (home.resolve(), p.resolve())):
        try:
            rel = target.relative_to(base)
        except ValueError:
            continue
        return "~/" + rel.as_posix() if rel.parts else "~"
    return str(p)


# ---------------------------------------------------------------------------
# 色
# ---------------------------------------------------------------------------

# アカウントの色の既定のパレット。UI にも /api/config の palette で同じものを渡す
PALETTE = ["#4f8cff", "#f5a524", "#17c964", "#f31260", "#9353d3", "#06b7db", "#f56d3b", "#7c8aa5"]


def resolve_colors(accounts: Sequence[AccountConfig], archived_ids: Sequence[str] = ()) -> dict[str, str]:
    """アカウント id → 表示に使う色。/api/state・/api/config・UI で同じ色にするため、色はここだけで決める。

    - 設定のアカウント: 指定があればその色、なければ設定の並び順でパレットから（index % パレットの数）。
    - アーカイブ（履歴はあるが設定にない）: id の昇順に、設定のアカウントが使っていないパレットの色から順に割り当てる
      （全部使われていればパレット全体から）。同じ設定・同じ履歴なら、いつも同じ色になる。
    """
    out: dict[str, str] = {}
    for i, a in enumerate(accounts):
        out[a.id] = a.color or PALETTE[i % len(PALETTE)]
    used = {c.lower() for c in out.values()}
    free = [c for c in PALETTE if c.lower() not in used] or PALETTE
    for j, aid in enumerate(sorted(x for x in set(archived_ids) if x not in out)):
        out[aid] = free[j % len(free)]
    return out


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


def _atomic_write(path: Path, data: bytes, expect_hash: str | None = None) -> None:
    """同じディレクトリの一時ファイルに書いてから置き換える（書きかけの状態を見せない）。

    expect_hash を渡すと、置き換える直前にファイルのハッシュをもう一度確かめ、違えば置き換えずに
    ConfigConflictError にする（読んでから書くまでの間に、外部で変更された内容を上書きしないため）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if expect_hash is not None:
            now = path.read_bytes() if path.exists() else b""
            if _sha(now) != expect_hash:
                raise ConfigConflictError()
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


_ACCOUNT_KEYS = ("id", "label", "config_dir", "launch_command", "color", "interval_minutes", "enabled")
# 既知のセクションに書いてよいキー（スキーマの項目）。保存のとき、これ以外のキーは取り除く
_SECTION_KEYS = {
    "collector": tuple(CollectorConfig.model_fields),
    "server": tuple(ServerConfig.model_fields),
    "ui": tuple(UiConfig.model_fields),
}

# Web の保存では変えられない項目（(セクション, キー)）。ファイルでだけ編集する
READONLY_FIELDS = (("collector", "claude_path"), ("server", "host"), ("server", "port"))
MSG_READONLY = "この項目は設定ファイルで編集してください"


def readonly_values(cfg: AppConfig) -> dict[str, Any]:
    """/api/config の readonly（画面では表示だけする項目）。"""
    return {"claude_path": cfg.collector.claude_path, "host": cfg.server.host, "port": cfg.server.port}


def readonly_errors(new: dict[str, Any], current: AppConfig) -> list[tuple[str, str]]:
    """Web からの保存で、ファイルでだけ編集する項目が変えられていないかを確かめる。

    new（保存しようとしている設定の dict）に項目が無ければ current の値で埋める（new を書き換える）。
    いまの値と違う値が来ていたら、その項目を (フィールド名, 理由) で返す。
    """
    errors: list[tuple[str, str]] = []
    cur = current.model_dump()
    for sec, key in READONLY_FIELDS:
        section = new.get(sec)
        if section is None:
            section = new[sec] = {}
        if not isinstance(section, dict):
            continue  # 形の誤りは通常の検証で 422 になる
        if key not in section:
            section[key] = cur[sec][key]
        elif section[key] != cur[sec][key]:
            errors.append((f"{sec}.{key}", MSG_READONLY))
    return errors


@dataclass
class SaveResult:
    """save() の結果。"""

    hash: str  # 書き出した内容のハッシュ
    removed_keys: list[str] = field(default_factory=list)  # 取り除いたスキーマ外のキー（"collector.foo" など）
    backup_path: Path | None = None  # 構文エラーのファイルを退避した先（退避しなかったら None）


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
        """設定とファイル内容のハッシュを返す。

        ファイルが無い・空なら初期設定を作ってから読む（空のファイルは失う中身がないので作り直してよい）。
        検証に通らなければ ConfigValidationError（起動時は cli がわかりやすいメッセージにして止める）。
        """
        if not self.path.exists() or not self.path.read_bytes().strip():
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
                out.append({"suggested_id": sid, "config_dir": short_path(p)})
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
                    color=PALETTE[i % len(PALETTE)],
                )
            )
        _atomic_write(self.path, _render_initial(cfg).encode("utf-8"))

    # --- 保存 -------------------------------------------------------------

    def save(self, new: dict | AppConfig, expected_hash: str) -> SaveResult:
        """検証して保存する。既存のコメント・順序は保つ。

        - 既存のファイルが TOML として読める: 差分で更新する。既知のセクションにあるスキーマ外のキーは取り除き、
          removed_keys に入れる（残すと、書き出したファイルが検証に通らなくなるため）。
        - 既存のファイルが空・無い: 初期生成と同じコメント付きの体裁で書き出す。
        - 既存のファイルが TOML として読めない（構文エラー）: 壊れたファイルを config.toml.broken-<日時> に退避し、
          初期生成と同じ体裁で書き出す（backup_path に退避先）。
        どの場合も、書き出す予定の内容を読み込みと同じ検証（_parse）に通し、通らなければ ConfigValidationError。
        置き換える直前にハッシュをもう一度確かめ、外部で変更されていれば ConfigConflictError。
        """
        data, current = self._read()
        if current != expected_hash:
            raise ConfigConflictError()
        cfg = _validate(new)
        values = cfg.model_dump(exclude_none=True)
        removed: list[str] = []
        broken = False
        if not data.strip():
            out = _render_initial(cfg).encode("utf-8")
        else:
            try:
                doc = tomlkit.parse(data.decode("utf-8"))
            except Exception:  # 構文エラー・文字コードの不正
                doc = None
            if doc is None:
                broken = True
                out = _render_initial(cfg).encode("utf-8")
            else:
                removed = _apply(doc, values)
                out = tomlkit.dumps(doc).encode("utf-8")

        # 書き出す予定の内容が、読み込みでも同じ設定として通ることを確かめてから置き換える
        # （既存の文書に残った想定外の内容で、保存したファイルが読めなくなるのを防ぐ）
        if self._parse(out) != cfg:
            raise ConfigValidationError(
                [("(ファイル)", "保存する内容を正しく書き出せませんでした。設定ファイルを手で直してください")]
            )
        backup = self._backup_broken(data) if broken else None
        try:
            _atomic_write(self.path, out, expect_hash=current)
        except ConfigConflictError:
            if backup is not None:
                backup.unlink(missing_ok=True)  # 置き換えなかったので、退避も取り消す
            raise
        h = _sha(out)
        self._hash, self._current, self.last_error = h, cfg, None
        return SaveResult(h, removed, backup)

    def _backup_broken(self, data: bytes) -> Path:
        """壊れた内容を config.toml.broken-<日時> に書き出す（同じ名前があれば -2, -3 … を付ける）。"""
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = self.path.with_name(f"{self.path.name}.broken-{stamp}")
        p, n = base, 2
        while p.exists():
            p = base.with_name(f"{base.name}-{n}")
            n += 1
        p.write_bytes(data)
        return p

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
        """いまのファイル内容のハッシュ（壊れていても・無くても計算する。409 や /api/state の config_hash 用）。"""
        return self._read()[1]

    def poll(self) -> AppConfig | None:
        """外部で変更され、かつ検証に通った新しい設定を返す。それ以外は None。

        検証に失敗したら最後に有効だった設定を保ち、理由を last_error に入れる。
        ファイルが無い・空の場合も誤りとして扱う（「アカウントが1つもない設定」として読み込まないため）。
        """
        if not self.path.exists():
            self.last_error = "設定ファイルが見つかりません（最後に有効だった設定で動いています）"
            return None
        data, h = self._read()
        if not data.strip():
            self.last_error = "設定ファイルが空です（最後に有効だった設定で動いています）"
            return None
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


def _update_table(
    table: Any, values: dict[str, Any], allowed: tuple[str, ...], where: str, removed: list[str]
) -> None:
    """表を values に合わせる。

    allowed（スキーマの項目）に無いキーは取り除いて removed に "where.key" を足す。
    allowed にあって values に無いキー（None を指す項目。exclude_none で消えたもの）も取り除く。
    """
    for k, v in values.items():
        _set_if_changed(table, k, v)
    for k in list(table.keys()):
        if k not in allowed:
            del table[k]
            removed.append(f"{where}.{k}")
        elif k not in values:
            del table[k]


def _apply(doc: Any, values: dict[str, Any]) -> list[str]:
    """検証済みの値を既存の文書へ差分で反映する。取り除いたスキーマ外のキーを返す。"""
    removed: list[str] = []
    for sec in ("collector", "server", "ui"):
        if not isinstance(doc.get(sec), (Table, InlineTable)):  # 無い・表でない（壊れている）なら作り直す
            if sec in doc:
                del doc[sec]
            doc[sec] = tomlkit.table()
        _update_table(doc[sec], values[sec], _SECTION_KEYS[sec], sec, removed)

    new_accounts: list[dict[str, Any]] = values["accounts"]
    existing = doc.get("accounts")
    if existing is not None and not isinstance(existing, AoT):  # [[accounts]] の形でない（壊れている）
        del doc["accounts"]
        existing = None
    if existing is None:
        if new_accounts:
            doc["accounts"] = tomlkit.aot()
            existing = doc["accounts"]
        else:
            return removed

    # 既存テーブルを id で引き、並び順は new に合わせて作り直す（テーブル内のコメントは使い回す）
    by_id = {t.get("id"): t for t in existing}
    tables: list[Table] = []
    for i, acc in enumerate(new_accounts):
        t = by_id.get(acc["id"])
        if t is None:
            t = tomlkit.table()
            for k in _ACCOUNT_KEYS:
                if k in acc:
                    t[k] = acc[k]
        else:
            _update_table(t, acc, _ACCOUNT_KEYS, f"accounts.{i}", removed)
        tables.append(t)

    # 並びが同じで追加・削除もなければそのまま。違えば AoT の中身を入れ替える
    if [t.get("id") for t in existing] != [a["id"] for a in new_accounts] or len(existing) != len(tables):
        while len(existing):
            existing.pop()
        for t in tables:
            existing.append(t)
    if not new_accounts:
        del doc["accounts"]
    return removed


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
            "claude_path": "claude 本体（このファイルでだけ変更できる）",
            "discover_roots": "未登録アカウントを探す場所",
            "discover_depth": "探す深さ（1〜3）",
        },
    )
    section(
        "server",
        "画面を配信する場所。host は 127.0.0.1 / ::1 / localhost のみ。host・port はこのファイルでだけ変更できる",
        {"allowed_hosts": "受け付ける追加のホスト名（MagicDNS の短い名前など。*.ts.net は常に受け付ける）"},
    )
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
