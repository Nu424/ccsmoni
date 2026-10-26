"""コマンドライン入口。各サブコマンドは、対応するモジュールを単体で動かすための口でもある。"""

from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ccsmoni", description="Claude Code s monitor — 利用状況の記録と可視化")
    sub = p.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="常駐して定期取得し、ダッシュボードを配信する")
    serve.add_argument("--port", type=int, help="待ち受けるポート（省略時は設定の server.port）")
    serve.add_argument("--no-browser", action="store_true", help="起動後にブラウザを開かない")
    serve.add_argument("--demo", action="store_true", help="claude を呼ばず、デモの架空データで動かす（ccsmoni demo で作った CCSMONI_HOME 専用）")
    parse = sub.add_parser("parse", help="保存済みの /usage テキストを読み、Reading の JSON を出力する")
    parse.add_argument("file", help="/usage の出力を保存したテキストファイル")
    parse.add_argument("--taken-at", help="取得時刻（ISO 8601。省略時は現在時刻）")
    collect = sub.add_parser("collect", help="claude CLI で各アカウントの /usage を取得する")
    collect.add_argument("--once", action="store_true", help="1回だけ取得して終了する")
    collect.add_argument("--print", action="store_true", dest="print_table", help="結果を表で表示する")
    collect.add_argument("--config-dir", action="append", help="CLAUDE_CONFIG_DIR（複数指定可。id はディレクトリ名）。省略時は設定の有効なアカウント")
    collect.add_argument("--save", action="store_true", help="結果を DB に保存する")
    sub.add_parser("reparse", help="保存済みの raw をパーサーで読み直し、DB の解釈結果を作り直す")
    sub.add_parser(
        "tailscale-setup",
        help="tailnet 内（スマホなど）に公開する設定を行う（専用の HTTPS ポートで tailscale serve。既存の公開設定には触れない。初回だけでよい）",
    )
    demo = sub.add_parser("demo", help="架空の 4 アカウントの設定と 30 日分の合成履歴を作る（UI の確認用）")
    demo.add_argument("--home", required=True, help="作成先のディレクトリ（serve するときは CCSMONI_HOME にこれを指定）")
    demo.add_argument("--days", type=float, default=30, help="履歴の日数（既定 30。小数も可: 0.05 ≒ 1 時間。記録を始めたばかりの画面の確認用）")
    demo.add_argument("--force", action="store_true", help="既存のデモを作り直す")
    return p


# 設定ファイルの誤りで止めるときの終了コード（bat などから区別できるように、一般の失敗 1 と分ける）
EXIT_CONFIG_ERROR = 2


class _ConfigExit(Exception):
    """設定ファイルの誤りで止める（メッセージは表示済み）。"""


def _print_config_error(path, e) -> None:
    """設定ファイルの誤りを、トレースバックではなく日本語で表示する（どのファイルの、どの項目か）。"""
    print(f"設定ファイルに誤りがあるため、起動できません: {path}", file=sys.stderr)
    for field, msg in e.errors:
        print(f"  - {field}: {msg}", file=sys.stderr)
    print("設定ファイルを直してから、もう一度実行してください", file=sys.stderr)


def _load_config(service=None):
    """設定を読み込む（無ければ作る）。誤りがあればメッセージを表示して _ConfigExit。"""
    from ccsmoni.config import ConfigService, ConfigValidationError, config_path

    cs = service or ConfigService(config_path())
    try:
        cs.load()
    except ConfigValidationError as e:
        _print_config_error(cs.path, e)
        raise _ConfigExit() from e
    return cs


