# RESUME（作業再開用メモ）

セッションをまたいで作業を引き継ぐための状態メモ。計画の全体は [docs/PLAN.md](docs/PLAN.md)。

## 現在地
- 計画は確定（PLAN v3）。ステップ0〜4（土台・パーサー・取得・保存・設定）完了
- 進行中: サーバー側（scheduler / insights / login / web / bat）と UI（static/）。UI とサーバーの契約は docs/API.md

## 守ること
- 実環境の情報（エイリアス名・パス・ホスト名など）はコミットしない。`local/`（git 管理外）に置く。pre-commit フックが `local/secret-words.txt` と照合する（`git config core.hooksPath .githooks` が必要）
- `claude` は引数配列で直接起動する（Git Bash 経由だと `/usage` がパスに化ける）。`--bare` は使わない。`--no-session-persistence` を付ける
- トークンには触れない（PLAN §3.3）

## 次にやること
- サーバー・UI の統合 → 実環境での確認 → ログインの実機確認 → 独立レビュー → README
