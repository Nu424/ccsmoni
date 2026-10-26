"""コマンドライン入口。各サブコマンドは、対応するモジュールを単体で動かすための口でもある。"""

from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ccsmoni", description="Claude Code s monitor — 利用状況の記録と可視化")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("serve", help="常駐して定期取得し、ダッシュボードを配信する")
    parse = sub.add_parser("parse", help="保存済みの /usage テキストを読み、Reading の JSON を出力する")
    parse.add_argument("file", help="/usage の出力を保存したテキストファイル")
    parse.add_argument("--taken-at", help="取得時刻（ISO 8601。省略時は現在時刻）")
    collect = sub.add_parser("collect", help="claude CLI で各アカウントの /usage を取得する")
    collect.add_argument("--once", action="store_true", help="1回だけ取得して終了する")
    collect.add_argument("--print", action="store_true", dest="print_table", help="結果を表で表示する")
    collect.add_argument("--config-dir", action="append", required=True, help="CLAUDE_CONFIG_DIR（複数指定可。id はディレクトリ名）")
    return p


def _cmd_collect(args: argparse.Namespace) -> int:
    # 設定ファイルができるまでの暫定: --config-dir で直接指定し、アカウント id はディレクトリ名にする。
    # 並列にはせず順に取得する（認証まわりの競合を避けるため）。
    from pathlib import Path

    from ccsmoni.model import Account
    from ccsmoni.probes.cli_usage import CliUsageSource

    try:
        from ccsmoni.parser_usage import UsageTextParser
    except ImportError:
        UsageTextParser = None  # パーサー未実装なら raw の要約だけ出す

    source = CliUsageSource()
    rows = []
    for d in args.config_dir:
        path = Path(d).expanduser().resolve()
        account = Account(id=path.name, label=path.name, config_dir=path)
        raw = source.fetch(account)
        secs = f"{raw.duration_ms / 1000:.1f}s"
        if UsageTextParser is not None:
            reading = UsageTextParser().parse(raw, account.id)
            session = reading.limit("session")
            weekly = reading.limit("weekly_all")
            resets = next((lim.resets_at for lim in reading.limits if lim.resets_at), None)
            rows.append((
                account.id,
                str(reading.status),
                f"{session.percent:g}%" if session else "-",
                f"{weekly.percent:g}%" if weekly else "-",
                resets.astimezone().strftime("%m/%d %H:%M") if resets else "-",
                secs,
            ))
        else:
            first = next(iter(raw.text.splitlines()), "")
            rows.append((account.id, f"exit={raw.exit_code}", raw.error or ("timeout" if raw.timed_out else ""), first[:40], "-", secs))
    header = ("id", "status", "session%", "weekly%", "resets", "time")
    widths = [max(len(str(r[i])) for r in [header, *rows]) for i in range(len(header))]
    for r in [header, *rows]:
        print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))
    return 0


def _cmd_parse(args: argparse.Namespace) -> int:
    # 遅延 import: 他のサブコマンドの起動を軽く保つ
    import json
    from datetime import datetime, timezone
    from pathlib import Path

    from ccsmoni.model import RawResult
    from ccsmoni.parser_usage import UsageTextParser

    taken_at = datetime.fromisoformat(args.taken_at) if args.taken_at else datetime.now(timezone.utc)
    if taken_at.tzinfo is None:
        taken_at = taken_at.astimezone()  # 指定にオフセットが無ければローカルタイムとみなす
    raw = RawResult(
        source="cli-usage",
        started_at=taken_at.astimezone(timezone.utc),
        duration_ms=0,
        text=Path(args.file).read_text(encoding="utf-8"),
        exit_code=0,
    )
    reading = UsageTextParser().parse(raw, "-")
    print(json.dumps(reading.to_dict(), ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    # Windows のコンソール（cp932）で表せない文字があっても落ちないようにする
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    args = build_parser().parse_args(argv)
    if args.command == "parse":
        return _cmd_parse(args)
    if args.command == "collect":
        return _cmd_collect(args)
    print(f"'{args.command}' は未実装です", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