def _cmd_collect(args: argparse.Namespace) -> int:
    # --config-dir を指定したらそのディレクトリ（id はディレクトリ名）、省略したら設定の有効なアカウントを取得する。
    # 並列にはせず順に取得する（認証まわりの競合を避けるため）。
    from pathlib import Path

    from ccsmoni.config import AppConfig, config_path, db_path
    from ccsmoni.model import Account
    from ccsmoni.scheduler import default_probe_factory

    # ディレクトリを直接指定したときは、設定ファイルが無くても作らない（既定値で取得する）
    if args.config_dir and not config_path().exists():
        cfg = AppConfig()
    else:
        cfg = _load_config().current
    probe = default_probe_factory(cfg)
    if args.config_dir:
        accounts = []
        for d in args.config_dir:
            path = Path(d).expanduser().resolve()
            accounts.append(Account(id=path.name, label=path.name, config_dir=path))
    else:
        accounts = cfg.active_accounts()
        if not accounts:
            print(f"有効なアカウントがありません（設定: {config_path()}）", file=sys.stderr)
            return 1

    store = None
    if args.save:
        from ccsmoni.store import Store

        db_path().parent.mkdir(parents=True, exist_ok=True)
        store = Store(db_path())
    rows = []
    try:
        for account in accounts:
            raw, reading = probe.run(account)
            if store is not None:
                store.save(raw, reading)
            session = reading.limit("session")
            weekly = reading.limit("weekly_all")
            resets = next((lim.resets_at for lim in reading.limits if lim.resets_at), None)
            rows.append((
                account.id,
                str(reading.status),
                f"{session.percent:g}%" if session else "-",
                f"{weekly.percent:g}%" if weekly else "-",
                resets.astimezone().strftime("%m/%d %H:%M") if resets else "-",
                f"{raw.duration_ms / 1000:.1f}s",
            ))
    finally:
        if store is not None:
            store.close()
    header = ("id", "status", "session%", "weekly%", "resets", "time")
    widths = [max(len(str(r[i])) for r in [header, *rows]) for i in range(len(header))]
    for r in [header, *rows]:
        print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))
    if store is not None:
        print(f"{len(rows)} 件を保存しました")
    return 0


def _cmd_reparse(args: argparse.Namespace) -> int:
    from ccsmoni.config import db_path
    from ccsmoni.parser_usage import UsageTextParser
    from ccsmoni.store import Store

    if not db_path().exists():
        print(f"DB がありません: {db_path()}", file=sys.stderr)
        return 1
    store = Store(db_path())
    try:
        n = store.reparse(UsageTextParser())
    finally:
        store.close()
    print(f"{n} 件を読み直しました")
    return 0


def _cmd_demo(args: argparse.Namespace) -> int:
    from pathlib import Path

    from ccsmoni.demo import create_demo_home

    home = Path(args.home).expanduser().resolve()
    try:
        counts = create_demo_home(home, days=args.days, force=args.force)
    except FileExistsError as e:
        print(str(e), file=sys.stderr)
        return 1
    print(f"デモを作りました: {home}")
    for aid, n in counts.items():
        print(f"  {aid}: {n} 件")
    print("起動するには（PowerShell）:")
    print(f'  $env:CCSMONI_HOME = "{home}"; uv run ccsmoni serve --demo')
    return 0


def _port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    import socket

    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _probe_running(port: int, timeout: float = 2.0) -> str:
    """そのポートで何が動いているかを調べる。"ccsmoni" / "other"（別のサービス）/ "none"（何も動いていない）。

    GET /api/health が {"app": "ccsmoni"} を返したときだけ ccsmoni とみなす（ポートが開いているだけでは判断しない）。
    """
    import json
    import urllib.error
    import urllib.request

    if not _port_open("127.0.0.1", port):
        return "none"
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return "other"
    return "ccsmoni" if isinstance(data, dict) and data.get("app") == "ccsmoni" else "other"


