# ccsmoni HTTP API（サーバーと UI の契約）

- サーバー: `ccsmoni serve`（FastAPI）。ループバック（設定の `server.host`。127.0.0.1 / ::1 / localhost のみ。既定 127.0.0.1）の `<port>` にだけ bind する。tailnet への公開は `tailscale serve`（`ccsmoni tailscale-setup`）で行う。静的 UI（`src/ccsmoni/static/`）は `/` の直下で配信する（`/app.js` など。`/static/...` でも同じものが取れる）。
- 時刻はすべて **epoch 秒（UTC）**。パーセントは 0〜100 の数値。
- **Host の確認（すべてのリクエスト。GET・静的ファイルを含む）**: `Host` ヘッダーのホスト（ポートは問わない）が許可リストに無ければ 403 `{"error": "許可されていないホストへのリクエストです"}`。DNS rebinding（攻撃者のドメインを 127.0.0.1 に向け直してブラウザから読ませる）を防ぐため。許可リスト:
  - `127.0.0.1`、`localhost`、`[::1]`
  - `*.ts.net`（tailscale serve 経由。tailscale serve は Host をそのまま中継する）
  - 設定の `server.allowed_hosts`（既定は空。MagicDNS の短い名前などを足す）
- **Origin の確認（POST/PUT/PATCH/DELETE）**: `Origin` が無い（curl など）なら許可。あれば、Origin のホストが上の許可リストにあり、**かつ** Origin のホスト:ポートが `Host` と一致するときだけ許可し、それ以外（`Origin: null` を含む）は 403。`X-Forwarded-Host` は信頼しない（誰でも付けられるため）。
- エラーは `{"error": "<日本語の説明>", ...}` の形で返す。

## GET /api/health — 起動確認

`{"app": "ccsmoni", "version": "0.1.0"}`。`ccsmoni serve` は起動前に、設定のポートでこれを呼び、`app` が `ccsmoni` なら「起動済み」としてブラウザを開くだけで終わる。別の応答（または応答なし）でポートが使われていれば、別のサービスが使っている旨を表示して終了する。

## GET /api/state — 画面全体の現在の状態

UI はこれを 15 秒ごとに取得する。更新中（`collector.busy` が空でない）なら 2 秒ごと。

```jsonc
{
  "now": 1793066000,
  "collector": {
    "busy": ["acct-a"],               // 取得中、または順番待ち（同時実行数の空き待ち）のアカウント id
    "last_run_at": 1793065400,        // 最後にどれかのアカウントを取得し終えた時刻
    "next_run_at": 1793066200         // 次にどれかのアカウント（取得中・順番待ちのものを除く）を取得する予定の時刻。無ければ null
  },
  "ui": { "warn_percent": 70, "danger_percent": 90 },
  "config_error": null,               // 設定ファイルが壊れている・空・見つからないときは説明文（最後に有効だった設定で動き続ける）
  "config_hash": "<sha256>",          // いまの設定ファイルの内容の hash（壊れていても・無くても計算する）。
                                      // 設定画面は、読み込んだときの hash と違えば「外部で変更されました」と出せる
  "accounts": [                       // 設定の並び順。enabled=false のものも含める（UI 側で薄く表示）
    {
      "id": "acct-a",
      "label": "個人",
      "color": "#4f8cff",             // 解決済みの色（下記「色の割り当て」）。未設定でも必ず入る
      "enabled": true,
      "launch_command": "claude-acct-a",   // null 可
      "interval_minutes": 10,         // 実際に使われる間隔（既定値の解決済み）
      "next_run_at": 1793066200,      // 次に取得する予定の時刻。取得中（busy に入っている）・無効なアカウントは null
      "status": "ok",                 // ok | logged_out | error | timeout | parse_error | never（まだ一度も取得していない）
      "message": null,
      "taken_at": 1793065400,
      "stale": false,                 // 最終取得が interval の 3 倍より古い。enabled=false のアカウントは常に false
      "plan": "max",                  // null 可
      "limits": [                     // status=ok のときの値。ok 以外では []
        {
          "kind": "session", "label": "Current session", "percent": 47.0, "resets_at": 1793050000,
          "pace": {                   // insights が計算。resets_at が無ければ null
            "elapsed_ratio": 0.62,    // 枠の経過割合（0〜1）。5h 枠=5時間、週間枠=7日として計算
            "expected_percent": 62.0, // 「均等に使ったらこのくらい」の位置（バー上の目盛り）
            "eta_full": null          // このペースだと 100% に達する予測時刻（epoch）。リセットより前に達しないなら null
                                      // 速度は「枠の開始からの平均」。直近の履歴が十分（週間 24 時間分・5h 1 時間分）あるときだけ直近の速度。
                                      // 枠が始まって間もない（週間 12 時間未満・5h 30 分未満）ときは null（すでに 100% なら now）
          }
        }
      ],
      "last_ok": {                    // ok 以外のときに「最後にわかった値」を薄く表示するため。ok のときは null
        "taken_at": 1793000000, "limits": [ /* limits と同じ形 */ ]
      },
      "login": {                      // ログインの進行状態。何もしていなければ（または終わって 10 分たてば）null
        "state": "waiting",           // waiting | done | mismatch | failed | timeout
        "started_at": 1793065000,
        "finished_at": null,          // 終わった（完了・失敗・タイムアウトを確かめた）時刻。waiting の間は null
        "message": "PC 側にログイン画面を開きました"
      },
      "hints": [                      // 気の利く1行ヒント（0〜2件、重要な順）
        { "kind": "use_it_or_lose_it", "text": "週間リセットまで 20 時間・残り 36%。使わないと損です" },
        { "kind": "will_hit_limit", "text": "このペースだと 金 14:00 に週間上限" }
      ]
    }
  ],
  "archived": [                       // 履歴はあるが、設定にないアカウント（削除したもの）。id の昇順
    { "id": "acct-old", "label": "acct-old", "color": "#17c964" }   // label は id。color は下記「色の割り当て」
  ],
  "candidates": [                     // 未登録のアカウント候補（設定画面と、トップの控えめな通知に使う）
    { "suggested_id": "acct-x", "config_dir": "~/somewhere/acct-x" }
  ]
}
```

