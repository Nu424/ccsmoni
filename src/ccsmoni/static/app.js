// アプリ全体の骨組み。
// 何を: ハッシュルーティング（#/ と #/settings）、/api/state の定期取得、ヘッダー（最終更新・次回・今すぐ更新・テーマ）、
//       毎秒の時刻表示の更新。
// なぜ: 画面ごとの処理（dashboard.js / settings.js）から「いつ取りに行くか」「時計」を切り離し、
//       どの画面でも同じリズムで状態が新しくなるようにするため。
// 方針: store（1つのオブジェクト）に最新のサーバー状態を入れ、変わったら今の画面の onState() を呼ぶ。
//       画面は mount / unmount / onState を持つ小さなオブジェクト。

import { api } from "./api.js";
import { h, setChildren, fmtAgo, fmtIn, fmtCountdown, spinner, toast, savePref, loginRetaken } from "./ui.js";
import { createDashboard } from "./dashboard.js";
import { createSettings } from "./settings.js";

const store = {
  server: null,          // 最後に取れた /api/state
  clockOffset: 0,        // サーバー時刻 − ブラウザ時刻（秒）。カウントダウンをサーバー基準にする
  connError: false,      // 直近の取得に失敗したか
  refreshPending: false, // ［今すぐ更新］を押してから、busy が空に戻るまで
  refreshSawBusy: false,
  refreshStartedAt: 0,
};

const ctx = {
  store,
  now: () => Date.now() / 1000 + store.clockOffset,
  refreshAll: () => startRefresh(),
  refreshState: () => pollNow(),
};

const views = { dash: createDashboard(ctx), settings: createSettings(ctx) };
let current = null;
let currentName = null;
const viewEl = document.getElementById("view");

// ---- ルーティング ------------------------------------------------------------
// 設定に未保存の変更があるときは、離れる前に確認する（戻るとそのまま編集を続けられる）。
function routeName() {
  return location.hash.startsWith("#/settings") ? "settings" : "dash";
}
let lastHash = location.hash;
function route() {
  const name = routeName();
  if (current && currentName === "settings" && name !== "settings" && current.isDirty && current.isDirty()) {
    if (!confirm("保存していない変更があります。破棄して移動しますか？")) {
      history.replaceState(null, "", lastHash || "#/settings");
      return;
    }
    current.discard && current.discard();
  }
  lastHash = location.hash;
  if (name === currentName) return;
  current && current.unmount();
  viewEl.replaceChildren();
  currentName = name;
  current = views[name];
  current.mount(viewEl);
  if (store.server) current.onState(store.server);
  document.querySelectorAll(".tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.route === name ? "page" : "false"));
  window.scrollTo(0, 0);
  renderBanner(); // 設定画面では「設定ファイルに誤り」の帯を画面側に任せるので、移動のたびに出し直す
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => {
  if (views.settings.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});

// ---- 状態の定期取得 -------------------------------------------------------------
// 通常 15 秒ごと。取得中・ログイン待ち・更新ボタン直後は 2 秒ごとにして、変化をすぐ映す。
let pollTimer = null;
let polling = false;
async function pollNow() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    const s = await api.state();
    const prev = store.server;
    store.clockOffset = s.now - Date.now() / 1000;
    store.server = s;
    store.connError = false;
    trackRefresh(prev, s);
    current && current.onState(s, prev);
  } catch {
    store.connError = true;
  }
  polling = false;
  renderBanner();
  renderHeader();
  pollTimer = setTimeout(pollNow, fastPoll() ? 2000 : 15000);
}
function fastPoll() {
  const s = store.server;
  if (store.refreshPending || store.connError) return true;
  if (!s) return true;
  return s.collector.busy.length > 0 || s.accounts.some((a) => a.login && a.login.state === "waiting") ||
    s.accounts.some((a) => a.login && a.login.state === "done" && !loginRetaken(a));

}

// ---- 今すぐ更新 ---------------------------------------------------------------
// 押す → POST /api/refresh → busy が出て、空に戻ったら完了。busy が一度も見えないまま
// 8 秒たったら（取得が一瞬で終わった等）完了とみなす。
async function startRefresh(accountId) {
  if (store.refreshPending) return;
  store.refreshPending = true;
  store.refreshSawBusy = false;
  store.refreshStartedAt = Date.now();
  renderHeader();
  try {
    await api.refresh(accountId);
  } catch (e) {
    store.refreshPending = false;
    toast(e.message || "更新を始められませんでした", "danger");
    renderHeader();
    return;
  }
  setTimeout(pollNow, 400);
}
ctx.refreshOne = (id) => api.refresh(id).then(() => setTimeout(pollNow, 400)).catch((e) => toast(e.message, "danger"));

function trackRefresh(prev, s) {
  const busy = s.collector.busy.length > 0;
  if (store.refreshPending) {
    if (busy) store.refreshSawBusy = true;
    else if (store.refreshSawBusy || Date.now() - store.refreshStartedAt > 8000) {
      store.refreshPending = false;
      toast("更新しました", "ok", 1800);
      flashRunInfo();
    }
  } else if (prev && prev.collector.last_run_at !== s.collector.last_run_at) {
    flashRunInfo();
  }
}

// ---- ヘッダー ---------------------------------------------------------------------
const runInfo = document.getElementById("run-info");
const refreshBtn = document.getElementById("refresh-btn");
refreshBtn.addEventListener("click", () => startRefresh());

