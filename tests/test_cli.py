"""cli のテスト（設定の誤りでの停止・起動済みの判定・tailscale-setup）。claude と tailscale は呼ばない。"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest

from ccsmoni import cli


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("CCSMONI_HOME", str(tmp_path))
    return tmp_path


def _server(body: bytes, content_type: str = "application/json"):
    """1つの応答だけを返す小さな HTTP サーバー（ポートは OS に任せる）。"""

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_config_error_exits_with_code_2_and_japanese_message(home, capsys):
    (home / "config.toml").write_text('[collector]\nclaude_path = "calc.exe"\n[ui]\nwarn_percent = 95\n', encoding="utf-8")
    assert cli.main(["serve", "--no-browser"]) == 2
    err = capsys.readouterr().err
    assert "設定ファイルに誤りがあるため、起動できません" in err and str(home / "config.toml") in err
    assert "collector.claude_path" in err and "ui" in err
    assert "Traceback" not in err
    # collect も同じ扱い（claude を呼ぶ前に止まる）
    assert cli.main(["collect", "--once"]) == 2


def test_config_syntax_error_exits_with_code_2(home, capsys):
    (home / "config.toml").write_text("[collector\n", encoding="utf-8")
    assert cli.main(["tailscale-setup"]) == 2
    assert "TOML として読めません" in capsys.readouterr().err


def test_probe_running_distinguishes_ccsmoni_from_other():
    ours = _server(json.dumps({"app": "ccsmoni", "version": "0.1.0"}).encode())
    other = _server(b"<html>other</html>", "text/html")
    try:
        assert cli._probe_running(ours.server_address[1]) == "ccsmoni"
        assert cli._probe_running(other.server_address[1]) == "other"
    finally:
        ours.shutdown()
        other.shutdown()
    assert cli._probe_running(ours.server_address[1]) in ("none", "other")  # 止めたあと


def test_serve_opens_existing_or_refuses_other_service(home, capsys, monkeypatch):
    opened: list[str] = []
    monkeypatch.setattr("webbrowser.open", opened.append)
    ours = _server(json.dumps({"app": "ccsmoni"}).encode())
    other = _server(b"{}")
    try:
        assert cli.main(["serve", "--port", str(ours.server_address[1])]) == 0
        assert "すでに起動しています" in capsys.readouterr().out
        assert opened == [f"http://127.0.0.1:{ours.server_address[1]}"]
        assert cli.main(["serve", "--no-browser", "--port", str(other.server_address[1])]) == 1
        assert "別のサービスが使っています" in capsys.readouterr().err
    finally:
        ours.shutdown()
        other.shutdown()


def test_tailscale_setup_uses_configured_port(home, capsys, monkeypatch):
    (home / "config.toml").write_text("[server]\nport = 8999\n", encoding="utf-8")
    monkeypatch.setattr("shutil.which", lambda name: "C:/fake/tailscale.exe" if name == "tailscale" else None)
    calls: list[list[str]] = []

    def run(args, check=False):
        calls.append(args)
        return SimpleNamespace(returncode=0)

    assert cli._cmd_tailscale_setup(SimpleNamespace(), run=run) == 0
    assert calls == [["C:/fake/tailscale.exe", "serve", "--bg", "8999"], ["C:/fake/tailscale.exe", "serve", "status"]]

    monkeypatch.setattr("shutil.which", lambda name: None)
    assert cli._cmd_tailscale_setup(SimpleNamespace(), run=run) == 1
    assert "tailscale が見つかりません" in capsys.readouterr().err
