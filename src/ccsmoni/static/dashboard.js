// 推移画面（UI v2: タイル基本＋時間軸ナビゲーション。docs/UI-V2.md）。
// 何を: ツールバー（プリセット・範囲・並べる／重ねる・ページ）、タイルのグリッド（隙間なし・ページ分割）、
//       重ねる表示（凡例を兼ねる今の値の帯＋重ね合わせ＋5h レーン）、時間軸のストリップ、凡例の1行、ツールチップ。
// なぜ: 全グラフが1つの TimeViewport を見て、どこで操作しても全部に効くようにするため。
// 方針:
//   - viewport の通知（rAF で1フレームに1回）の中で、見えているグラフを全部描く。カーソルや選択範囲は ovl だけ描き直す。
//   - タイルの外枠は作り直さない（state の更新では中身だけ入れ替える）。ページを変えたらグリッドに入れるタイルを差し替える。
//   - ページ分割は件数と上限（ui.tiles_per_page）だけで決める（窓の大きさでページ数を変えない）。前から詰める。

import { h, setChildren, icon, spinner, loadPref, savePref, fmtDateTime, fmtPct, fmtSpan } from "./ui.js";
import { createViewport, PRESETS } from "./viewport.js";
import { createHistory, nearest } from "./history.js";
import { Plot, drawTile, drawOverlay, drawLanes, drawStrip, drawSelection, cursorLine, dot, roundRect, tokens, invalidateTokens, lanesHeight, laneTop, LANE, valueAt } from "./chart.js";
import { attachInteractions } from "./interact.js";
import { createTile } from "./tiles.js";
import { colorOf, setPalette } from "./colors.js";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const pad2 = (n) => String(n).padStart(2, "0");
const fmtRangeEnd = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const PRESET_LABEL = { "24h": "24時間", "7d": "7日", "30d": "30日" };
const MIN_TILE_W = 300, MIN_TILE_H = 230, GAP = 12;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// そのページの件数 → 列の数（UI-V2.md「タイルの並べ方」）
export function colsFor(n) {
  if (n <= 3) return Math.max(1, n);
  if (n === 4) return 2;
  if (n <= 6) return 3;
  if (n <= 8) return 4;
  if (n === 9) return 3;
  return 4;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a * b) / gcd(a, b);
// 隙間を作らない並べ方: 列を細かく割り、最後の段のタイルを横に広げる
export function gridPlan(n, cols) {
  const rows = Math.ceil(n / cols);
  const last = n - cols * (rows - 1);
  const L = lcm(cols, last);
  const spans = [];
  for (let i = 0; i < n; i++) spans.push(i >= cols * (rows - 1) ? L / last : L / cols);
  return { cols, rows, L, spans };
}

