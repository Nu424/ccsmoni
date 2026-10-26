"""コマンドライン入口。各サブコマンドは、対応するモジュールを単体で動かすための口でもある。"""

from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ccsmoni", description="Claude Code s monitor — 利用状況の記録と可視化")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("serve", help="常駐して定期取得し、ダッシュボードを配信する")
    return p


def main(argv: list[str] | None = None) -> int:
    # Windows のコンソール（cp932）で表せない文字があっても落ちないようにする
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    args = build_parser().parse_args(argv)
    print(f"'{args.command}' は未実装です", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
