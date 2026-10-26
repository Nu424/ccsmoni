# RESUME（作業再開用メモ）

セッションをまたいで作業を引き継ぐための状態メモ。計画は [docs/PLAN.md](docs/PLAN.md)、使い方は [README.md](README.md)。

## 現在地（2026-10-27）
- MVP 完成。計画のステップ 0〜10 は完了
- ダッシュボードは UI v2（docs/UI-V2.md）に作り直した。プロトタイプと比較は prototypes/。独立レビューへの対処は REVIEW.md の後半
  - 独立レビュー（Codex CLI と新規サブエージェント）の指摘への対処は [docs/REVIEW.md](docs/REVIEW.md) に記録
- テスト: `uv run pytest -q` で 150 件
- 実環境で動作確認済み（取得・ログイン切れの検知・画面表示・Host の検証）

## 未確認・残課題
- 実際のログイン操作（［ログイン］→ PC 上のコンソール → 完了 → 再取得）は、実アカウントでは未確認。デモと単体テストでは確認済み
- `tailscale serve` 経由での表示は未確認（Host をそのまま中継する前提で、Origin の確認を実装している）
- ファイルで host・port を変えたとき、再起動が必要なことを UI に知らせる手段がない
- 対応しないと判断したレビュー指摘は REVIEW.md の「×」を参照

## 守ること
- 実環境の情報（エイリアス名・パス・ホスト名など）はコミットしない。`local/`（git 管理外）に置く
  - pre-commit フックが `local/secret-words.txt` と、語の境界で照合する（`git config core.hooksPath .githooks` が必要）
- `claude` は引数配列で直接起動する（Git Bash 経由だと `/usage` がパスに化ける）。`--bare` は使わない。`--no-session-persistence` を付ける
- トークンには触れない（PLAN §3.3）
- 本番が動いているあいだは、`uv run --no-sync` を使う（exe が使用中で、sync に失敗するため）

## 将来の候補（PLAN §10）
通知、タスクスケジューラへの登録・タスクトレイ常駐、「次に使うアカウント」のおすすめ、「What's contributing」の表示
