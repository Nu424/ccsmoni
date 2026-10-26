# ccsmoni HTTP API（サーバーと UI の契約）

- サーバー: `ccsmoni serve`（FastAPI）。`127.0.0.1:<port>` にだけ bind する。静的 UI は `/` で配信する（`src/ccsmoni/static/`）。
- 時刻はすべて **epoch 秒（UTC）**。パーセントは 0〜100 の数値。
- POST/PUT は `Origin` ヘッダーを確認する。Origin がない（curl など）か、Host と同じオリジンなら許可し、それ以外は 403。
- エラーは `{"error": "<日本語の説明>", ...}` の形で返す。

## GET /api/state — 画面全体の現在の状態

UI はこれを 15 秒ごとに取得する。更新中（`collector.busy` が空でない）なら 2 秒ごと。

```jsonc
{
  "now": 1793066000,
  "collector": {
    "busy": ["acct-a"],               // いま取得中のアカウント id
    "last_run_at": 1793065400,        // 最後にどれかのアカウントを取得し終えた時刻
    "next_run_at": 1793066200         // 次にどれかのアカウントを取得する予定の時刻
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
      "next_run_at": 1793066200,
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
      "segments": [                   // 枠ごとの線。window_id が無い点（0%・枠が始まっていない）は単独の segment
        { "window_id": 12, "resets_at": 1793200000, "points": [[1792461200, 3.0], [1792461800, 4.0]] }
      ]
    }
  ],
  "resets": [ { "account_id": "acct-a", "kind": "weekly_all", "t": 1792800000 } ],   // リセット位置の縦線（範囲内に入る枠の切り替わり）
  "gaps": [ { "account_id": "acct-a", "from": 1792500000, "to": 1792540000 } ],      // 取得の間隔が interval の 3 倍を超えて空いた区間（PC のスリープなど）
  "errors": [ { "account_id": "acct-b", "t": 1792600000, "status": "logged_out" } ]
}
```

## GET /api/windows?kind=weekly_all&limit=8 — 週ごとのピーク表

```jsonc
{ "kind": "weekly_all",
  "rows": [ { "account_id": "acct-a", "windows": [ { "resets_at": 1793200000, "peak_percent": 63.0, "first_seen": 1792600000 } ] } ] }  // 新しい順
```

## POST /api/refresh — 今すぐ更新

本文 `{"account_id": "acct-a"}`（省略すると全アカウント）。202 を返し、取得はバックグラウンドで進む（進み具合は `/api/state` の `collector.busy` でわかる）。

## GET /api/config — 設定の取得

```jsonc
{ "config": { /* AppConfig を JSON にしたもの（collector / server / ui / accounts） */ },
  "hash": "<sha256>", "path": "C:\\...\\config.toml", "error": null,
  "candidates": [ /* /api/state と同じ */ ] }
```

## PUT /api/config — 設定の保存

本文 `{"config": {...}, "hash": "<読み込んだときの hash>"}`
- 200 `{"hash": "<新しい hash>"}`：保存して、すぐ反映する
- 409 `{"error": "設定ファイルが外部で変更されました", "hash": "<現在の hash>"}`
- 422 `{"error": "入力内容に誤りがあります", "fields": [["accounts.0.color", "色は #rrggbb の形式で指定してください"]]}`
- `server.host` / `server.port` の変更は、再起動するまで反映されない（レスポンスに `"restart_required": true`）

## POST /api/accounts/test — 接続テスト（保存しない）

本文 `{"config_dir": "~/x/acct-a"}` → 1 回だけ取得し、`{"status": "ok", "message": null, "plan": "max", "limits": [...]}` を返す。DB には保存しない。

## POST /api/accounts/{id}/login — ログイン

PC 上に `CLAUDE_CONFIG_DIR` を設定した `claude auth login` のコンソールを開き、202 を返す。進み具合は `/api/state` の `accounts[].login` に出る。
- ログイン完了（`auth status` が `loggedIn:true`）→ `orgId` を照合する。前回と同じなら `done`、違えば `mismatch`。どちらの場合もすぐ再取得する。
- 10 分たっても完了しなければ `timeout`。
