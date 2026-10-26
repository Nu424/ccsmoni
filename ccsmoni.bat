@echo off
chcp 65001 >nul
rem ccsmoni の起動用。ダブルクリックで起動し、ブラウザで開く。
rem   毎回 ccsmoni serve を呼ぶだけ。「すでに起動していれば、ブラウザで開くだけで終わる」の判定は serve 側が行う
rem   （設定ファイルの server.port を使い、/api/health の応答で ccsmoni かどうかを確かめる）。
rem   --setup-tailscale : tailnet 内（スマホなど）に公開する設定を行う（ccsmoni tailscale-setup。初回だけでよい）
rem 先頭で chcp 65001 にしているのは、日本語（UTF-8）の表示とこのファイル自体の読み込みを化けさせないため。
rem --project の "%~dp0." の末尾の . は、"C:\...\" の \" が引用符の文字として解釈されるのを避けるため。
setlocal

if /i "%~1"=="--setup-tailscale" goto :tailscale

title ccsmoni
uv run --project "%~dp0." ccsmoni serve
if errorlevel 1 (
  echo.
  echo ccsmoni を起動できなかったか、異常終了しました。上のメッセージを確認してください
  pause
)
exit /b

:tailscale
uv run --project "%~dp0." ccsmoni tailscale-setup
echo.
pause
exit /b
