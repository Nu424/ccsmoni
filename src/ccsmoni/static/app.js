// アプリ全体の骨組み。
// 何を: ハッシュルーティング（#/ と #/settings）、/api/state の定期取得、ヘッダー（状態のバッジ・最終更新・次回・今すぐ更新・テーマ）、
//       毎秒の時刻表示の更新。
// なぜ: 画面ごとの処理（dashboard.js / settings.js）から「いつ取りに行くか」「時計」を切り離し、
//       どの画面でも同じリズムで状態が新しくなるようにするため。
// 方針: store に最新のサーバー状態を入れ、変わったら今の画面の onState() を呼ぶ。画面は mount / unmount / onState を持つ。

import { api } from "./api.js";
import { h, setChildren, fmtAgo, fmtIn, fmtCountdown, spinner, toast, savePref, loginRetaken, icon } from "./ui.js";
import { createDashboard } from "./dashboard.js";
import { createSettings } from "./settings.js";
import { setPalette } from "./colors.js";

const store = {
  server: null,
  clockOffset: 0,        // サーバー時刻 − ブラウザ時刻（秒）。カウントダウンをサーバー基準にする
  connError: false,
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
  document.body.dataset.route = name;
  current.mount(viewEl);
  if (store.server) current.onState(store.server);
  document.querySelectorAll(".nav a").forEach((a) => a.setAttribute("aria-current", a.dataset.route === name ? "page" : "false"));
  viewEl.scrollTo && viewEl.scrollTo(0, 0);
  renderBanner();
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
    setPalette(s.palette);
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
// 押す → POST /api/refresh → busy が出て、空に戻ったら完了。busy が一度も見えないまま 8 秒たったら完了とみなす。
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
const runInfo = document.getElementById("fresh");
const refreshBtn = document.getElementById("refresh-btn");
const badgesEl = document.getElementById("badges");
refreshBtn.addEventListener("click", () => startRefresh());

// 状態のバッジ（有効なアカウントだけを数える）。ホバーで該当するタイルを強調、押すとそのページへ
function badgeGroups(s) {
  const acc = s.accounts.filter((a) => a.enabled);
  const warnP = s.ui.warn_percent;
  const ids = (f) => acc.filter(f).map((a) => a.id);
  const lo = ids((a) => a.status === "logged_out");
  const er = ids((a) => a.status !== "ok" && a.status !== "never" && a.status !== "logged_out");
  const wa = ids((a) => a.status === "ok" && ((a.limits || []).some((l) => l.percent >= warnP) || (a.hints || []).some((x) => x.kind === "will_hit_limit")));
  const tp = ids((a) => a.status === "ok" && (a.hints || []).some((x) => x.kind === "use_it_or_lose_it"));
  const bad = new Set([...lo, ...er, ...wa]);
  const ok = acc.filter((a) => !bad.has(a.id) && a.status === "ok").map((a) => a.id);
  return [
    { k: "ok", icon: "ok", label: "問題なし", ids: ok, text: `${ok.length}/${acc.length}`, always: true },
    { k: "crit", icon: "crit", label: "ログイン切れ", ids: lo },
    { k: "crit", icon: "err", label: "取得エラー", ids: er },
    { k: "warn", icon: "warn", label: "上限見込み", ids: wa },
    { k: "tip", icon: "tip", label: "使い残し", ids: tp },
  ];
}
function renderBadges(s) {
  if (!s) { badgesEl.replaceChildren(); return; }
  const label = (id) => (s.accounts.find((a) => a.id === id) || {}).label || id;
  const items = badgeGroups(s).filter((g) => g.always || g.ids.length).map((g) => h("button.chip", {
    type: "button", class: g.k, dataset: { ids: g.ids.join(",") },
    title: g.ids.length ? `${g.ids.map(label).join("・")}（押すとそのアカウントへ）` : g.label,
    "aria-label": `${g.label} ${g.ids.length}件: ${g.ids.map(label).join("、")}`,
    onpointerenter: () => views.dash.highlight(g.ids),
    onpointerleave: () => views.dash.highlight(null),
    onfocus: () => views.dash.highlight(g.ids),
    onblur: () => views.dash.highlight(null),
    onclick: () => {
      if (!g.ids.length) return;
      if (currentName !== "dash") location.hash = "#/";
      requestAnimationFrame(() => views.dash.gotoAccount(g.ids[0]));
    },
  }, [icon(g.icon), g.label, " ", h("b", g.text || String(g.ids.length))]));
  const off = s.accounts.filter((a) => !a.enabled).length;
  if (off) items.push(h("a.chip.off", { href: "#/settings", title: "無効にしたアカウントは推移に出しません。設定で有効にできます" }, [icon("off"), "無効 ", h("b", String(off))]));
  setChildren(badgesEl, items);
}

function renderHeader() {
  const s = store.server;
  const busy = store.refreshPending || (s && s.collector.busy.length > 0);
  refreshBtn.disabled = !!busy;
  refreshBtn.classList.toggle("is-busy", !!busy);
  setChildren(refreshBtn, busy ? spinner() : icon("refresh"), h("span.lbl", busy ? "更新中…" : "今すぐ更新"));
  renderBadges(s);
  if (!s) { runInfo.replaceChildren(); return; }
  const now = ctx.now();
  const parts = [h("span", { title: "最後に取得した時刻" }, ["最終更新 ", h("b.num", { dataset: { ago: s.collector.last_run_at || "" } }, fmtAgo(s.collector.last_run_at, now))])];
  if (s.collector.busy.length) parts.push(h("span.busy", [spinner(), `取得中 ${s.collector.busy.length}件`]));
  else if (s.collector.next_run_at) parts.push(h("span", ["次回 ", h("b.num", { dataset: { in: s.collector.next_run_at } }, fmtIn(s.collector.next_run_at, now))]));
  setChildren(runInfo, ...parts);
}
function flashRunInfo() {
  runInfo.classList.remove("flash");
  void runInfo.offsetWidth;
  runInfo.classList.add("flash");
}

// ---- お知らせの帯（接続できない・設定ファイルが壊れている） ----------------------------
const bannerEl = document.getElementById("banner");
function renderBanner() {
  const items = [];
  if (store.connError) items.push(h("div.banner.tone-danger", [spinner(), " サーバーに接続できません。再接続しています…"]));
  const ce = store.server && store.server.config_error;
  if (ce && currentName !== "settings") {
    items.push(h("div.banner.tone-warn", [h("b", "設定ファイルに誤りがあります。"), " 最後に有効だった設定で動いています。 ",
      h("span.banner-detail", ce), " ", h("a", { href: "#/settings" }, "設定を開く")]));
  }
  setChildren(bannerEl, ...items);
}

// ---- 毎秒の時刻表示 --------------------------------------------------------------
function tick() {
  const now = ctx.now();
  for (const el of document.querySelectorAll("[data-ago]")) { const t = +el.dataset.ago; if (t) el.textContent = fmtAgo(t, now); }
  for (const el of document.querySelectorAll("[data-in]")) { const t = +el.dataset.in; if (t) el.textContent = fmtIn(t, now); }
  for (const el of document.querySelectorAll("[data-until]")) {
    const s = fmtCountdown(+el.dataset.until, now);
    el.textContent = s || "リセット済み（推定）";
    el.classList.toggle("is-past", !s);
  }
  if (store.refreshPending && Date.now() - store.refreshStartedAt > 30000) { store.refreshPending = false; renderHeader(); }
}
setInterval(tick, 1000);
// 追従中の表示範囲を今に合わせる（state の取得の合間にも、右端が止まって見えないように）
setInterval(() => { if (currentName === "dash") views.dash.vp.tick(); }, 30000);

// ---- テーマ ----------------------------------------------------------------------
// OS の設定に従うのが既定。ボタンで反対側に切り替え、OS と同じになったら保存を消して「OS に従う」に戻す。
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const themeBtn = document.getElementById("theme-btn");
const effectiveTheme = () => document.documentElement.dataset.theme || (mq.matches ? "dark" : "light");
function renderThemeBtn() {
  const dark = effectiveTheme() === "dark";
  setChildren(themeBtn, icon(dark ? "sun" : "moon"));
  themeBtn.title = dark ? "ライトにする" : "ダークにする";
  themeBtn.setAttribute("aria-label", themeBtn.title);
}
themeBtn.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  const system = mq.matches ? "dark" : "light";
  if (next === system) { delete document.documentElement.dataset.theme; savePref("theme", undefined); }
  else { document.documentElement.dataset.theme = next; try { localStorage.setItem("ccsmoni.theme", next); } catch {} }
  themeChanged();
});
mq.addEventListener("change", () => { if (!document.documentElement.dataset.theme) themeChanged(); });
function themeChanged() {
  renderThemeBtn();
  renderHeader();
  window.dispatchEvent(new CustomEvent("ccsmoni:theme"));
}

// ---- 起動 --------------------------------------------------------------------------
renderThemeBtn();
renderHeader();
route();
pollNow();
// 開発・確認用（スクリーンショットの操作に使う）
window.__ccs = { ctx, views };
