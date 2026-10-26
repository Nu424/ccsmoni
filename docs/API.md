# ccsmoni HTTP API（サーバーと UI の契約）

- サーバー: `ccsmoni serve`（FastAPI）。`127.0.0.1:<port>` にだけ bind する。静的 UI（`src/ccsmoni/static/`）は `/` の直下で配信する（`/app.js` など。`/static/...` でも同じものが取れる）。
- 時刻はすべて **epoch 秒（UTC）**。パーセントは 0〜100 の数値。
- POST/PUT は `Origin` ヘッダーを確認する。Origin がない（curl など）か、Origin のホスト:ポートが `Host`（または `X-Forwarded-Host`。tailscale serve などの中継用）と同じなら許可し、それ以外は 403。
- エラーは `{"error": "<日本語の説明>", ...}` の形で返す。

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
  "config_error": null,               // 設定ファイルが壊れているときは説明文（最後に有効だった設定で動き続ける）
  "accounts": [                       // 設定の並び順。enabled=false のものも含める（UI 側で薄く表示）
    {
      "id": "acct-a",
      "label": "個人",
      "color": "#4f8cff",             // 未設定ならサーバーがパレットから決めて埋める
      "enabled": true,
      "launch_command": "claude-acct-a",   // null 可
      "interval_minutes": 10,         // 実際に使われる間隔（既定値の解決済み）
      "next_run_at": 1793066200,      // 次に取得する予定の時刻。取得中（busy に入っている）・無効なアカウントは null
      "status": "ok",                 // ok | logged_out | error | timeout | parse_error | never（まだ一度も取得していない）
      "message": null,
      "taken_at": 1793065400,
      "stale": false,                 // 最終取得が interval の 3 倍より古い
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
      "login": {                      // ログインの進行状態。何もしていなければ null
        "state": "waiting",           // waiting | done | mismatch | failed | timeout
        "started_at": 1793065000,
        "message": "PC 側にログイン画面を開きました"
      },
      "hints": [                      // 気の利く1行ヒント（0〜2件、重要な順）
        { "kind": "use_it_or_lose_it", "text": "週間リセットまで 20 時間・残り 36%。使わないと損です" },
        { "kind": "will_hit_limit", "text": "このペースだと 金 14:00 に週間上限" }
      ]
    }
  ],
  "candidates": [                     // 未登録のアカウント候補（設定画面と、トップの控えめな通知に使う）
    { "suggested_id": "acct-x", "config_dir": "~/somewhere/acct-x" }
  ]
}
```

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
{ "config": { /* AppConfig を JSON にしたもの（collector / server / ui / accounts） */ },
  "hash": "<sha256>", "path": "~\\AppData\\Local\\ccsmoni\\config.toml", "error": null,
  "candidates": [ /* /api/state と同じ */ ] }
```

- `path` はホーム配下なら `~` で短縮する（例 `~\AppData\Local\ccsmoni\config.toml`。画面やスクリーンショットにユーザー名を出さないため）。
- 設定ファイルが壊れている（TOML として読めない・検証に通らない）ときは、`config` は最後に有効だった設定、`error` はその説明、
  `hash` は**そのときのファイル（壊れた内容）の hash** を返す。画面から保存すれば壊れた内容を上書きして直せるようにするため
  （有効だった設定の hash を返すと、保存のたびに 409 になる）。

## PUT /api/config — 設定の保存

本文 `{"config": {...}, "hash": "<読み込んだときの hash>"}`
- 200 `{"hash": "<新しい hash>"}`：保存して、すぐ反映する
- 409 `{"error": "設定ファイルが外部で変更されました", "hash": "<現在の hash>"}`
- 422 `{"error": "入力内容に誤りがあります", "fields": [["accounts.0.color", "色は #rrggbb の形式で指定してください"]]}`
- `server.host` / `server.port` の変更は、再起動するまで反映されない（レスポンスに `"restart_required": true`）

## POST /api/accounts/test — 接続テスト（保存しない）

本文 `{"config_dir": "~/x/acct-a"}` → 1 回だけ取得し、`{"status": "ok", "message": null, "plan": "max", "limits": [...]}` を返す。DB には保存しない。

## POST /api/accounts/{id}/login — ログイン

PC 上に `CLAUDE_CONFIG_DIR` を設定した `claude auth login` のコンソールを開き、202 `{"login": {"state": "waiting", "started_at": ..., "message": "..."}}`（`/api/state` の `accounts[].login` と同じ形）を返す。未知の id は 404。進み具合は `/api/state` の `accounts[].login` に出る。
- ログイン完了（`auth status` が `loggedIn:true`）→ `orgId` を照合する。前回と同じなら `done`、違えば `mismatch`。どちらの場合もすぐ再取得する。
- 10 分たっても完了しなければ `timeout`。
