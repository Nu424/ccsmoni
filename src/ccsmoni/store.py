"""SQLite の保存層。

何を: 取得1回分（RawResult + Reading）を保存し、最新値・推移・週ごとのピークを引けるようにする。
なぜ: 推移の記録がこのツールの目的。raw も残しておけば、パーサーを直したあと reparse で過去分を作り直せる。
方針:
  - 標準ライブラリ sqlite3 のみ。WAL モード。ORM は使わない。
  - DB 内の時刻はすべて UTC の epoch 秒（INTEGER）。範囲検索とグラフ描画が楽なため。
    Python 側へ返す datetime は UTC aware。
  - 単一プロセスだが asyncio の to_thread から呼ばれうるので、check_same_thread=False + Lock で直列化する。
  - スキーマの版は PRAGMA user_version で管理する（初版 = 1）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ccsmoni.model import Limit, RawResult, Reading, Status
from ccsmoni.probes.base import Parser

# 枠の同一判定の許容幅。表示の丸めで 4:20am ↔ 4:19am と揺れるのを吸収する（PLAN §4.2）。
WINDOW_TOLERANCE_SEC = 15 * 60

# user_version ごとのマイグレーション。キー = 移行先の版。
_MIGRATIONS: dict[int, str] = {
    1: """
    CREATE TABLE snapshots (
        id             INTEGER PRIMARY KEY,
        account_id     TEXT    NOT NULL,
        taken_at       INTEGER NOT NULL,
        probe          TEXT    NOT NULL,
        status         TEXT    NOT NULL,
        message        TEXT,
        extras_json    TEXT    NOT NULL DEFAULT '{}',
        raw_source     TEXT    NOT NULL,
        raw_text       TEXT    NOT NULL,
        raw_exit_code  INTEGER,
        raw_timed_out  INTEGER NOT NULL DEFAULT 0,
        raw_error      TEXT,
        raw_meta_json  TEXT    NOT NULL DEFAULT '{}',
        duration_ms    INTEGER NOT NULL
    );
    CREATE INDEX idx_snapshots_account_time ON snapshots (account_id, taken_at);

    -- 利用枠の1周期。resets_at は最新の観測値。
    CREATE TABLE windows (
        id            INTEGER PRIMARY KEY,
        account_id    TEXT    NOT NULL,
        kind          TEXT    NOT NULL,
        resets_at     INTEGER NOT NULL,
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        peak_percent  REAL    NOT NULL
    );
    CREATE INDEX idx_windows_account_kind ON windows (account_id, kind, last_seen);

    -- taken_at は snapshots からの非正規化（範囲検索で JOIN を避けるため）。
    CREATE TABLE limits (
        snapshot_id  INTEGER NOT NULL REFERENCES snapshots (id),
        account_id   TEXT    NOT NULL,
        kind         TEXT    NOT NULL,
        label        TEXT    NOT NULL,
        percent      REAL    NOT NULL,
        resets_at    INTEGER,
        window_id    INTEGER REFERENCES windows (id),
        taken_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_limits_account_kind_time ON limits (account_id, kind, taken_at);
    CREATE INDEX idx_limits_snapshot ON limits (snapshot_id);

    -- ログイン後に「前と別のアカウントでないか」を照合するための直近の値。
    CREATE TABLE account_meta (
        account_id   TEXT PRIMARY KEY,
        last_org_id  TEXT,
        last_plan    TEXT,
        updated_at   INTEGER NOT NULL
    );
    """,
}


# ---------------------------------------------------------------- 時刻の変換


def _to_epoch(dt: datetime) -> int:
    """datetime → UTC epoch 秒。naive は UTC とみなす。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return int(round(dt.timestamp()))


def _from_epoch(t: int) -> datetime:
    return datetime.fromtimestamp(t, UTC)


def _in_clause(column: str, values: list[str] | None, params: list[Any]) -> str:
    """`column IN (?, ?, ...)` を作って params に値を足す。values が None なら条件なし。"""
    if values is None:
        return ""
    if not values:
        return " AND 0"  # 空リスト指定 = 何にも一致しない
    params.extend(values)
    return f" AND {column} IN ({','.join('?' * len(values))})"


class Store:
    def __init__(self, path: Path | str) -> None:
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._migrate()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------ マイグレーション

    def _migrate(self) -> None:
        """user_version を見て、足りない版のスキーマを順に適用する。"""
        current = self._conn.execute("PRAGMA user_version").fetchone()[0]
        for version in sorted(_MIGRATIONS):
            if version <= current:
                continue
            # executescript は先に COMMIT を発行するので、版の更新も同じスクリプトに含める
            self._conn.executescript(
                f"BEGIN;\n{_MIGRATIONS[version]}\nPRAGMA user_version = {version};\nCOMMIT;"
            )

    # ------------------------------------------------------------ 保存

    def save(self, raw: RawResult, reading: Reading) -> int:
        """取得1回分を保存し、snapshot id を返す。"""
        with self._lock, self._conn:
            cur = self._conn.execute(
                """
                INSERT INTO snapshots (
                    account_id, taken_at, probe, status, message, extras_json,
                    raw_source, raw_text, raw_exit_code, raw_timed_out, raw_error,
                    raw_meta_json, duration_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    reading.account_id,
                    _to_epoch(reading.taken_at),
                    reading.probe,
                    str(reading.status),
                    reading.message,
                    json.dumps(reading.extras, ensure_ascii=False, default=str),
                    raw.source,
                    raw.text,
                    raw.exit_code,
                    int(raw.timed_out),
                    raw.error,
                    json.dumps(raw.meta, ensure_ascii=False, default=str),
                    raw.duration_ms,
                ),
            )
            snapshot_id = int(cur.lastrowid)
            self._insert_limits(snapshot_id, reading.account_id, _to_epoch(reading.taken_at), reading.limits)
            if reading.status == Status.OK:
                self._update_account_meta(reading)
            return snapshot_id

    def _insert_limits(
        self, snapshot_id: int, account_id: str, taken_at: int, limits: tuple[Limit, ...]
    ) -> None:
        """limits を挿入し、resets_at がある枠には window を割り当てる（コミットは呼び出し側）。"""
        for lim in limits:
            resets_at = _to_epoch(lim.resets_at) if lim.resets_at is not None else None
            window_id = (
                self._assign_window(account_id, lim.kind, resets_at, taken_at, lim.percent)
                if resets_at is not None
                else None  # 枠が始まっていない（0%）。window は作らない
            )
            self._conn.execute(
                """
                INSERT INTO limits (snapshot_id, account_id, kind, label, percent,
                                    resets_at, window_id, taken_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (snapshot_id, account_id, lim.kind, lim.label, lim.percent,
                 resets_at, window_id, taken_at),
            )

    def _assign_window(
        self, account_id: str, kind: str, resets_at: int, taken_at: int, percent: float
    ) -> int:
        """枠の識別（PLAN §4.2）。

        同じ (account, kind) の直近の window と resets_at が ±15分以内なら同じ枠として更新し、
        そうでなければ新しい枠を作る。taken_at 昇順に呼ばれる限り結果は決定的（reparse も同じ）。
        """
        row = self._conn.execute(
            """
            SELECT id, peak_percent, resets_at FROM windows
            WHERE account_id = ? AND kind = ?
            ORDER BY last_seen DESC, id DESC LIMIT 1
            """,
            (account_id, kind),
        ).fetchone()
        if row is not None and abs(row["resets_at"] - resets_at) <= WINDOW_TOLERANCE_SEC:
            self._conn.execute(
                """
                UPDATE windows
                SET resets_at = ?, last_seen = MAX(last_seen, ?), peak_percent = MAX(peak_percent, ?)
                WHERE id = ?
                """,
                (resets_at, taken_at, percent, row["id"]),
            )
            return int(row["id"])
        cur = self._conn.execute(
            """
            INSERT INTO windows (account_id, kind, resets_at, first_seen, last_seen, peak_percent)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (account_id, kind, resets_at, taken_at, taken_at, percent),
        )
        return int(cur.lastrowid)

    def _update_account_meta(self, reading: Reading) -> None:
        """ok のときだけ、extras の org_id / plan を記録する。片方しか無ければもう片方は残す。"""
        org_id = reading.extras.get("org_id")
        plan = reading.extras.get("plan")
        if not org_id and not plan:
            return
        self._conn.execute(
            """
            INSERT INTO account_meta (account_id, last_org_id, last_plan, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (account_id) DO UPDATE SET
                last_org_id = COALESCE(excluded.last_org_id, last_org_id),
                last_plan   = COALESCE(excluded.last_plan, last_plan),
                updated_at  = excluded.updated_at
            """,
            (reading.account_id, org_id, plan, _to_epoch(reading.taken_at)),
        )

    # ------------------------------------------------------------ 最新値

    def _reading_from_row(self, row: sqlite3.Row) -> Reading:
        limit_rows = self._conn.execute(
            "SELECT kind, label, percent, resets_at FROM limits WHERE snapshot_id = ? ORDER BY rowid",
            (row["id"],),
        ).fetchall()
        limits = tuple(
            Limit(
                kind=r["kind"],
                label=r["label"],
                percent=r["percent"],
                resets_at=_from_epoch(r["resets_at"]) if r["resets_at"] is not None else None,
            )
            for r in limit_rows
        )
        return Reading(
            account_id=row["account_id"],
            taken_at=_from_epoch(row["taken_at"]),
            probe=row["probe"],
            status=Status(row["status"]),
            limits=limits,
            message=row["message"],
            extras=json.loads(row["extras_json"]),
        )

    def latest(self, account_ids: list[str] | None = None) -> dict[str, Reading]:
        """各アカウントの最新の Reading（status を問わない）。"""
        return self._latest(account_ids, ok_only=False)

    def latest_ok(self, account_id: str) -> Reading | None:
        """最後に status=ok だった Reading。ログイン切れの間も「最後に分かった値」を出すために使う。"""
        return self._latest([account_id], ok_only=True).get(account_id)

    def _latest(self, account_ids: list[str] | None, ok_only: bool) -> dict[str, Reading]:
        params: list[Any] = []
        cond = _in_clause("s.account_id", account_ids, params)
        status_cond = " AND s.status = 'ok'" if ok_only else ""
        # 同じ taken_at が複数あっても id 最大の1件に決める
        sub_status = " AND s2.status = 'ok'" if ok_only else ""
        sql = f"""
            SELECT s.* FROM snapshots s
            WHERE s.id = (
                SELECT s2.id FROM snapshots s2
                WHERE s2.account_id = s.account_id{sub_status}
                ORDER BY s2.taken_at DESC, s2.id DESC LIMIT 1
            ){status_cond}{cond}
        """
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
            return {r["account_id"]: self._reading_from_row(r) for r in rows}

    # ------------------------------------------------------------ 推移

    def history(
        self,
        since: datetime,
        until: datetime | None = None,
        account_ids: list[str] | None = None,
        kinds: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """limit の時系列（taken_at 昇順）。グラフ描画用。"""
        params: list[Any] = [_to_epoch(since)]
        sql = "SELECT account_id, kind, taken_at, percent, resets_at, window_id FROM limits WHERE taken_at >= ?"
        if until is not None:
            sql += " AND taken_at <= ?"
            params.append(_to_epoch(until))
        sql += _in_clause("account_id", account_ids, params)
        sql += _in_clause("kind", kinds, params)
        sql += " ORDER BY taken_at, snapshot_id, rowid"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [
            {
                "account_id": r["account_id"],
                "kind": r["kind"],
                "t": r["taken_at"],
                "percent": r["percent"],
                "resets_at": r["resets_at"],
                "window_id": r["window_id"],
            }
            for r in rows
        ]

    def snapshot_times(
        self, since: datetime, account_ids: list[str] | None = None
    ) -> list[tuple[str, int, str]]:
        """取得の記録 (account_id, epoch秒, status)。抜けやエラーをグラフに出すため。"""
        params: list[Any] = [_to_epoch(since)]
        sql = "SELECT account_id, taken_at, status FROM snapshots WHERE taken_at >= ?"
        sql += _in_clause("account_id", account_ids, params)
        sql += " ORDER BY taken_at, id"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [(r["account_id"], r["taken_at"], r["status"]) for r in rows]

    def windows(
        self,
        account_id: str | None = None,
        kind: str | None = None,
        since: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """枠の一覧（週ごとのピーク表用）。since は last_seen で絞る。"""
        sql = "SELECT * FROM windows WHERE 1"
        params: list[Any] = []
        if account_id is not None:
            sql += " AND account_id = ?"
            params.append(account_id)
        if kind is not None:
            sql += " AND kind = ?"
            params.append(kind)
        if since is not None:
            sql += " AND last_seen >= ?"
            params.append(_to_epoch(since))
        sql += " ORDER BY account_id, kind, first_seen, id"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------ account_meta

    def get_account_meta(self, account_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM account_meta WHERE account_id = ?", (account_id,)
            ).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------ raw / reparse

    @staticmethod
    def _raw_from_row(row: sqlite3.Row) -> RawResult:
        return RawResult(
            source=row["raw_source"],
            started_at=_from_epoch(row["taken_at"]),
            duration_ms=row["duration_ms"],
            text=row["raw_text"],
            exit_code=row["raw_exit_code"],
            timed_out=bool(row["raw_timed_out"]),
            error=row["raw_error"],
            meta=json.loads(row["raw_meta_json"]),
        )

    def iter_raw(self) -> Iterator[tuple[int, str, RawResult]]:
        """全 snapshot の raw を taken_at 順に返す。1件ずつ読むのでロックは行ごとに取る。"""
        with self._lock:
            ids = [r[0] for r in self._conn.execute("SELECT id FROM snapshots ORDER BY taken_at, id")]
        for sid in ids:
            with self._lock:
                row = self._conn.execute("SELECT * FROM snapshots WHERE id = ?", (sid,)).fetchone()
            if row is not None:
                yield row["id"], row["account_id"], self._raw_from_row(row)

    def reparse(self, parser: Parser) -> int:
        """保存済みの raw をパーサーで読み直し、snapshots の解釈結果・limits・windows を作り直す。

        全体を1つのトランザクションにする（途中で失敗したら元のまま）。
        window の割り当ては taken_at 順に決定的に行うので、保存時と同じ結果になる。
        取得時刻は元の snapshot の taken_at を使う（パーサーが返す値には依存しない）。
        """
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM limits")
            self._conn.execute("DELETE FROM windows")
            count = 0
            for sid, account_id, raw in list(self.iter_raw()):
                reading = parser.parse(raw, account_id)
                taken_at = _to_epoch(raw.started_at)
                self._conn.execute(
                    """
                    UPDATE snapshots SET probe = ?, status = ?, message = ?, extras_json = ?
                    WHERE id = ?
                    """,
                    (
                        reading.probe,
                        str(reading.status),
                        reading.message,
                        json.dumps(reading.extras, ensure_ascii=False, default=str),
                        sid,
                    ),
                )
                self._insert_limits(sid, account_id, taken_at, reading.limits)
                count += 1
            return count
