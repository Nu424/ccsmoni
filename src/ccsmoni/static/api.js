// サーバーとの通信（docs/API.md の契約どおり）。
// 方針: fetch を薄く包むだけ。エラー時は { status, body } を持つ例外を投げ、
//       409 / 422 の扱いは呼び出し側（設定画面）で決める。

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function req(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    throw new ApiError(0, { error: "サーバーに接続できません" });
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  state: () => req("GET", "/api/state"),
  history: (range, kinds) => req("GET", `/api/history?range=${range}&kinds=${kinds.join(",")}`),
  windows: (kind = "weekly_all", limit = 8) => req("GET", `/api/windows?kind=${kind}&limit=${limit}`),
  refresh: (accountId) => req("POST", "/api/refresh", accountId ? { account_id: accountId } : {}),
  getConfig: () => req("GET", "/api/config"),
  putConfig: (config, hash) => req("PUT", "/api/config", { config, hash }),
  testAccount: (configDir) => req("POST", "/api/accounts/test", { config_dir: configDir }),
  login: (id) => req("POST", `/api/accounts/${encodeURIComponent(id)}/login`, {}),
};