### 色の割り当て

`/api/state`（accounts・archived）と `/api/config`（colors）は、サーバーの同じ関数（`config.resolve_colors`）で色を決める。UI は自分で色を決めず、これを使う。
- 設定のアカウント: `color` の指定があればその色。なければ設定の並び順で `palette[index % palette.length]`。
- アーカイブ: id の昇順に、設定のアカウントが使っていないパレットの色から順に割り当てる（全部使われていればパレット全体から順に）。

## GET /api/history?range=7d&kinds=weekly_all,session&accounts=a,b

- `range`: `24h` | `7d` | `30d`（既定は `7d`）。`kinds` と `accounts` は省略すると全部。
- 線は枠（window）ごとに分けて返す。リセットをまたいで線をつながないため。

```jsonc
{
  "since": 1792461200, "until": 1793066000,
  "series": [
    {
      "account_id": "acct-a", "kind": "weekly_all",
      "segments": [                   // 線の切れ目ごとの区間（時刻順。下記）
        { "window_id": 12, "resets_at": 1793200000, "points": [[1792461200, 3.0], [1792461800, 4.0]] }
      ]
    }
  ],
  "resets": [ { "account_id": "acct-a", "kind": "weekly_all", "t": 1792800000 } ],   // リセット位置の縦線（範囲内に入る枠の切り替わり）
  "gaps": [ { "account_id": "acct-a", "from": 1792500000, "to": 1792540000 } ],      // 取得の抜け（PC のスリープなど。下記）
  "errors": [ { "account_id": "acct-b", "t": 1792600000, "status": "logged_out" } ]  // ok 以外の取得（下記）
}
```

- `segments` は、枠（window_id）が変わるところと、点の間隔が gaps と同じ基準（interval の 3 倍）を超えたところで分ける。
  そのため、同じ window_id が複数の segment に出ることがある（スリープをはさんだ同じ週など）。
  window_id が null の点（0%・枠が始まっていない）が続く部分は、まとめて1つの segment（window_id: null）にする。
- `gaps` は、同じアカウントの取得と取得（状態は問わない）の間が interval の 3 倍を超えたときの、その間（from = 前の取得、to = 次の取得）だけを返す。
  範囲の始まりより前・最後の取得より後は gaps にしない。
- `errors` は、ok 以外の取得を1件ずつ返す（続いていてもまとめない。続いたものを帯にまとめて描くのは UI 側）。

## GET /api/windows?kind=weekly_all&limit=8 — 週ごとのピーク表

`limit` はアカウントごとの枠の数（1〜52。範囲外は 422）。

```jsonc
{ "kind": "weekly_all",
  "rows": [ { "account_id": "acct-a", "windows": [ { "resets_at": 1793200000, "peak_percent": 63.0, "first_seen": 1792600000 } ] } ] }  // 新しい順
```

## POST /api/refresh — 今すぐ更新

本文 `{"account_id": "acct-a"}`（省略すると有効な全アカウント）。取得はバックグラウンドで進む（進み具合は `/api/state` の `collector.busy` でわかる）。
- 202 `{"started": ["acct-a"], "busy": ["acct-a", "acct-b"]}`：started は今回あらたに予約したアカウント（すでに取得中・順番待ちのものは入らない）、busy はその時点の collector.busy
- 404：有効なアカウントに無い id（未知の id・無効なアカウント）

## GET /api/config — 設定の取得

