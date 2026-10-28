"""provider ごとに取得方法を振り分ける Source と Parser。

何を: RoutingSource はアカウントの provider（claude / codex）で Source を選び、
      RoutingParser は raw の source（cli-usage / codex-app-server）で Parser を選ぶ。
なぜ: Scheduler・接続テスト・reparse は、今までどおり Probe を1つだけ扱えばよいようにする（docs/design/CODEX.md）。
方針: 知らない source の raw は Claude のパーサーに渡す（provider を足す前の DB と、例外時の raw のため）。
"""

from __future__ import annotations

from typing import Any

from ccsmoni.model import Account, Provider, RawResult, Reading
from ccsmoni.probes.base import Parser, Source


class RoutingSource:
    kind = "routing"

    def __init__(self, sources: dict[Provider, Any]) -> None:
        self.sources = sources

    def source_for(self, account: Account) -> Source:
        return self.sources[account.provider]

    def fetch(self, account: Account) -> RawResult:
        return self.source_for(account).fetch(account)

    def auth_status(self, account: Account) -> dict | None:
        return self.source_for(account).auth_status(account)


class RoutingParser:
    def __init__(self, parsers: dict[str, Parser] | None = None, fallback: Parser | None = None) -> None:
        from ccsmoni.parser_codex import CodexRateLimitsParser
        from ccsmoni.parser_usage import UsageTextParser
        from ccsmoni.probes.codex_app_server import KIND as CODEX_KIND

        self.fallback = fallback or UsageTextParser()
        self.parsers = parsers if parsers is not None else {CODEX_KIND: CodexRateLimitsParser()}

    def parse(self, raw: RawResult, account_id: str) -> Reading:
        return self.parsers.get(raw.source, self.fallback).parse(raw, account_id)