function renderHeader() {
  const s = store.server;
  const busy = store.refreshPending || (s && s.collector.busy.length > 0);
  refreshBtn.disabled = !!busy;
  refreshBtn.classList.toggle("is-busy", !!busy);
  setChildren(refreshBtn.querySelector(".btn-icon"), busy ? spinner() : refreshIcon());
  refreshBtn.querySelector(".btn-label").textContent = busy ? "更新中…" : "今すぐ更新";
  if (!s) { runInfo.replaceChildren(); return; }
  const now = ctx.now();
  const parts = [
    h("span.ri-item", { title: "最後に取得した時刻" }, [h("span.ri-k", "最終更新"), " ",
      h("b.num", { dataset: { ago: s.collector.last_run_at || "" } }, fmtAgo(s.collector.last_run_at, now))]),
  ];
  if (s.collector.busy.length) {
    parts.push(h("span.ri-item.is-busy", `取得中 ${s.collector.busy.length}件`));
  } else if (s.collector.next_run_at) {
    parts.push(h("span.ri-item.hide-sm", [h("span.ri-k", "次回"), " ",
      h("b.num", { dataset: { in: s.collector.next_run_at } }, fmtIn(s.collector.next_run_at, now))]));
  }
  setChildren(runInfo, ...parts);
}
function flashRunInfo() {
  runInfo.classList.remove("flash");
  void runInfo.offsetWidth;
  runInfo.classList.add("flash");
}
function refreshIcon() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("width", "14");
  s.setAttribute("height", "14");
  s.innerHTML = '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12.6 1.6v3.1H9.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
}

// ---- お知らせの帯（接続できない・設定ファイルが壊れている） ----------------------------
const bannerEl = document.getElementById("banner");
function renderBanner() {
  const items = [];
  if (store.connError) {
    items.push(h("div.banner.tone-danger", [spinner(), " サーバーに接続できません。再接続しています…"]));
  }
  const ce = store.server && store.server.config_error;
  // 設定画面は同じ内容を画面の中の帯で出す（2つ並ばないように、こちらは出さない）
  if (ce && currentName !== "settings") {
    items.push(h("div.banner.tone-warn", [
      h("b", "設定ファイルに誤りがあります。"), " 最後に有効だった設定で動いています。 ",
      h("span.banner-detail", ce), " ", h("a", { href: "#/settings" }, "設定を開く"),
    ]));
  }
  setChildren(bannerEl, ...items);
}

// ---- 毎秒の時刻表示 --------------------------------------------------------------
// data-ago / data-in / data-until を持つ要素の文字だけを書き換える（再描画はしない）。
function tick() {
  const now = ctx.now();
  for (const el of document.querySelectorAll("[data-ago]")) {
    const t = +el.dataset.ago; if (t) el.textContent = fmtAgo(t, now);
  }
  for (const el of document.querySelectorAll("[data-in]")) {
    const t = +el.dataset.in; if (t) el.textContent = fmtIn(t, now);
  }
  for (const el of document.querySelectorAll("[data-until]")) {
    const t = +el.dataset.until;
    const s = fmtCountdown(t, now);
    el.textContent = s || "リセット済み（推定）";
    el.classList.toggle("is-past", !s);
  }
  // 待ち時間が長いときにボタンの表示が止まって見えないよう、ヘッダーも毎秒見直す
  if (store.refreshPending && Date.now() - store.refreshStartedAt > 30000) {
    store.refreshPending = false;
    renderHeader();
  }
}
setInterval(tick, 1000);

// ---- テーマ ----------------------------------------------------------------------
// OS の設定に従うのが既定。ボタンで反対側に切り替え、もう一度押すと戻る。
// 切り替えた結果が OS の設定と同じになったら、保存を消して「OS に従う」に戻す。
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const themeBtn = document.getElementById("theme-btn");
function effectiveTheme() {
  return document.documentElement.dataset.theme || (mq.matches ? "dark" : "light");
}
function renderThemeBtn() {
  const dark = effectiveTheme() === "dark";
  themeBtn.innerHTML = dark
    ? '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="3.6" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></g></svg>'
    : '<svg viewBox="0 0 20 20" width="18" height="18"><path d="M16.5 12.6A7 7 0 0 1 7.4 3.5a7 7 0 1 0 9.1 9.1z" fill="currentColor"/></svg>';
  themeBtn.title = dark ? "ライトにする" : "ダークにする";
  themeBtn.setAttribute("aria-label", themeBtn.title);
}
themeBtn.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  const system = mq.matches ? "dark" : "light";
  if (next === system) { delete document.documentElement.dataset.theme; savePref("theme", undefined); }
  // テーマだけは index.html が描画前に生の文字列で読むので、JSON にせずそのまま保存する
  else { document.documentElement.dataset.theme = next; try { localStorage.setItem("ccsmoni.theme", next); } catch {} }
  themeChanged();
});
mq.addEventListener("change", () => { if (!document.documentElement.dataset.theme) themeChanged(); });
function themeChanged() {
  renderThemeBtn();
  window.dispatchEvent(new CustomEvent("ccsmoni:theme"));
}

// ---- 起動 --------------------------------------------------------------------------
renderThemeBtn();
renderHeader();
route();
pollNow();
