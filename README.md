# ccsmoni（ししすもに）

**Claude Code s monitor** — 複数の Claude アカウントの利用状況（5時間枠・週間枠）を定期的に取得・記録し、**推移**をダッシュボードで見られるようにする個人用ツールです。

- 全アカウントの週間枠・5h枠の使用率を時系列のグラフで重ねて表示。凡例を押すと表示／非表示が切り替わります
- 今の使用率、リセットまでの残り時間、ペースの目盛り、「このペースだと 金 14:00 に上限」「使わないと損」のヒントをカードで表示
- 週ごとのピーク使用率の表
- ログイン切れを検知し、［ログイン］を押すと PC 上にログイン用のコンソールが開きます
- 設定は画面から編集できます（中身は TOML ファイルで、直接編集しても自動で反映されます）
- tailscale serve を使えば、tailnet 内のスマホからも見られます

## しくみ

```
claude auth status --json            ← ログイン状態の確認（約0.3秒）
claude -p /usage --output-format json --no-session-persistence
                                      ← 使用率の取得（モデルは呼ばれず、料金はかからない。2〜4秒）
   │  アカウントごとに CLAUDE_CONFIG_DIR を切り替えて実行
   ▼
パース → SQLite に記録（生のテキストも保存）→ FastAPI + ダッシュボード
```

- ccsmoni が実行するのは、改変していない `claude` CLI の公式の機能だけです。**ログイン情報（トークン）には一切触れません**。理由は [docs/PLAN.md §3.3](docs/PLAN.md) を参照してください。
- 生のテキストを保存しているので、`/usage` の表示形式が変わっても、パーサーを直せば `ccsmoni reparse` で過去分を作り直せます。

## 必要なもの

- Windows（動作確認は Windows 11）
- [uv](https://docs.astral.sh/uv/)（Python は uv が用意します）
- `claude`（Claude Code CLI）に PATH が通っていること
- （スマホから見るなら）Tailscale

## 使い方

### 起動

`ccsmoni.bat` をダブルクリックします。

- 初回は依存関係をインストールしてから起動し、ブラウザでダッシュボードが開きます。
- すでに起動しているときは、ブラウザで開くだけです。
- コンソールウィンドウを閉じると止まります。

コマンドラインから起動するなら `uv run ccsmoni serve` です。

### 初回の設定

- 初回の起動時に、ホームフォルダ以下（深さ2まで）から Claude の設定フォルダ（`.credentials.json` か `.claude.json` があるフォルダ）を探し、見つかったものをアカウントとして登録します。
- 画面の「設定」で次の操作ができます。
  - 表示名・起動コマンド（ログイン案内やコピーに使う。例: `claude-work`）・色・取得間隔を変える
  - 監視しないアカウントを無効にする
  - 並べ替える
- 設定ファイルの場所: `%LOCALAPPDATA%\ccsmoni\config.toml`
  - 環境変数 `CCSMONI_HOME` で場所を変えられます。
  - DB（`ccsmoni.db`）も同じ場所にあります。

画面からは変えられず、設定ファイルでだけ編集できる項目（安全のため）:
- `collector.claude_path`: 実行する claude。ファイル名が `claude` のものだけ
- `server.host`: ループバックだけ
- `server.port`

### スマホから見る（tailscale serve）

```
ccsmoni.bat --setup-tailscale
```

- ccsmoni 専用の HTTPS ポート（既定 8484）で公開し、`https://<PC名>.<tailnet名>.ts.net:8484/` で開けるようにします（`tailscale serve --bg --https=8484 http://127.0.0.1:8484`）。設定は Tailscale 側に保存されるので、実行するのは初回だけです。
- **同じ PC で別のアプリが tailscale serve を使っていても、ぶつかりません**。既定の `https://<PC名>.ts.net/`（443 番）の設定には触れないためです。設定する前に現在の設定を読み、同じポートを別の転送先が使っていれば、上書きせずに止まります（その場合は `server.port` を変えてください）。
- ccsmoni 自体は `127.0.0.1` にだけ bind します。
- ccsmoni には認証がありません。**自分だけの tailnet での利用を前提**にしています。tailnet を他の人と共有している場合は、Tailscale の ACL で、この PC へのアクセスを制限してください。
- `*.ts.net` 以外の名前（MagicDNS の短い名前など）で開く場合は、`server.allowed_hosts` に追加してください。許可していない Host からのリクエストは拒否します（DNS rebinding 対策）。

### ログインが切れたとき

カードの［ログイン］を押すと、**PC 上に**そのアカウント用の `claude auth login` のコンソールが開きます。

- いつも通りブラウザでログインしてください。
- 完了すると自動で再取得し、カードが OK に戻ります。
- ブラウザで別のアカウントにログインしていた場合は、「別のアカウントでログインした可能性」と警告します。

## コマンド

| コマンド | 内容 |
|---|---|
| `ccsmoni serve [--port N] [--no-browser]` | 常駐して定期取得し、ダッシュボードを配信する |
| `ccsmoni collect --once --print [--save]` | 1回だけ取得して表で表示する（`--save` を付けると DB に保存） |
| `ccsmoni parse <file>` | 保存した `/usage` のテキストをパースして JSON で表示する |
| `ccsmoni reparse` | 保存済みの生テキストから、DB の解釈結果を作り直す |
| `ccsmoni tailscale-setup` | tailscale serve を設定する |
| `ccsmoni demo --home <dir> [--accounts N]` | 架空のアカウント（既定4件。`--accounts` で4〜12件）と30日分の合成履歴を作る（UI の確認用。`CCSMONI_HOME=<dir> ccsmoni serve --demo` で表示する） |

コマンドは `uv run ccsmoni ...` の形で実行します。

## 開発

```
uv sync
uv run pytest -q
git config core.hooksPath .githooks   # コミット前の機密チェックを有効にする
```

- 計画と設計: [docs/PLAN.md](docs/PLAN.md)
- サーバーと UI の API の契約: [docs/API.md](docs/API.md)
- レビューの記録: [docs/REVIEW.md](docs/REVIEW.md)
- 作業再開用のメモ: [RESUME.md](RESUME.md)
- **機密の扱い**: 実環境の情報（エイリアス名・パス・ホスト名など）はリポジトリに入れません。`local/`（git 管理外）に置いた `secret-words.txt` と照合する pre-commit フックがあります。
- 構成: `src/ccsmoni/` の下に次のファイルがあります。
  - `parser_usage.py`（パーサー）
  - `probes/`（取得方法。差し替えられる）
  - `store.py`（SQLite）
  - `insights.py`（ペース・ヒント・系列の組み立て）
  - `scheduler.py`
  - `login.py`
  - `config.py`
  - `web.py`
  - `static/`（ビルド不要の UI。グラフは uPlot を同梱）
