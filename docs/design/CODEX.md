# Codex 対応の設計メモ

Claude Code と同じように、OpenAI Codex（`codex` CLI）のアカウントの利用状況（5h 枠・週間枠）も記録して、推移を見られるようにする。

## 方針（決めたこと）

- データは、改変していない `codex` CLI から取る。ログイン情報（`auth.json` のトークン）は読み取りも保存もしない。Claude と同じ方針。
- 見たいのは Claude と同じ「推移」。日ごとのトークン数（`account/usage/read`）は記録しない。
- アカウントは「Codex の設定フォルダ」（環境変数 `CODEX_HOME`）の単位で扱う。Claude の `CLAUDE_CONFIG_DIR` と同じ考え方。
- 画面・分析・保存は、Claude と同じ形（`Reading` / `Limit`）にそろえてから渡す。下流には provider の違いを持ち込まない。

## 取得方法

`codex app-server`（IDE 連携用のサーバー。標準入出力で JSON-RPC を1行ずつやり取りする）を起動し、次の順に送る。

```
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name":"ccsmoni","version":"<版>"}}}
→ {"method":"initialized"}
→ {"id":2,"method":"account/read","params":{"refreshToken":false}}   # ログイン状態・プラン
→ {"id":3,"method":"account/rateLimits/read"}                         # 使用率（ログイン中のときだけ）
（標準入力を閉じると終了する）
```

- モデルは呼ばれないので、料金はかからない。1回 3〜4 秒。
- `account/read` の `account` が `null` なら未ログイン。このとき `rateLimits/read` はエラー（-32600）になるので、呼ばない。
- CLI の版は、`initialize` の応答の `userAgent`（`<name>/<版> (...)`）から取る。`--version` を別に呼ばなくて済む。
- app-server には `[experimental]` と付いている。形式が変わってもいいように、応答を（下の「残すもの」だけに絞って）raw として保存し、`ccsmoni reparse` で作り直せるようにする。
- 形式は `codex app-server generate-json-schema --out <dir>` で確かめられる（`v2/GetAccountRateLimitsResponse.json`）。

### 枠の対応

`rateLimitsByLimitId`（無ければ `rateLimits`）の各要素の `primary` / `secondary` を、`windowDurationMins` で振り分ける。プランによって、週間枠だけが `primary` に入ることがある（`secondary` は null）。なので、位置ではなく長さで判断する。

| limitId | 長さ（分） | kind | label |
|---|---|---|---|
| `codex` | 300 | `session` | `5h limit` |
| `codex` | 10080 | `weekly_all` | `Weekly limit` |
| それ以外 | 10080 | `weekly_model:<limitName か limitId>` | `Weekly limit (<名前>)` |
| それ以外 | 300 | `session_model:<名前>` | `5h limit (<名前>)`（今の UI では表示しない） |
| どれでも | その他 | `window_<分>m[:<名前>]` | 保存だけする |

- `usedPercent` は `percent` に、`resetsAt`（UNIX 秒）は `resets_at`（UTC）にする。
- 1つも読めなければ `parse_error`。

### 残すもの・捨てるもの（プライバシー）

| 応答 | 残すもの | 捨てるもの |
|---|---|---|
| `account/read` | `type`、`planType`、ログイン中かどうか | `email`、`workspaceRouting` |
| `account/rateLimits/read` | 各 snapshot の `limitId` / `limitName` / `primary` / `secondary` / `planType` / `rateLimitReachedType`、`ordinaryUsageAllowed` | `accountId`、`credits`、`individualLimit`、`rateLimitUpsell`、リセットクレジットの詳細 |

- ログイン後に「前と同じアカウントか」を確かめるため、Claude の `orgId` に当たる値を残す。ただし `chatgptAccountId` そのものではなく、SHA-256 の先頭 16 桁（`codex:<id>` のハッシュ）にする。
- エラーメッセージは、メールアドレス風の文字列を伏せてから残す。
- app-server の stderr は読まない。警告にユーザー名を含むパスが出ることがあるため。

## ログイン

［ログイン］では、`CODEX_HOME` を設定した `codex login` を新しいコンソールで開く（ブラウザで認証する。ccsmoni はコードやトークンに触れない）。完了の確認は、取得と同じ `account/read` で行う。

## 設定

```toml
[collector]
codex_path = "codex"            # ファイルでだけ編集できる（ファイル名が codex のものだけ）

[[accounts]]
id = "codex-a"
label = "Codex"
provider = "codex"              # 省略すると claude
config_dir = "~/.codex"         # CODEX_HOME に渡す
```

- `provider` は、画面では新しく追加するアカウントにだけ選べる（id と同じく、保存したあとは変えない）。
- `provider = "claude"` はファイルに書かない（既存の設定ファイルを変えないため）。
- 未登録の検出: `auth.json` があり、さらに `config.toml` か `sessions/` もあるフォルダを Codex の設定フォルダとみなす。`auth.json` は存在だけを見て、中身は読まない。名前に `codex` を含む隠しフォルダには入って探す（Claude の場合と同じ扱い）。

## 構成

- `probes/codex_app_server.py`: `CodexAppServerSource`（kind `codex-app-server`）
- `parser_codex.py`: `CodexRateLimitsParser`
- `probes/routing.py`: `RoutingSource`（`account.provider` で振り分ける）と `RoutingParser`（`raw.source` で振り分ける。reparse でも使う）
- `Scheduler` は今までどおり Probe を1つだけ持ち、その Probe が中で振り分ける。