```jsonc
{ "config": { /* AppConfig を JSON にしたもの（collector / server / ui / accounts）。server.allowed_hosts を含む */ },
  "hash": "<sha256>", "path": "~/AppData/Local/ccsmoni/config.toml", "error": null,
  "candidates": [ /* /api/state と同じ */ ],
  "palette": ["#4f8cff", "#f5a524", "#17c964", "#f31260", "#9353d3", "#06b7db", "#f56d3b", "#7c8aa5"],  // サーバーと同じパレット
  "colors": { "acct-a": "#4f8cff", "acct-b": "#f5a524" },   // 設定のアカウントの解決済みの色（色が未設定のものも含む）
  "history_ids": ["acct-a", "acct-b", "acct-old"],          // DB に履歴がある id（昇順）。新しいアカウントの id がこれと重なれば
                                                             // UI は「この id には過去の履歴があります」と警告する
  "readonly": { "claude_path": "claude", "host": "127.0.0.1", "port": 8484 }   // ファイルでだけ編集できる項目（UI は表示だけ）
}
```

- `path`（と `candidates[].config_dir`、PUT の `backup_path`）はホーム配下なら `~/` で短縮し、区切りは `/` にそろえる（例 `~/AppData/Local/ccsmoni/config.toml`。画面やスクリーンショットにユーザー名を出さないため）。
- 設定ファイルが壊れている（TOML として読めない・検証に通らない・空・見つからない）ときは、`config` は最後に有効だった設定、`error` はその説明、
  `hash` は**そのときのファイル（壊れた内容）の hash** を返す。画面から保存すれば直せるようにするため
  （有効だった設定の hash を返すと、保存のたびに 409 になる）。保存したときの直り方は PUT を参照。

## PUT /api/config — 設定の保存

本文 `{"config": {...}, "hash": "<読み込んだときの hash>"}`
- 200 `{"hash": "<新しい hash>", "removed_keys": [], "backup_path": null}`：保存して、すぐ反映する
  - `removed_keys`: 既知のセクション（collector / server / ui / accounts）にあったスキーマ外のキーを取り除いたら、その名前（例 `["collector.typo", "accounts.0.colour"]`）。無ければ `[]`
  - `backup_path`: 既存のファイルが TOML の構文エラーだったときは、壊れたファイルを `config.toml.broken-<日時>` に退避し、新しい設定を初期生成と同じコメント付きの体裁で書き出す。その退避先（`~/` で短縮）。退避しなければ `null`
  - ファイルが空・見つからないときも、初期生成と同じ体裁で書き出す（退避はしない）
- 409 `{"error": "設定ファイルが外部で変更されました", "hash": "<現在の hash>"}`（置き換える直前にもう一度 hash を確かめる。その間に変更されていても 409）
- 422 `{"error": "入力内容に誤りがあります", "fields": [["accounts.0.color", "色は #rrggbb の形式で指定してください"]]}`
  - 書き出す予定の TOML 全体を、読み込みと同じ検証に通してから置き換える。通らなければ（例: 未知のセクションが残っている）422 で、ファイルは変わらない
- 422 `{"error": "この項目は設定ファイルで編集してください", "fields": [["collector.claude_path", "この項目は設定ファイルで編集してください"]]}`
  - `collector.claude_path`・`server.host`・`server.port` は Web から変えられない（任意のコマンドの実行・外部への公開を防ぐため）。いまの値と違う値が来たら 422。省略すればいまの値のまま
  - ファイルで編集する場合も、`claude_path` はファイル名の stem が `claude`（大文字小文字は問わない）のものだけ（UNC パス `\\server\...`・`//server/...` は不可）、`host` はループバック（127.0.0.1 / ::1 / localhost）だけ。host / port の変更は再起動するまで反映されない

## POST /api/accounts/test — 接続テスト（保存しない）

本文 `{"config_dir": "~/x/acct-a"}` → 1 回だけ取得し、`{"status": "ok", "message": null, "plan": "max", "limits": [...]}` を返す。DB には保存しない。
- 同時に1件まで。実行中に2件目が来たら 429 `{"error": "接続テストを実行中です"}`

## POST /api/accounts/{id}/login — ログイン

PC 上に `CLAUDE_CONFIG_DIR` を設定した `claude auth login` のコンソールを開き、202 `{"login": {"state": "waiting", "started_at": ..., "finished_at": null, "message": "..."}}`（`/api/state` の `accounts[].login` と同じ形）を返す。未知の id は 404。進み具合は `/api/state` の `accounts[].login` に出る。
- ログイン完了（`auth status` が `loggedIn:true`）→ `orgId` を照合する。前回と同じなら `done`、違えば `mismatch`。どちらの場合もすぐ再取得する（そのアカウントを取得中なら、その取得が終わったあとにもう一度取得する）。
- 10 分たっても完了しなければ `timeout`。
