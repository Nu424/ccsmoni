@echo off
chcp 65001 >nul
rem ccsmoni の起動用。ダブルクリックで起動し、ブラウザで開く。
rem   1. すでに起動していれば（ポートに接続できれば）、ブラウザで開いて終わる
rem   2. 起動していなければ、このウィンドウで ccsmoni serve を動かす（準備ができると serve がブラウザを開く）
rem   --setup-tailscale : tailnet 内（スマホなど）に公開する設定を行う（初回だけでよい。設定は tailscale 側に保持される）
rem ポートは設定ファイルの server.port と合わせる（既定 8484）。
rem 先頭で chcp 65001 にしているのは、日本語（UTF-8）の表示とこのファイル自体の読み込みを化けさせないため。
setlocal
set "PORT=8484"
set "URL=http://127.0.0.1:%PORT%"

if /i "%~1"=="--setup-tailscale" goto :tailscale

curl.exe -s -o nul -m 2 "%URL%/api/state"
if not errorlevel 1 goto :open

title ccsmoni
echo ccsmoni を起動します: %URL%
echo このウィンドウを閉じると止まります
echo.
uv run --project "%~dp0." ccsmoni serve
if errorlevel 1 (
  echo.
  echo ccsmoni が異常終了しました。上のメッセージを確認してください
  pause
)
exit /b

:open
start "" "%URL%"
exit /b 0

:tailscale
echo tailscale serve --bg %PORT% を設定します
tailscale serve --bg %PORT%
echo.
tailscale serve status
echo.
pause
exit /b