export function createDashboard(ctx) {
  const vp = createViewport({ now: ctx.now, preset: loadPref("v2.preset", "7d") });
  const S = {
    view: loadPref("v2.view", "tiles") === "overlay" ? "overlay" : "tiles",
    ovKind: loadPref("v2.ovKind", "weekly_all") === "session" ? "session" : "weekly_all",
    hidden: new Set(), archivedSeen: new Set(),
    focus: null,          // 重ねる表示で強調するアカウント
    filter: null,         // ヘッダーのバッジにホバー中: 対象の id の Set
    page: 0,
    hoverT: null, hoverSrc: null, hoverReset: null, hoverLane: null,
    sel: null, selSrc: null,
    loginBusy: new Set(),
  };
  let server = null;
  let root = null, E = {};
  const tiles = new Map();          // id → tile
  let ovPlot = null, lanePlot = null, stripPlot = null;
  let unsub = null, ro = null;
  let lastKey = "";

  const accounts = () => (server ? server.accounts.filter((a) => a.enabled) : []);
  const archived = () => (server ? server.archived || [] : []);
  const intervalOf = (id) => { const a = server && server.accounts.find((x) => x.id === id); return (a && a.interval_minutes) || 10; };
  const hist = createHistory({ intervalOf, onChange: () => { vp.redraw(); renderLoading(); } });
  const findAcc = (id) => (server ? server.accounts.find((a) => a.id === id) || archived().find((a) => a.id === id) : null);
  const perPage = () => { const p = server && server.ui && server.ui.tiles_per_page; return [4, 6, 8, 9, 12].includes(p) ? p : 6; };
  function pages() {
    const ids = accounts().map((a) => a.id), P = perPage(), out = [];
    for (let i = 0; i < ids.length; i += P) out.push(ids.slice(i, i + P));
    return out.length ? out : [[]];
  }
  const sev = (p) => { const ui = server ? server.ui : { warn_percent: 70, danger_percent: 90 }; return p >= ui.danger_percent ? "crit" : p >= ui.warn_percent ? "warn" : ""; };

  const env = {
    now: ctx.now, sev, colorOf,
    busy: () => new Set(server ? server.collector.busy : []),
    refreshOne: (id) => ctx.refreshOne(id),
    refreshState: () => ctx.refreshState(),
    loginBusy: S.loginBusy,
    zoomTo: (s, e, id) => { vp.setRange(s, Math.min(e, ctx.now())); flashTile(id); },
  };

  // =====================================================================
  // 骨組み
  // =====================================================================
  function mount(el) {
    root = h("div.dash", { class: S.view === "overlay" ? "is-overlay" : "" });
    E.presets = h("div.seg.presets", { role: "group", "aria-label": "期間のプリセット" },
      Object.keys(PRESETS).map((p) => h("button", { type: "button", dataset: { v: p }, onclick: () => { vp.setPreset(p); savePref("v2.preset", p); } }, PRESET_LABEL[p])));
    E.rangeText = h("span.rl-text.num");
    E.rangeSpan = h("span.rl-span");
    E.reset = h("button.reset-btn", { type: "button", title: "直前のプリセットに戻る（Esc・グラフをダブルクリックでも）", onclick: () => vp.reset() }, [icon("x"), h("span.lbl", "プリセットに戻る")]);
    E.loading = h("span.loading", { "aria-live": "polite" });
    E.range = h("div.range", [E.rangeText, E.rangeSpan, E.reset, E.loading]);
    E.view = h("div.seg.viewseg", { role: "group", "aria-label": "表示" }, [
      h("button", { type: "button", dataset: { v: "tiles" }, title: "アカウントごとに並べる", onclick: () => setView("tiles") }, "並べる"),
      h("button", { type: "button", dataset: { v: "overlay" }, title: "1つのグラフに重ねて比べる", onclick: () => setView("overlay") }, "重ねる"),
    ]);
    E.pager = h("nav.pager", { "aria-label": "ページ" });
    E.toolbar = h("div.toolbar", [E.presets, E.range, h("span.grow"), E.view, E.pager]);

    E.grid = h("div.grid");
    E.empty = h("div.empty");
    E.tilesView = h("div.tiles-view", [E.grid, E.empty]);
    // 重ねる表示
    E.legend = h("div.ov-legend", { role: "group", "aria-label": "アカウント（押すと表示／非表示、ダブルクリックでそれだけ表示）" });
    E.ovKind = h("div.seg", { role: "group", "aria-label": "重ねる値" }, [
      h("button", { type: "button", dataset: { v: "weekly_all" }, onclick: () => setOvKind("weekly_all") }, "週間"),
      h("button", { type: "button", dataset: { v: "session" }, onclick: () => setOvKind("session") }, "5h"),
    ]);
    E.ovChart = h("div.ov-chart.plot");
    E.lanes = h("div.ov-lanes.plot");
    E.ovView = h("div.ov-view", [
      E.legend,
      h("section.card.ov-main", [h("div.card-head", [h("h3", "比較"), E.ovKind,
        h("span.note", "帯を押すと表示／非表示・ダブルクリックでそれだけ表示")]), E.ovChart]),
      h("section.card.ov-lanes-card", [E.lanes]),
    ]);
    E.body = h("div.dash-body", [E.tilesView, E.ovView]);
    E.strip = h("div.strip.plot", { tabindex: "0", role: "slider", "aria-label": "時間軸（ホイールで拡大縮小・ドラッグで移動・ダブルクリックでプリセットに戻る）",
      "aria-valuetext": "", title: "ホイール: 拡大縮小　ドラッグ: 移動　ダブルクリック: プリセットに戻る" });
    E.foot = h("footer.legend-row", legendKeys());
    root.append(E.toolbar, E.body, h("div.strip-wrap", [E.strip]), E.foot);
    el.append(root);

    ovPlot = new Plot(E.ovChart, "overlay");
    lanePlot = new Plot(E.lanes, "lanes");
    lanePlot.alignTo = ovPlot;
    stripPlot = new Plot(E.strip, "strip");
    tiles.clear();
    attachInteractions(root, {
      vp, plotFor, strip: { el: E.strip, plot: stripPlot },
      onHover, onLeave: clearHover, onSelection, onSwipe: (d) => goPage(S.page + d),
    });
    unsub = vp.subscribe(draw);
    ro = new ResizeObserver(() => { layout(); vp.redraw(); });
    ro.observe(E.body);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("click", onDocClick);
    window.addEventListener("ccsmoni:theme", onTheme);
    syncControls();
    if (server) onState(server);
  }
  function unmount() {
    unsub && unsub(); unsub = null;
    ro && ro.disconnect(); ro = null;
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointermove", onDocMove);
    document.removeEventListener("click", onDocClick);
    window.removeEventListener("ccsmoni:theme", onTheme);
    hideTip();
    root = null; E = {}; tiles.clear(); lastKey = "";
  }
  function onTheme() { invalidateTokens(); for (const [id, t] of tiles) { const a = findAcc(id); if (a) t.el.style.setProperty("--c", colorOf(a)); } renderLegend(); renderPager(); vp.redraw(); }

  function legendKeys() {
    const k = (svg, text) => h("span.key", [svgEl(svg), text]);
    return [
      k('<path d="M1 9 L8 6 L14 6 L21 2" stroke="var(--ink-2)" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="8" cy="6" r="2" fill="var(--ink-2)" stroke="var(--surface)" stroke-width="1.2"/>', "週間（点＝取得）"),
      k('<path d="M1 11 L6 5 L12 8 L21 3 L21 11 Z" fill="var(--ink-2)" fill-opacity=".18"/><path d="M1 11 L6 5 L12 8 L21 3" stroke="var(--ink-2)" stroke-opacity=".5" fill="none"/>', "5時間枠"),
      k('<path d="M11 0 V12" stroke="var(--ink-3)" stroke-width="1"/>', "週間リセット"),
      k('<path d="M7 8 V12 M15 8 V12" stroke="var(--ink-3)" stroke-width="1"/>', "5h リセット"),
      k('<defs><pattern id="hk" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0 V4" stroke="var(--ink-3)" stroke-opacity=".5"/></pattern></defs><rect x="1" y="0" width="20" height="12" fill="url(#hk)"/>', "取得できなかった区間"),
      k('<rect x="1" y="9" width="20" height="3" rx="1" fill="var(--st-crit)"/>', "取得エラー・ログイン切れ"),
      k('<rect x="1" y="4" width="20" height="5" rx="2.5" fill="var(--track)"/><rect x="1" y="4" width="11" height="5" rx="2.5" fill="var(--meter)"/><rect x="14" y="1" width="2" height="11" rx="1" fill="var(--ink)"/>', "目盛り＝均等に使った場合"),
      h("span.key.ops", "ドラッグで範囲を拡大 · 時間軸でホイール／ドラッグ · Esc で戻る"),
      E.cand = h("span.foot-cand"),
    ];
  }
  function svgEl(inner) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 22 12"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = inner;
    return s;
  }

  // =====================================================================
  // state の更新
  // =====================================================================
  function onState(s, prev) {
    const first = !server;
    server = s;
    setPalette(s.palette);
    for (const a of archived()) if (!S.archivedSeen.has(a.id)) { S.archivedSeen.add(a.id); S.hidden.add(a.id); }
    if (!root) return;
    vp.tick();
    if (prev && prev.collector.last_run_at !== s.collector.last_run_at) hist.refreshTail(ctx.now());
    const np = pages().length;
    if (S.page >= np) S.page = np - 1;
    for (const a of accounts()) {
      let t = tiles.get(a.id);
      if (!t) { t = createTile(a.id, env); tiles.set(a.id, t); }
      t.update(a);
    }
    for (const id of [...tiles.keys()]) if (!accounts().some((a) => a.id === id)) { tiles.get(id).el.remove(); tiles.delete(id); }
    renderEmpty();
    renderLegend();
    renderPager();
    layout();
    applyFilter();
    const c = s.candidates || [];
    if (E.cand) setChildren(E.cand, c.length ? [icon("tip"), "新しいアカウント候補 ", h("code", c[0].suggested_id), c.length > 1 ? ` ほか${c.length - 1}` : "", " · ", h("a", { href: "#/settings" }, "設定で追加")] : null);
    if (first) ensureData();
    vp.redraw();
  }

  function renderEmpty() {
    const n = accounts().length;
    E.empty.hidden = n > 0;
    if (n) return;
    const off = server ? server.accounts.length : 0;
    setChildren(E.empty, h("div.empty-card", [h("h3", off ? "有効なアカウントがありません" : "アカウントがまだありません"),
      h("p", off ? "設定でアカウントを有効にすると、ここに推移が出ます。" : "設定でアカウントを追加すると、ここに推移が出ます。"),
      h("a.btn", { href: "#/settings" }, "設定を開く")]));
  }

  // =====================================================================
  // タイルの並べ方
  // =====================================================================
  function layout() {
    if (!root || S.view !== "tiles") return;
    const ids = pages()[S.page] || [];
    const want = ids.map((id) => tiles.get(id)).filter(Boolean);
    const key = ids.join(",");
    if (key !== lastKey) { E.grid.replaceChildren(...want.map((t) => t.el)); lastKey = key; }
    const n = want.length;
    if (!n) return;
    const W = E.body.clientWidth, H = E.body.clientHeight;
    let plan = gridPlan(n, colsFor(n));
    const fits = (W - GAP * (plan.cols - 1)) / plan.cols >= MIN_TILE_W && (H - GAP * (plan.rows - 1)) / plan.rows >= MIN_TILE_H;
    root.classList.toggle("is-scroll", !fits);
    if (!fits) {
      // 小さくなりすぎるなら、1画面に収めるのをやめて縦にスクロール（列は幅で決め直す）
      const cols = Math.max(1, Math.min(plan.cols, Math.floor((W + GAP) / (MIN_TILE_W + GAP))));
      plan = gridPlan(n, cols);
    }
    E.grid.style.gridTemplateColumns = `repeat(${plan.L}, minmax(0, 1fr))`;
    E.grid.style.gridTemplateRows = fits ? `repeat(${plan.rows}, minmax(0, 1fr))` : "";
    want.forEach((t, i) => { t.el.style.gridColumn = `span ${plan.spans[i]}`; });
    for (const t of want) t.plot.measure();
  }

  function goPage(p, { focusId = null } = {}) {
    const np = pages().length;
    p = Math.max(0, Math.min(np - 1, p));
    if (p === S.page || S.view !== "tiles") return;
    const dir = p > S.page ? 1 : -1;
    S.page = p;
    clearHover();
    layout();
    renderPager();
    applyFilter();
    vp.redraw();
    if (!reducedMotion()) E.grid.animate([{ transform: `translateX(${dir * 28}px)`, opacity: 0.35 }, { transform: "none", opacity: 1 }], { duration: 150, easing: "ease-out" });
    if (focusId) flashTile(focusId);
  }
  function flashTile(id) {
    const t = id && tiles.get(id);
    if (!t || reducedMotion()) return;
    t.el.classList.remove("flash"); void t.el.offsetWidth; t.el.classList.add("flash");
  }

  function renderPager() {
    if (!E.pager) return;
    const ps = pages();
    E.pager.hidden = ps.length < 2 || S.view !== "tiles";
    if (E.pager.hidden) return;
    setChildren(E.pager,
      h("button.pg-arrow", { type: "button", "aria-label": "前のページ", title: "前のページ（←）", disabled: S.page === 0, onclick: () => goPage(S.page - 1) }, icon("left")),
      ps.map((ids, i) => h("button.pg", {
        type: "button", "aria-current": i === S.page ? "page" : null, dataset: { page: i },
        "aria-label": `ページ ${i + 1}: ${ids.map((id) => (findAcc(id) || {}).label).join("、")}`,
        title: ids.map((id) => (findAcc(id) || {}).label).join("・"),
        onclick: () => goPage(i),
      }, ids.map((id) => h("i", { style: { background: colorOf(findAcc(id) || {}) } })))),
      h("span.pg-num.num", `${S.page + 1}/${ps.length}`),
      h("button.pg-arrow", { type: "button", "aria-label": "次のページ", title: "次のページ（→）", disabled: S.page === ps.length - 1, onclick: () => goPage(S.page + 1) }, icon("right")),
    );
  }

  // ヘッダーのバッジにホバー: 該当するタイルを強調し、ほかを薄く。別のページにいるなら、そのページの点を光らせる
  function highlight(ids) {
    S.filter = ids && ids.length ? new Set(ids) : null;
    applyFilter();
  }
  function applyFilter() {
    if (!root) return;
    for (const [id, t] of tiles) {
      t.el.classList.toggle("dim", !!S.filter && !S.filter.has(id));
      t.el.classList.toggle("hot", !!S.filter && S.filter.has(id));
    }
    E.pager.querySelectorAll(".pg").forEach((b) => {
      const ids = pages()[+b.dataset.page] || [];
      b.classList.toggle("glow", !!S.filter && +b.dataset.page !== S.page && ids.some((id) => S.filter.has(id)));
    });
    E.legend.querySelectorAll(".lg-chip").forEach((c) => c.classList.toggle("dim", !!S.filter && !S.filter.has(c.dataset.id)));
    if (S.view === "overlay") {
      const f = S.filter && S.filter.size === 1 ? [...S.filter][0] : null;
      if (f !== S.focusFromFilter) { S.focusFromFilter = f; vp.redraw(); }
    }
  }
  // バッジを押す: 該当するアカウントのいる最初のページへ
  function gotoAccount(id) {
    if (S.view !== "tiles") { flashLegend(id); return; }
    const p = pages().findIndex((ids) => ids.includes(id));
    if (p >= 0) { if (p !== S.page) goPage(p, { focusId: id }); else flashTile(id); }
  }
  function flashLegend(id) {
    const c = E.legend && E.legend.querySelector(`.lg-chip[data-id="${CSS.escape(id)}"]`);
    if (c && !reducedMotion()) { c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash"); }
  }

  // =====================================================================
  // 重ねる表示
  // =====================================================================
  function overlayList() {
    const out = [];
    for (const a of [...accounts(), ...archived()]) if (!S.hidden.has(a.id)) out.push(a);
    return out;
  }
  function renderLegend() {
    if (!E.legend || !server) return;
    const chip = (a, isArch) => {
      const L5 = a.status === "ok" ? (a.limits || []).find((l) => l.kind === "session") : null;
      const LW = a.status === "ok" ? (a.limits || []).find((l) => l.kind === "weekly_all") : null;
      const off = S.hidden.has(a.id);
      return h("button.lg-chip", {
        type: "button", dataset: { id: a.id }, class: `${off ? "off" : ""} ${isArch ? "arch" : ""}`, "aria-pressed": String(!off),
        style: { "--c": colorOf(a) },
        title: `${a.label}（押すと${off ? "表示" : "非表示"}・ダブルクリックでそれだけ表示）`,
        onclick: () => { S.hidden.has(a.id) ? S.hidden.delete(a.id) : S.hidden.add(a.id); renderLegend(); sizeLanes(); vp.redraw(); },
        ondblclick: () => solo(a.id),
        onpointerenter: () => { S.focus = a.id; vp.redraw(); },
        onpointerleave: () => { S.focus = null; vp.redraw(); },
      }, [h("span.lk"), h("span.nm", a.label),
        isArch ? h("span.vals.muted", "アーカイブ") :
        a.status === "ok" ? h("span.vals.num", [h("b", LW ? fmtPct(LW.percent) : "—"), h("span.sep", "·"), "5h ", L5 ? fmtPct(L5.percent) : "—"]) :
        h("span.vals.crit", [icon(a.status === "logged_out" ? "crit" : "err"), a.status === "logged_out" ? "ログイン切れ" : "エラー"])]);
    };
    const arch = archived();
    setChildren(E.legend, accounts().map((a) => chip(a, false)),
      arch.length ? [h("span.lg-sep", "アーカイブ"), arch.map((a) => chip(a, true))] : null);
    applyFilter();
  }
  function solo(id) {
    const all = [...accounts(), ...archived()].map((a) => a.id);
    const alreadySolo = all.every((x) => (x === id ? !S.hidden.has(x) : S.hidden.has(x)));
    S.hidden = new Set(alreadySolo ? archived().map((a) => a.id) : all.filter((x) => x !== id));
    renderLegend(); sizeLanes(); vp.redraw();
  }
  function sizeLanes() {
    if (!E.lanes) return;
    const n = overlayList().length;
    E.lanes.style.height = lanesHeight(Math.max(1, n)) + "px";
    lanePlot.measure();
  }
  function setView(v) {
    if (v === S.view) return;
    S.view = v; savePref("v2.view", v);
    S.focus = null; clearHover();
    syncControls();
    if (v === "tiles") { lastKey = ""; layout(); }
    else { sizeLanes(); ovPlot.measure(); }
    renderPager();
    vp.redraw();
  }
  function setOvKind(k) { S.ovKind = k; savePref("v2.ovKind", k); syncControls(); vp.redraw(); }
  function syncControls() {
    root.classList.toggle("is-overlay", S.view === "overlay");
    for (const b of E.view.children) b.setAttribute("aria-pressed", String(b.dataset.v === S.view));
    for (const b of E.ovKind.children) b.setAttribute("aria-pressed", String(b.dataset.v === S.ovKind));
    E.tilesView.hidden = S.view !== "tiles";
    E.ovView.hidden = S.view !== "overlay";
  }

  // =====================================================================
  // 描画（viewport の通知の中で）
  // =====================================================================
  let ensureTimer = 0;
  function ensureData() {
    clearTimeout(ensureTimer);
    ensureTimer = setTimeout(() => { hist.ensure(vp.target.start, vp.target.end, ctx.now()); renderLoading(); }, vp.animating ? 160 : 60);
  }
  let lastRange = "";
  function draw() {
    if (!root || !server) return;
    const t0 = performance.now();
    const now = ctx.now();
    const rk = `${Math.round(vp.target.start)}|${Math.round(vp.target.end)}`;
    if (rk !== lastRange) { lastRange = rk; ensureData(); }
    const all = [...accounts(), ...archived().map((a) => ({ ...a, status: "ok" }))];
    const M = hist.model(all, now);
    const loading = !hist.hasData || hist.loading;
    if (hist.earliest != null) vp.setFloor(hist.earliest);
    const busyRange = !hist.isCovered(vp.start, Math.min(vp.end, now));
    root.classList.toggle("is-fetching", busyRange && hist.loading);
    if (S.view === "tiles") {
      for (const id of pages()[S.page] || []) {
        const t = tiles.get(id), a = findAcc(id);
        if (!t || !a) continue;
        drawTile(t.plot, vp, hist.hasData ? M[id] : null, { color: colorOf(a), faded: a.status !== "ok" && a.status !== "never", loading });
      }
    } else {
      const list = overlayList().map((a) => ({ id: a.id, label: a.label, color: colorOf(a), D: M[a.id],
        now5h: a.status === "ok" ? ((a.limits || []).find((l) => l.kind === "session") || {}).percent : null,
        nowText: a.status === "logged_out" ? "ログイン切れ" : a.status && a.status !== "ok" && a.status !== "never" && a.limits ? "エラー" : null }));
      const focus = S.focus || S.hoverLane || S.focusFromFilter || null;
      drawOverlay(ovPlot, vp, list, S.ovKind, focus);
      drawLanes(lanePlot, vp, list, focus);
    }
    stripPlot.padOverride = S.view === "overlay" && !ovPlot.narrow ? { l: ovPlot.pad.l + 1, r: ovPlot.pad.r + 1 } : null;
    drawStrip(stripPlot, vp, { now, holes: hist.uncoveredIn(vp.start, Math.min(vp.end, now)), loading: hist.loading });
    drawCursors(M);
    renderRange(now);
    S.drawMs = performance.now() - t0; // 確認用（1回の描画にかかった時間）
    if (hist.loading) vp.redraw(); // 読み込み中の帯を動かす
  }

  // ツールバーの範囲表示（shown から毎フレーム作るので、範囲を変えると数字がなめらかに流れる）
  function renderRange(now) {
    const s = vp.start, e = vp.end;
    const endTxt = vp.follow && e >= now - 60 ? "今" : fmtRangeEnd(e);
    E.rangeText.textContent = `${fmtRangeEnd(s)} – ${endTxt}`;
    E.rangeSpan.textContent = fmtSpan(e - s);
    E.strip.setAttribute("aria-valuetext", `${fmtRangeEnd(s)} から ${endTxt}`);
    const p = vp.preset;
    for (const b of E.presets.children) b.setAttribute("aria-pressed", String(b.dataset.v === p));
    const off = !p;
    E.range.classList.toggle("off-preset", off);
    E.reset.hidden = !off;
    E.reset.querySelector(".lbl").textContent = `${PRESET_LABEL[vp.lastPreset]}に戻る`;
  }
  function renderLoading() {
    if (!E.loading) return;
    const busy = hist.loading;
    const failed = hist.failed && !busy;
    setChildren(E.loading, busy ? [spinner(), h("span", hist.hasData ? "範囲を読み込み中…" : "読み込み中…")]
      : failed ? h("span.fail", { title: hist.failed.message }, ["履歴を読み込めませんでした ", h("button.link", { type: "button", onclick: () => { lastRange = ""; vp.redraw(); } }, "再試行")]) : null);
  }

  // =====================================================================
  // カーソル・選択範囲・ツールチップ
  // =====================================================================
  function visiblePlots() {
    if (S.view === "tiles") return (pages()[S.page] || []).map((id) => tiles.get(id)).filter(Boolean).map((t) => ({ plot: t.plot, kind: "tile", id: t.plot.accountId }));
    return [{ plot: ovPlot, kind: "overlay" }, { plot: lanePlot, kind: "lanes" }];
  }
  function plotFor(cv) {
    const el = cv.parentElement;
    return visiblePlots().find((p) => p.plot.el === el) || null;
  }
  function drawCursors(M) {
    M = M || hist.model([...accounts(), ...archived().map((a) => ({ ...a, status: "ok" }))], ctx.now());
    const K = tokens();
    for (const P of visiblePlots()) {
      const c = P.plot.ctx("ovl");
      const { F, X } = P.plot.xmap(vp);
      const Y = (v) => F.b - (v / 100) * F.h;
      if (S.sel) drawSelection(c, F, X, S.sel, P.plot === (S.selSrc && S.selSrc.plot) || P.kind === "overlay");
      if (S.hoverT == null || S.sel) continue;
      const x = X(S.hoverT);
      if (x < F.l - 1 || x > F.r + 1) continue;
      if (P.kind === "lanes") {
        c.strokeStyle = K.ink3; c.lineWidth = 1;
        c.beginPath(); c.moveTo(Math.round(x) + 0.5, laneTop(0) - 2); c.lineTo(Math.round(x) + 0.5, P.plot.h - 2); c.stroke();
        continue;
      }
      if (S.hoverReset && P.id === S.hoverSrc) {
        c.strokeStyle = K.ink; c.lineWidth = 1.5;
        const rx = Math.round(X(S.hoverReset.t)) + 0.5;
        c.beginPath(); c.moveTo(rx, F.t - 4); c.lineTo(rx, F.b); c.stroke();
      }
      cursorLine(c, F, x);
      if (P.kind === "overlay") {
        for (const a of overlayList()) {
          const D = M[a.id]; if (!D) continue;
          const p = valueAt(S.ovKind === "session" ? D.ss : D.wk, S.hoverT, D.iv);
          if (p) dot(c, X(p[0]), Y(p[1]), 3.5, colorOf(a), K.surface, 2);
        }
        continue;
      }
      const a = findAcc(P.id), D = M[P.id];
      if (!a || !D) continue;
      const col = colorOf(a);
      const ps = valueAt(D.ss, S.hoverT, D.iv), pw = valueAt(D.wk, S.hoverT, D.iv);
      if (ps) dot(c, X(ps[0]), Y(ps[1]), 3, col, K.surface, 1.8);
      if (pw) dot(c, X(pw[0]), Y(pw[1]), 4.5, col, K.surface, 2);
      // ホバー元以外のタイル: カーソル上端に小さな読み値（ツールチップは1つだけ）
      if (S.hoverSrc !== P.id) {
        const cond = condAt(D, S.hoverT);
        const txt = pw || ps ? `週 ${pw ? fmtPct(pw[1]) : "—"} · 5h ${ps ? fmtPct(ps[1]) : "—"}` : cond ? cond.short : "記録なし";
        c.font = `600 11px ${K.font}`;
        const tw = c.measureText(txt).width + 12;
        let bx = x + 6; if (bx + tw > F.r + 30) bx = x - 6 - tw;
        c.fillStyle = K.surface; c.strokeStyle = K.lineStrong; c.lineWidth = 1;
        roundRect(c, bx, F.t - 2, tw, 18, 4); c.fill(); c.stroke();
        c.fillStyle = cond && !pw && cond.k === "err" ? K.critInk : K.ink; c.textBaseline = "middle"; c.textAlign = "left";
        c.fillText(txt, bx + 6, F.t + 7);
      }
    }
    // ストリップのカーソル
    const sc = stripPlot.ctx("ovl");
    if (S.hoverT != null && !S.sel) {
      const { F, X } = stripPlot.xmap(vp);
      const x = X(S.hoverT);
      if (x >= F.l && x <= F.r) {
        sc.strokeStyle = K.ink3; sc.lineWidth = 1;
        sc.beginPath(); sc.moveTo(Math.round(x) + 0.5, 0); sc.lineTo(Math.round(x) + 0.5, stripPlot.h); sc.stroke();
      }
    }
  }
  function condAt(D, t) {
    const b = D.bands.find((x) => t >= x.from && t <= x.to);
    if (b) return { k: "err", short: b.status === "logged_out" ? "ログイン切れ" : "取得エラー", text: b.status === "logged_out" ? "ログイン切れ" : "取得エラー" };
    if (D.gaps.some((g) => t > g.from && t < g.to)) return { k: "gap", short: "取得なし", text: "取得できなかった区間（PC のスリープなど）" };
    return null;
  }

  function onSelection(sel, P) {
    S.sel = sel; S.selSrc = P || null;
    if (sel) hideTip();
    drawCursors();
  }
  function onHover(P, cx, cy, tap = false, stripT = null) {
    if (S.sel) return;
    const M = hist.model([...accounts(), ...archived().map((a) => ({ ...a, status: "ok" }))], ctx.now());
    if (!P) {
      // ストリップ: 時刻だけを全グラフに出す
      S.hoverT = stripT; S.hoverSrc = null; S.hoverReset = null;
      drawCursors(M);
      showTip(h("div.tt", h("b", fmtDateTime(stripT))), cx, cy - 40);
      return;
    }
    let t = P.plot.tAt(cx, vp);
    if (t == null) { clearHover(); return; }
    const { F, X } = P.plot.xmap(vp);
    const r = P.plot.el.getBoundingClientRect();
    const py = cy - r.top;
    S.hoverReset = null;
    if (P.kind === "tile") {
      const D = M[P.id];
      if (!D) return;
      // リセット線の上（±4px）
      const near = (arr) => arr.find((rt) => rt >= vp.start && rt <= vp.end && Math.abs(X(rt) - (cx - r.left)) <= 4);
      const rw = near(D.wkRes);
      const rs = !rw && py > F.b - 14 ? near(D.ssRes) : null;
      if (rw) S.hoverReset = { kind: "weekly", t: rw };
      else if (rs) S.hoverReset = { kind: "session", t: rs };
      // カーソルは実際の取得時刻に吸着する（どこが実測かがわかる）
      const n = nearest(D.wk.length ? D.wk : D.ss, t);
      if (S.hoverReset) t = S.hoverReset.t;
      else if (n && Math.abs(X(n[0]) - (cx - r.left)) < 12) t = n[0];
      S.hoverT = t; S.hoverSrc = P.id;
      drawCursors(M);
      showTip(tipTile(findAcc(P.id), D, t), cx, cy);
      return;
    }
    // 重ね合わせ・レーン
    const list = overlayList();
    let lane = null;
    if (P.kind === "lanes") {
      list.forEach((a, i) => { const tp = laneTop(i); if (py >= tp - 2 && py <= tp + LANE.h + 2) lane = a.id; });
    }
    if (lane !== S.hoverLane) { S.hoverLane = lane; vp.redraw(); }
    const ref = list.find((a) => M[a.id] && M[a.id].wk.length);
    const n = ref ? nearest(M[ref.id].wk, t) : null;
    if (n && Math.abs(X(n[0]) - (cx - r.left)) < 12) t = n[0];
    S.hoverT = t; S.hoverSrc = null;
    drawCursors(M);
    showTip(tipOverlay(list, M, t, lane), cx, cy);
  }
  function clearHover() {
    if (S.hoverT == null && !S.hoverLane) { hideTip(); return; }
    S.hoverT = null; S.hoverSrc = null; S.hoverReset = null;
    if (S.hoverLane) { S.hoverLane = null; vp.redraw(); }
    if (root) drawCursors();
    hideTip();
  }

  const keyLine = (c) => { const s = svgEl(`<path d="M1 6h20" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`); return s; };
  const keyArea = (c) => svgEl(`<rect x="1" y="2" width="20" height="9" rx="1.5" fill="${c}" fill-opacity=".3"/><path d="M1 2.5h20" stroke="${c}" stroke-opacity=".7"/>`);
  function tipTile(a, D, t) {
    const col = colorOf(a);
    const pw = valueAt(D.wk, t, D.iv), ps = valueAt(D.ss, t, D.iv);
    const cond = condAt(D, t);
    return [
      h("div.tt", [h("b", fmtDateTime(t)), h("span", a.label)]),
      S.hoverReset ? h("div.resetrow", [S.hoverReset.kind === "weekly" ? "週間リセット " : "5h リセット ", h("b", fmtDateTime(S.hoverReset.t))]) : null,
      h("div.r", [keyLine(col), h("span.val.num", pw ? fmtPct(pw[1]) : "—"), h("span.nm", "週間")]),
      h("div.r", [keyArea(col), h("span.val.num", ps ? fmtPct(ps[1]) : "—"), h("span.nm", "5時間枠")]),
      cond ? h(cond.k === "err" ? "div.warnrow" : "div.gaprow", [cond.k === "err" ? icon("crit") : null, cond.text]) : null,
    ];
  }
  function tipOverlay(list, M, t, lane) {
    const rows = list.map((a) => {
      const D = M[a.id];
      return { a, w: D ? valueAt(D.wk, t, D.iv) : null, s: D ? valueAt(D.ss, t, D.iv) : null };
    });
    const k = S.ovKind === "session" ? "s" : "w";
    rows.sort((p, q) => (q[k] ? q[k][1] : -1) - (p[k] ? p[k][1] : -1));
    return [
      h("div.tt", [h("b", fmtDateTime(t)), h("span", "週間 · 5h")]),
      rows.map((r) => h("div.r.r2", { class: lane === r.a.id ? "hl" : "" }, [keyLine(colorOf(r.a)),
        h("span.val.num", r.w ? fmtPct(r.w[1]) : "—"), h("span.val2.num", r.s ? fmtPct(r.s[1]) : "—"), h("span.nm", r.a.label)])),
    ];
  }

  const tip = () => document.getElementById("tip");
  function showTip(content, cx, cy) {
    const el = tip(); if (!el) return;
    setChildren(el, content);
    el.classList.add("on");
    const r = el.getBoundingClientRect();
    let x = cx + 16, y = cy + 14;
    if (x + r.width > innerWidth - 8) x = cx - 16 - r.width;
    if (y + r.height > innerHeight - 8) y = cy - 14 - r.height;
    el.style.left = Math.max(8, x) + "px"; el.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { const el = tip(); if (el) el.classList.remove("on"); }

  // 週ピークの柱: ホバーで値、押すとその週に拡大
  function onDocMove(e) {
    const pk = e.target.closest && e.target.closest("rect.hit[data-pk]");
    if (pk) {
      const [fs, ra, pp, cur] = pk.dataset.pk.split(",").map(Number);
      showTip([h("div.tt", [h("b", `${fmtDateTime(fs, false)} 〜 ${fmtDateTime(ra, false)} の週`), h("span", cur ? "進行中" : "")]),
        h("div.r", [h("span"), h("span.val.num", fmtPct(pp)), h("span.nm", "週間のピーク")]), h("div.gaprow", "押すとこの週に拡大")], e.clientX, e.clientY);
      S.pkHover = true;
    } else if (S.pkHover) { S.pkHover = false; hideTip(); }
  }
  function onDocClick(e) {
    const pk = e.target.closest && e.target.closest("rect.hit[data-pk]");
    if (pk) {
      const [fs, ra] = pk.dataset.pk.split(",").map(Number);
      vp.setRange(fs, Math.min(ra, ctx.now()));
      flashTile(pk.dataset.acct);
      return;
    }
    if (!(e.target.closest && e.target.closest(".pop, .man-btn"))) {
      for (const [id, t] of tiles) if (t.closePop()) { const a = findAcc(id); a && t.update(a); }
    }
  }

  // =====================================================================
  // キーボード: ←→ ページ（グラフにフォーカスがあればカーソル）、+/− ズーム、Esc プリセットに戻る
  // =====================================================================
  function onKey(e) {
    if (!root) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cv = tg && tg.closest && tg.closest(".plot canvas.ovl");
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && cv) {
      e.preventDefault();
      moveCursorKey(plotFor(cv), e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (tg && tg.closest && tg.closest(".strip")) return;
      if (S.view === "tiles" && pages().length > 1) { e.preventDefault(); goPage(S.page + (e.key === "ArrowRight" ? 1 : -1)); }
      return;
    }
    if (e.key === "+" || e.key === "=" || e.key === ";") { e.preventDefault(); vp.zoom(0.6, { animate: true }); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); vp.zoom(1 / 0.6, { animate: true }); return; }
    if (e.key === "Escape") {
      let handled = false;
      for (const [id, t] of tiles) if (t.closePop()) { const a = findAcc(id); a && t.update(a); handled = true; }
      if (S.sel) { S.sel = null; drawCursors(); handled = true; }
      if (!handled && !vp.preset) vp.reset();
      clearHover();
    }
  }
  function moveCursorKey(P, dir) {
    if (!P) return;
    const M = hist.model([...accounts(), ...archived().map((a) => ({ ...a, status: "ok" }))], ctx.now());
    const id = P.kind === "tile" ? P.id : (overlayList()[0] || {}).id;
    const D = id && M[id];
    if (!D || !D.wk.length) return;
    const pts = D.wk.filter((p) => p[0] >= vp.start && p[0] <= vp.end);
    if (!pts.length) return;
    let i = S.hoverT == null ? pts.length - 1 : pts.findIndex((p) => p[0] >= S.hoverT);
    if (i < 0) i = pts.length - 1;
    if (S.hoverT != null) i = Math.max(0, Math.min(pts.length - 1, i + dir));
    S.hoverT = pts[i][0]; S.hoverSrc = P.kind === "tile" ? P.id : null; S.hoverReset = null;
    drawCursors(M);
    const r = P.plot.el.getBoundingClientRect();
    const { F, X } = P.plot.xmap(vp);
    const cx = r.left + X(S.hoverT), cy = r.top + F.t + 10;
    showTip(P.kind === "tile" ? tipTile(findAcc(P.id), D, S.hoverT) : tipOverlay(overlayList(), M, S.hoverT, null), cx, cy);
  }

  return { mount, unmount, onState, highlight, gotoAccount, vp, isDirty: () => false, _S: S, _hist: hist };
}