def _cmd_serve(args: argparse.Namespace) -> int:
    # すでに ccsmoni が起動していれば、ブラウザで開くだけで終わる（ccsmoni.bat は毎回これを呼ぶ）。
    # 起動していなければ常駐し、準備ができたら（ポートに接続できたら）既定のブラウザで開く。
    import logging
    import threading
    import time
    import webbrowser

    import uvicorn

    from ccsmoni.config import app_home
    from ccsmoni.web import build_services, create_app

    logging.basicConfig(
        level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(message)s", datefmt="%m/%d %H:%M:%S"
    )
    if args.demo:
        from ccsmoni.demo import DEMO_MARKER

        if not (app_home() / DEMO_MARKER).exists():
            print(
                "--demo は、ccsmoni demo --home <dir> で作ったディレクトリを CCSMONI_HOME に指定したときだけ使えます",
                file=sys.stderr,
            )
            return 1

    app_home().mkdir(parents=True, exist_ok=True)
    cs = _load_config()
    cfg = cs.current
    host = cfg.server.host
    port = args.port or cfg.server.port
    url = f"http://127.0.0.1:{port}"
    running = _probe_running(port)
    if running == "ccsmoni":
        print(f"すでに起動しています: {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0
    if running == "other":
        print(
            f"ポート {port} は別のサービスが使っています。設定ファイルの server.port を変えてください（{cs.path}）",
            file=sys.stderr,
        )
        return 1

    services = build_services(demo=args.demo, config_service=cs)

    def open_when_ready() -> None:
        for _ in range(120):
            if _port_open("127.0.0.1", port):
                webbrowser.open(url)
                return
            time.sleep(0.25)

    if not args.no_browser:
        threading.Thread(target=open_when_ready, daemon=True).start()
    print(f"ccsmoni を起動します: {url}" + ("（デモ）" if args.demo else ""), flush=True)
    print("このウィンドウを閉じると止まります", flush=True)
    app = create_app(services)
    try:
        uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False)
    finally:
        services.store.close()
    return 0


def _cmd_tailscale_setup(args: argparse.Namespace, run=None) -> int:
    """設定のポートを tailscale serve で tailnet 内に公開し、状態を表示する。設定は tailscale 側に保持される。

    方針: 既定の https（443 番）の「/」は、同じ PC の別のアプリがすでに使っていることがある。上書きして壊さないよう、
    ccsmoni は**専用の HTTPS ポート**（ローカルと同じ番号。例 https://<PC>.ts.net:8484/）で公開する。
    パス（/ccsmoni など）で同居させる方式は、アプリ側をサブパス対応にする必要があるので採らない。
    設定する前に現在の serve の設定を読み、そのポートを別の転送先が使っていれば、何もせずに止める。
    """
    import json
    import shutil
    import subprocess

    run = run or subprocess.run
    port = _load_config().current.server.port
    exe = shutil.which("tailscale")
    if exe is None:
        print("tailscale が見つかりません。Tailscale をインストールしてから、もう一度実行してください", file=sys.stderr)
        return 1

    target = f"http://127.0.0.1:{port}"
    st = run([exe, "serve", "status", "--json"], check=False, capture_output=True, text=True)
    try:
        web = (json.loads(st.stdout or "{}") or {}).get("Web") or {}
    except json.JSONDecodeError:
        web = {}
    # 例: {"pc.tailnet.ts.net:8484": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8484"}}}}
    for hostport, conf in web.items():
        if not hostport.endswith(f":{port}"):
            continue
        proxies = {h.get("Proxy") for h in (conf.get("Handlers") or {}).values()}
        if proxies == {target}:
            print(f"すでに設定済みです: https://{hostport.removesuffix(':443')}/")
            return 0
        print(
            f"HTTPS ポート {port} は、tailscale serve の別の設定がすでに使っています（{', '.join(sorted(p for p in proxies if p))}）。\n"
            "上書きしないので、設定ファイルの server.port を別の番号に変えてから、もう一度実行してください",
            file=sys.stderr,
        )
        return 1

    print(f"tailscale serve --bg --https={port} {target} を設定します（既存の公開設定には触れません）")
    r = run([exe, "serve", "--bg", f"--https={port}", target], check=False)
    if r.returncode != 0:
        print("tailscale serve の設定に失敗しました。上のメッセージを確認してください", file=sys.stderr)
        return 1
    print()
    run([exe, "serve", "status"], check=False)
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
    commands = {
        "parse": _cmd_parse,
        "collect": _cmd_collect,
        "reparse": _cmd_reparse,
        "demo": _cmd_demo,
        "serve": _cmd_serve,
        "tailscale-setup": _cmd_tailscale_setup,
    }
    if args.command not in commands:
        print(f"'{args.command}' は未実装です", file=sys.stderr)
        return 1
    try:
        return commands[args.command](args)
    except _ConfigExit:
        return EXIT_CONFIG_ERROR


if __name__ == "__main__":
    sys.exit(main())
