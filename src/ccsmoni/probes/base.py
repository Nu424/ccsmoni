"""取得方法の差し替え口。

何を: 「どう取ってくるか（Source）」と「どう読むか（Parser）」を分け、その組を Probe と呼ぶ。
なぜ: 将来、別の取得方法に変える・足すときに、Probe を1つ登録するだけで済むようにする（PLAN §4.1）。
方針: 層は増やしすぎない。Source は副作用（プロセス起動など）を持ち、Parser は純粋関数にする。
      Parser は RawResult だけから Reading を作れるので、保存済みの raw から何度でも作り直せる（reparse）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ccsmoni.model import Account, RawResult, Reading


class Source(Protocol):
    kind: str

    def fetch(self, account: Account) -> RawResult: ...


class Parser(Protocol):
    def parse(self, raw: RawResult, account_id: str) -> Reading: ...


@dataclass(frozen=True)
class Probe:
    name: str
    source: Source
    parser: Parser

    def run(self, account: Account) -> tuple[RawResult, Reading]:
        raw = self.source.fetch(account)
        return raw, self.parser.parse(raw, account.id)
