// 推移画面（UI v2: タイル基本＋時間軸ナビゲーション。docs/design/UI-V2.md）。
// 何を: ツールバー（プリセット・範囲・並べる／重ねる・ページ・操作の一覧）、タイルのグリッド（隙間なし・ページ分割）、
//       重ねる表示（凡例を兼ねる今の値の帯＋重ね合わせ＋レーン）、時間軸のストリップ（全期間の縮図＋今の範囲の目盛り）、
//       凡例の1行、ツールチップ。
// なぜ: 全グラフが1つの TimeViewport を見て、どこで操作しても全部に効くようにするため。
// 方針:
//   - viewport の通知（rAF で1フレームに1回）の中で描く。データの canvas は、範囲・大きさ・データ・表示の状態が
//     変わったときだけ描く（描画のキーを比べる）。読み込み中のアニメーションはストリップだけを描き直す。
//   - カーソルや選択範囲は ovl だけ描き直す。
//   - タイルの外枠は作り直さない（state の更新では中身だけ入れ替える）。ページを変えたらグリッドに入れるタイルを差し替える。
//   - ページ分割は件数と上限（ui.tiles_per_page）だけで決める（窓の大きさでページ数を変えない）。各ページに均等に配る。
//   - 大きさが変わったら（ResizeObserver）、見えている Plot を全部測り直してから描く。

import { h, setChildren, icon, spinner, loadPref, savePref, fmtDateTime, fmtDate, fmtPct, fmtSpan, toast } from "./ui.js";
import { createViewport, PRESETS, MAX_SPAN } from "./viewport.js";
import { createHistory, nearest } from "./history.js";
import { Plot, drawTile, drawOverlay, drawLanes, drawStrip, drawSelection, cursorLine, dot, roundRect, tokens, invalidateTokens, lanesHeight, laneTop, LANE, valueAt, stripGeom, mmMap } from "./chart.js";
import { attachInteractions } from "./interact.js";
import { createTile } from "./tiles.js";
import { colorOf, setPalette, dupIndex, dashFor } from "./colors.js";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const pad2 = (n) => String(n).padStart(2, "0");
const fmtRangeEnd = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const PRESET_LABEL = { "24h": "24時間", "7d": "7日", "30d": "30日" };
const MIN_TILE_W = 300, MIN_TILE_H = 230, GAP = 12;
const NARROW_TILE_W = 420, SHORT_TILE_H = 270; // ページ内でいちばん小さいタイルがこれ以下なら、全タイルを詰めた段組みにする
const STRIP_HINT = "⇔ スクロールで拡大・ドラッグで移動";
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
// ページ分割: ページ数 = ceil(件数 / 上限)。各ページに均等に配る（前のページから1件ずつ多く）。
// 例: 7件・上限6 → 4＋3、9件・上限4 → 3＋3＋3、13件・上限6 → 5＋4＋4
export function splitPages(ids, perPage) {
  const n = ids.length;
  if (!n) return [[]];
  const np = Math.ceil(n / perPage);
  const base = Math.floor(n / np), extra = n % np;
  const out = [];
  let i = 0;
  for (let p = 0; p < np; p++) { const k = base + (p < extra ? 1 : 0); out.push(ids.slice(i, i + k)); i += k; }
  return out;
}

export function createDashboard(ctx) {
  const vp = createViewport({ now: ctx.now, preset: loadPref("v2.preset", "7d") });
  const S = {
    view: loadPref("v2.view", "tiles") === "overlay" ? "overlay" : "tiles",
    ovKind: loadPref("v2.ovKind", "weekly_all") === "session" ? "session" : "weekly_all",
    hidden: new Set(), archivedSeen: new Set(),
    focus: null,          // 重ねる表示で強調するアカウント
    focusFromFilter: null,
    filter: null,         // ヘッダーのバッジにホバー中: 対象の id の Set
    page: 0,
    hoverT: null, hoverSrc: null, hoverReset: null, hoverLane: null, stripMiniT: null,
    sel: null, selSrc: null,
    loginBusy: new Set(),
    helpOpen: false,
  };
  let server = null;
  let root = null, E = {};
  const tiles = new Map();          // id → tile
  let ovPlot = null, lanePlot = null, stripPlot = null;
  let inter = null, unsubs = [], ro = null;
  let lastKey = "";
  let gen = 0;                      // 描画のキーに入れる世代（state・大きさ・テーマが変わったら進める）
  let dups = new Map();             // id → 色の重なりの段（0 = 重なりなし）

  const accounts = () => (server ? server.accounts.filter((a) => a.enabled) : []);
  const archived = () => (server ? server.archived || [] : []);
  const intervalOf = (id) => { const a = server && server.accounts.find((x) => x.id === id); return (a && a.interval_minutes) || 10; };
  // 履歴の取得が「いま何を見たいか」を聞くところ。縮図のために、記録の始まりがわかるまで最大 120 日を後ろで取る
  const wanted = () => {
    if (!root) return null;
    const now = ctx.now();
    return { view: [vp.target.start, vp.target.end], bg: hist.earliest == null ? [now - MAX_SPAN, now] : null, now };
  };
  const hist = createHistory({ intervalOf, wanted, onChange: (what) => { renderLoading(); if (what === "loading") animateLoading(); vp.redraw(); } });
  const findAcc = (id) => (server ? server.accounts.find((a) => a.id === id) || archived().find((a) => a.id === id) : null);
  const perPage = () => { const p = server && server.ui && server.ui.tiles_per_page; return [4, 6, 8, 9, 12].includes(p) ? p : 6; };
  const pages = () => splitPages(accounts().map((a) => a.id), perPage());
  const sev = (p) => { const ui = server ? server.ui : { warn_percent: 70, danger_percent: 90 }; return p >= ui.danger_percent ? "crit" : p >= ui.warn_percent ? "warn" : ""; };
  const modelAccounts = () => [...accounts(), ...archived().map((a) => ({ ...a, status: "ok" }))];

  const env = {
    now: ctx.now, sev, colorOf,
    sevKey: () => (server ? `${server.ui.warn_percent}/${server.ui.danger_percent}` : ""),
    busy: () => new Set(server ? server.collector.busy : []),
    refreshOne: (id) => ctx.refreshOne(id),
    refreshState: () => ctx.refreshState(),
    loginBusy: S.loginBusy,
    zoomTo: (s, e, id) => { clearHover(); vp.setRange(s, Math.min(e, ctx.now())); flashTile(id); },
  };
  function invalidate() { gen++; vp.redraw(); }

  // =====================================================================
  // 骨組み
  // =====================================================================
  function mount(el) {
    root = h("div.dash", { class: S.view === "overlay" ? "is-overlay" : "" });
    E.presets = h("div.seg.presets", { role: "group", "aria-label": "期間のプリセット" },
      Object.keys(PRESETS).map((p) => h("button", { type: "button", dataset: { v: p }, onclick: () => { vp.setPreset(p); savePref("v2.preset", p); } }, PRESET_LABEL[p])));
    E.rangeText = h("span.rl-text.num");
    E.rangeSpan = h("span.rl-span");
    E.trim = h("span.trim-note", { hidden: true });
    E.reset = h("button.reset-btn", { type: "button", title: "直前のプリセットに戻る（Esc・グラフをダブルクリックでも）", onclick: () => vp.reset() }, [icon("x"), h("span.lbl", "プリセットに戻る")]);
    E.loading = h("span.loading", { "aria-live": "polite" });
    E.range = h("div.range", [E.rangeText, E.rangeSpan, E.trim, E.reset, E.loading]);
    E.view = h("div.seg.viewseg", { role: "group", "aria-label": "表示" }, [
      h("button", { type: "button", dataset: { v: "tiles" }, title: "アカウントごとに並べる", onclick: () => setView("tiles") }, "並べる"),
      h("button", { type: "button", dataset: { v: "overlay" }, title: "1つのグラフに重ねて比べる", onclick: () => setView("overlay") }, "重ねる"),
    ]);
    E.pager = h("nav.pager", { "aria-label": "ページ" });
    E.helpBtn = h("button.icon-btn.help-btn", { type: "button", "aria-label": "操作の一覧", title: "操作の一覧", "aria-expanded": "false", "aria-controls": "help-pop",
      onclick: (e) => { e.stopPropagation(); toggleHelp(); } }, "?");
    E.help = helpPop();
    E.toolbar = h("div.toolbar", [E.presets, E.range, h("span.grow"), E.view, E.pager, h("div.help-wrap", [E.helpBtn, E.help])]);

    E.grid = h("div.grid");
    E.empty = h("div.empty");
    E.tilesView = h("div.tiles-view", [E.grid, E.empty]);
    // 重ねる表示
    E.legend = h("div.ov-legend", { role: "group", "aria-label": "アカウント（押すと表示／非表示、ダブルクリックでそれだけ表示）" });
    E.showAll = h("button.lg-all", { type: "button", hidden: true, onclick: showAll });
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
    E.strip = h("div.strip.plot", { tabindex: "0", role: "slider",
      "aria-label": "時間軸（上段は全期間の縮図。枠をドラッグで移動・端で範囲を変更・外を押すとそこへ。ホイールで拡大縮小・ダブルクリックでプリセットに戻る）",
      "aria-valuetext": "" });
    E.foot = h("footer.legend-row", legendKeys());
    root.append(E.toolbar, E.body, h("div.strip-wrap", [E.strip]), E.foot);
    el.append(root);

    ovPlot = new Plot(E.ovChart, "overlay");
    lanePlot = new Plot(E.lanes, "lanes");
    lanePlot.alignTo = ovPlot;
    stripPlot = new Plot(E.strip, "strip");
    tiles.clear();
    inter = attachInteractions(root, {
      vp, plotFor, strip: { el: E.strip, plot: stripPlot },
      onHover, onLeave: clearHover, onSelection, onCommit: clearHover, onSwipe: (d) => goPage(S.page + d),
      onPlainWheel,
    });
    unsubs = [vp.subscribe(draw), vp.onBounce(bounce)];
    ro = new ResizeObserver(() => { layout(); measureAll(); invalidate(); });
    for (const x of [E.body, E.strip, E.ovChart, E.lanes]) ro.observe(x);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("click", onDocClick);
    window.addEventListener("ccsmoni:theme", onTheme);
    syncControls();
    if (server) onState(server);
  }
  // 設定などへ移るとき: 操作の層・Plot・購読を外す
  function unmount() {
    for (const u of unsubs) u();
    unsubs = [];
    inter && inter.destroy(); inter = null;
    ro && ro.disconnect(); ro = null;
    clearTimeout(ensureTimer);
    cancelAnimationFrame(loadingRaf); loadingRaf = 0;
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointermove", onDocMove);
    document.removeEventListener("click", onDocClick);
    window.removeEventListener("ccsmoni:theme", onTheme);
    hideTip();
    for (const t of tiles.values()) t.destroy();
    for (const p of [ovPlot, lanePlot, stripPlot]) p && p.destroy();
    ovPlot = lanePlot = stripPlot = null;
    root = null; E = {}; tiles.clear(); lastKey = ""; lastDrawKey = ""; candKey = null; legendChips.clear();
  }
  function onTheme() {
    invalidateTokens();
    if (server) updateTiles();
    renderLegend(); renderPager(); invalidate();
  }

  function legendKeys() {
    const k = (svg, text) => h("span.key", [svgEl(svg), text]);
    return [
      E.cand = h("span.foot-cand"),
      k('<path d="M1 9 L8 6 L14 6 L21 2" stroke="var(--ink-2)" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="8" cy="6" r="2" fill="var(--ink-2)" stroke="var(--surface)" stroke-width="1.2"/>', "週間（点＝取得）"),
      k('<path d="M1 11 L6 5 L12 8 L21 3 L21 11 Z" fill="var(--ink-2)" fill-opacity=".18"/><path d="M1 11 L6 5 L12 8 L21 3" stroke="var(--ink-2)" stroke-opacity=".5" fill="none"/>', "5時間枠"),
      k('<path d="M11 0 V12" stroke="var(--ink-3)" stroke-width="1"/>', "週間リセット"),
      k('<path d="M7 8 V12 M15 8 V12" stroke="var(--ink-3)" stroke-width="1"/>', "5h リセット"),
      k('<defs><pattern id="hk" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0 V4" stroke="var(--ink-3)" stroke-opacity=".5"/></pattern></defs><rect x="1" y="0" width="20" height="12" fill="url(#hk)"/>', "取得できなかった区間"),
      k('<rect x="1" y="9" width="20" height="3" rx="1" fill="var(--st-crit)"/>', "取得エラー・ログイン切れ"),
      k('<rect x="1" y="4" width="20" height="5" rx="2.5" fill="var(--track)"/><rect x="1" y="4" width="11" height="5" rx="2.5" fill="var(--meter)"/><rect x="14" y="1" width="2" height="11" rx="1" fill="var(--ink)"/>', "目盛り＝均等に使った場合"),
      h("span.key.ops", "ドラッグで範囲を拡大 · 時間軸でホイール／ドラッグ · Esc で戻る"),
    ];
  }
  function svgEl(inner) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 22 12"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = inner;
    return s;
  }

  // ---- 操作の一覧（? ボタン） ----
  function helpPop() {
    // dt の中身: 文字列は操作（ドラッグなど）、k() はキー
    const k = (x) => h("kbd", x);
    const row = (what, text) => h("div.hp-row", [h("dt", what), h("dd", text)]);
    return h("div.help-pop", { id: "help-pop", role: "dialog", "aria-label": "操作の一覧", hidden: true, onclick: (e) => e.stopPropagation() }, [
      h("h4", "時間軸の操作"),
      h("dl", [
        row("グラフを横にドラッグ", "その範囲に拡大（どのタイルでも全部に効く）"),
        row([k("Ctrl"), " ＋ ホイール"], "グラフの上で拡大・縮小"),
        row("時間軸の上でホイール", "カーソルの位置を中心に拡大・縮小"),
        row(["時間軸を横にドラッグ／", k("Shift"), " ＋ ホイール"], "前後に移動"),
        row("縮図（時間軸の上段）の枠", "ドラッグで移動・端をドラッグで範囲を変更・枠の外を押すとそこへ"),
        row([k("+"), " ", k("−")], "拡大・縮小"),
        row(["ダブルクリック／", k("Esc")], "プリセットに戻る（ドラッグ中の Esc は選択の取り消し）"),
      ]),
      h("h4", "そのほか"),
      h("dl", [
        row([k("←"), " ", k("→")], "ページを切り替え（グラフにフォーカスがあるときは、取得ごとにカーソルを移動）"),
        row("数字・ヒント・週ピークを押す", "その期間に拡大"),
        row("ヘッダーのバッジを押す", "押すたびに、該当するアカウントへ順に移動"),
        row("凡例の帯（重ねる表示）", "押すと表示／非表示・ダブルクリックでそれだけ表示"),
        row(k("?"), "この一覧を開く・閉じる"),
      ]),
    ]);
  }
  function toggleHelp(open = !S.helpOpen) {
    S.helpOpen = open;
    if (!E.help) return;
    E.help.hidden = !open;
    E.helpBtn.setAttribute("aria-expanded", String(open));
  }
  // グラフの上で修飾キーなしのホイール: 拡大の方法を一度だけ知らせる
  function onPlainWheel() {
    if (loadPref("v2.wheelTip", false)) return;
    savePref("v2.wheelTip", true);
    toast("Ctrl+ホイール、または下の時間軸で拡大できます", "info", 5000);
    if (E.strip && !reducedMotion()) { E.strip.classList.remove("nudge"); void E.strip.offsetWidth; E.strip.classList.add("nudge"); }
  }
  // 記録の始まりで縮小が止まった: 軽く弾ませる
  function bounce() {
    if (!root || reducedMotion()) return;
    const kf = [{ transform: "none" }, { transform: "scaleX(0.985)" }, { transform: "scaleX(1.004)" }, { transform: "none" }];
    E.strip.animate(kf, { duration: 280, easing: "ease-out" });
    E.rangeText.animate([{ transform: "none" }, { transform: "translateX(-4px)" }, { transform: "translateX(2px)" }, { transform: "none" }], { duration: 280, easing: "ease-out" });
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
    updateTiles();
    for (const id of [...tiles.keys()]) if (!accounts().some((a) => a.id === id)) { const t = tiles.get(id); t.el.remove(); t.destroy(); tiles.delete(id); lastKey = ""; }
    renderEmpty();
    renderLegend();
    renderPager();
    layout();
    sizeLanes();
    measureAll();
    applyFilter();
    renderCand(s.candidates || []);
    if (first) ensureData();
    invalidate();
  }
  function updateTiles() {
    dups = dupIndex([...accounts(), ...archived()]);
    for (const a of accounts()) {
      let t = tiles.get(a.id);
      if (!t) { t = createTile(a.id, env); tiles.set(a.id, t); }
      t.update({ ...a, _dup: (dups.get(a.id) || 0) > 0 });
    }
  }
  let candKey = "";
  function renderCand(c) {
    const k = c.map((x) => x.suggested_id).join(",");
    if (!E.cand || k === candKey) return;
    candKey = k;
    setChildren(E.cand, c.length ? [icon("tip"), "新しいアカウント候補 ", h("code", c[0].suggested_id), c.length > 1 ? ` ほか${c.length - 1}` : "", " · ", h("a", { href: "#/settings" }, "設定で追加")] : null);
    E.cand.hidden = !c.length;
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
    // 段組みはページ内でいちばん小さいタイルに揃える（列ごとに段組みが変わらないように）
    let minW = Infinity, minH = Infinity;
    for (const t of want) { const r = t.el.getBoundingClientRect(); minW = Math.min(minW, r.width); minH = Math.min(minH, r.height); }
    E.grid.classList.toggle("is-narrow", minW <= NARROW_TILE_W);
    E.grid.classList.toggle("is-short", fits && minH <= SHORT_TILE_H);
    for (const t of want) t.plot.measure();
  }
  // 見えている Plot を全部測り直す（大きさが変わったら描画のキーが変わる）
  function measureAll() {
    if (!root) return;
    for (const P of visiblePlots()) P.plot.measure();
    stripPlot.measure();
    gen++;
  }

  function goPage(p, { focusId = null } = {}) {
    const np = pages().length;
    p = Math.max(0, Math.min(np - 1, p));
    if (p === S.page || S.view !== "tiles") { if (focusId) flashTile(focusId); return; }
    const dir = p > S.page ? 1 : -1;
    S.page = p;
    clearHover();
    layout();
    renderPager();
    applyFilter();
    invalidate();
    if (!reducedMotion()) E.grid.animate([{ transform: `translateX(${dir * 28}px)`, opacity: 0.35 }, { transform: "none", opacity: 1 }], { duration: 150, easing: "ease-out" });
    if (focusId) flashTile(focusId);
  }
  // 移った先のタイルを光らせる（動きを減らす設定でも、光った状態だけは少しのあいだ出す）
  function flashTile(id) {
    const t = id && tiles.get(id);
    if (!t) return;
    for (const o of tiles.values()) if (o !== t) o.el.classList.remove("flash");
    flash(t.el);
  }
  function flash(el) {
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove("flash"), 1500);
  }

  function renderPager() {
    if (!E.pager) return;
    const ps = pages();
    E.pager.hidden = ps.length < 2 || S.view !== "tiles";
    if (E.pager.hidden) return;
    const fe = document.activeElement;
    const fk = fe && E.pager.contains(fe) ? fe.dataset.fk : null;
    setChildren(E.pager,
      h("button.pg-arrow", { type: "button", "aria-label": "前のページ", title: "前のページ（←）", dataset: { fk: "prev" }, disabled: S.page === 0, onclick: () => goPage(S.page - 1) }, icon("left")),
      ps.map((ids, i) => h("button.pg", {
        type: "button", "aria-current": i === S.page ? "page" : null, dataset: { page: i, fk: `p${i}` },
        "aria-label": `ページ ${i + 1}: ${ids.map((id) => (findAcc(id) || {}).label).join("、")}`,
        title: ids.map((id) => (findAcc(id) || {}).label).join("・"),
        onclick: () => goPage(i),
      }, ids.map((id) => h("i", { style: { background: colorOf(findAcc(id) || {}) } })))),
      h("span.pg-num.num", `${S.page + 1}/${ps.length}`),
      h("button.pg-arrow", { type: "button", "aria-label": "次のページ", title: "次のページ（→）", dataset: { fk: "next" }, disabled: S.page === ps.length - 1, onclick: () => goPage(S.page + 1) }, icon("right")),
    );
    if (fk) { const x = E.pager.querySelector(`[data-fk="${fk}"]`); x && !x.disabled && x.focus({ preventScroll: true }); }
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
  // バッジを押す: そのアカウントのいるページへ移り、タイルを光らせる（順に巡るのは app.js 側）
  function gotoAccount(id) {
    if (!root) return;
    if (S.view !== "tiles") { flashLegend(id); return; }
    const p = pages().findIndex((ids) => ids.includes(id));
    if (p >= 0) goPage(p, { focusId: id });
  }
  function flashLegend(id) {
    const c = E.legend && E.legend.querySelector(`.lg-chip[data-id="${CSS.escape(id)}"]`);
    if (c) flash(c);
  }

  // =====================================================================
  // 重ねる表示
  // =====================================================================
  function overlayList() {
    const out = [];
    for (const a of [...accounts(), ...archived()]) if (!S.hidden.has(a.id)) out.push(a);
    return out;
  }
  // 凡例の帯: id ごとに要素を持ち続け、中身だけ更新する（ポーリングのたびに作り直してフォーカスを失わないように）
  const legendChips = new Map();
  function legendChip(a, isArch) {
    let el = legendChips.get(a.id);
    if (!el) {
      el = h("button.lg-chip", {
        type: "button", dataset: { id: a.id },
        // ダブルクリックは2回目の click（detail === 2）で受ける。1回目の切り替えのあと、2回目で「それだけ表示」にする
        onclick: (e) => {
          const id = el.dataset.id;
          if (e.detail >= 2) { solo(id); return; }
          S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
          renderLegend(); sizeLanes(); invalidate();
        },
        onpointerenter: () => { S.focus = el.dataset.id; vp.redraw(); },
        onpointerleave: () => { S.focus = null; vp.redraw(); },
      }, [h("span.lk"), h("span.nm"), h("span.vals")]);
      legendChips.set(a.id, el);
    }
    const L5 = a.status === "ok" ? (a.limits || []).find((l) => l.kind === "session") : null;
    const LW = a.status === "ok" ? (a.limits || []).find((l) => l.kind === "weekly_all") : null;
    const off = S.hidden.has(a.id);
    const dup = (dups.get(a.id) || 0) > 0;
    el.className = `lg-chip${off ? " off" : ""}${isArch ? " arch" : ""}${dup ? " dup" : ""}${S.filter && !S.filter.has(a.id) ? " dim" : ""}`;
    el.setAttribute("aria-pressed", String(!off));
    el.style.setProperty("--c", colorOf(a));
    el.title = `${a.label}（押すと${off ? "表示" : "非表示"}・ダブルクリックでそれだけ表示）${dup ? "\n同じ色のアカウントがあるため、破線で描きます" : ""}`;
    el.children[1].textContent = a.label;
    const vals = el.children[2];
    const vk = isArch ? "arch" : a.status === "ok" ? `ok|${LW ? LW.percent : ""}|${L5 ? L5.percent : ""}` : a.status;
    if (vals.dataset.k !== vk) {
      vals.dataset.k = vk;
      vals.className = `vals${isArch ? " muted" : a.status === "ok" ? " num" : " crit"}`;
      setChildren(vals, isArch ? "アーカイブ" :
        a.status === "ok" ? [h("b", LW ? fmtPct(LW.percent) : "—"), h("span.sep", "·"), "5h ", L5 ? fmtPct(L5.percent) : "—"] :
        [icon(a.status === "logged_out" ? "crit" : "err"), a.status === "logged_out" ? "ログイン切れ" : "エラー"]);
    }
    return el;
  }
  function renderLegend() {
    if (!E.legend || !server) return;
    const arch = archived();
    const ids = new Set([...accounts(), ...arch].map((a) => a.id));
    for (const id of [...legendChips.keys()]) if (!ids.has(id)) legendChips.delete(id);
    if (!E.lgSep) E.lgSep = h("span.lg-sep", "アーカイブ");
    const kids = [...accounts().map((a) => legendChip(a, false)), ...(arch.length ? [E.lgSep, ...arch.map((a) => legendChip(a, true))] : [])];
    // 「それだけ表示」などで隠したアカウントがあれば、行の末尾に［すべて表示］
    const hiddenN = accounts().filter((a) => S.hidden.has(a.id)).length;
    E.showAll.hidden = !hiddenN;
    E.showAll.textContent = `すべて表示（${hiddenN} 件非表示）`;
    kids.push(E.showAll);
    const cur = [...E.legend.children];
    if (cur.length !== kids.length || cur.some((x, i) => x !== kids[i])) E.legend.replaceChildren(...kids);
  }
  function showAll() {
    for (const a of accounts()) S.hidden.delete(a.id);
    renderLegend(); sizeLanes(); invalidate();
  }
  function solo(id) {
    const all = [...accounts(), ...archived()].map((a) => a.id);
    const alreadySolo = all.every((x) => (x === id ? !S.hidden.has(x) : S.hidden.has(x)));
    S.hidden = new Set(alreadySolo ? archived().map((a) => a.id) : all.filter((x) => x !== id));
    renderLegend(); sizeLanes(); invalidate();
  }
  function sizeLanes() {
    if (!E.lanes || S.view !== "overlay") return;
    const n = overlayList().length;
    const hpx = lanesHeight(Math.max(1, n)) + "px";
    if (E.lanes.style.height !== hpx) E.lanes.style.height = hpx;
    if (lanePlot.measure()) gen++;
  }
  function setView(v) {
    if (v === S.view) return;
    S.view = v; savePref("v2.view", v);
    S.focus = null; clearHover();
    syncControls();
    if (v === "tiles") { lastKey = ""; layout(); }
    else sizeLanes();
    measureAll();
    renderPager();
    invalidate();
  }
  function setOvKind(k) { S.ovKind = k; savePref("v2.ovKind", k); syncControls(); invalidate(); }
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
    ensureTimer = setTimeout(() => { hist.ensure(); renderLoading(); }, vp.animating ? 160 : 60);
  }
  let lastRange = "", lastDrawKey = "";
  const focusId = () => (S.view === "overlay" ? S.focus || S.hoverLane || S.focusFromFilter || null : null);
  function draw() {
    if (!root || !server) return;
    const now = ctx.now();
    const rk = `${Math.round(vp.target.start)}|${Math.round(vp.target.end)}`;
    if (rk !== lastRange) { lastRange = rk; ensureData(); }
    if (hist.earliest != null) vp.setFloor(hist.earliest);
    const busyRange = !hist.isCovered(vp.start, Math.min(vp.end, now));
    root.classList.toggle("is-fetching", busyRange && hist.loadingView);
    const loading = !hist.hasData || hist.loadingView;
    // データの canvas は、描く中身が変わったときだけ描く
    const key = [vp.start, vp.end, hist.version, gen, S.view, S.page, S.ovKind, focusId(), [...S.hidden].join(","),
      Math.floor(now / 60), loading].join("|");
    if (key !== lastDrawKey) {
      lastDrawKey = key;
      const M = hist.model(modelAccounts(), now);
      if (S.view === "tiles") {
        for (const id of pages()[S.page] || []) {
          const t = tiles.get(id), a = findAcc(id);
          if (!t || !a) continue;
          const bad = a.status !== "ok" && a.status !== "never";
          const lw = bad && a.last_ok ? (a.last_ok.limits || []).find((l) => l.kind === "weekly_all") : null;
          drawTile(t.plot, vp, hist.hasData ? M[id] : null, { color: colorOf(a), faded: bad, loading,
            lastOk: lw ? { v: lw.percent, t: a.last_ok.taken_at, now } : null });
        }
      } else {
        const list = overlayList().map((a) => ({ id: a.id, label: a.label, color: colorOf(a), D: M[a.id], dash: dashFor(dups.get(a.id) || 0),
          now5h: a.status === "ok" ? ((a.limits || []).find((l) => l.kind === "session") || {}).percent : null,
          nowWk: a.status === "ok" ? ((a.limits || []).find((l) => l.kind === "weekly_all") || {}).percent : null,
          nowText: a.status === "logged_out" ? "ログイン切れ" : a.status && a.status !== "ok" && a.status !== "never" && a.limits ? "エラー" : null }));
        const focus = focusId();
        drawOverlay(ovPlot, vp, list, S.ovKind, focus);
        // 上が 5h のときは、レーンは週間にする（同じ内容にならないように）
        drawLanes(lanePlot, vp, list, focus, S.ovKind === "session" ? "weekly_all" : "session");
      }
      drawCursors(M);
    }
    drawStripNow(now);
    renderRange(now);
  }
  // 時間軸の縮図の範囲: 記録の始まりがわかっていればそこから、わからなければ取得済みの範囲から（見ている範囲は必ず含める）
  function mmExtent(now) {
    const fl = hist.earliest;
    let s;
    if (fl != null) s = fl - Math.max(300, (now - fl) * 0.02);
    else { const cs = hist.coveredStart; s = cs != null ? Math.min(cs, now - 86400) : now - 7 * 86400; }
    return { s: Math.min(s, vp.target.start, vp.start), e: now };
  }
  function drawStripNow(now = ctx.now()) {
    if (!root || !server) return;
    stripPlot.padOverride = S.view === "overlay" && !ovPlot.narrow ? { l: ovPlot.pad.l + 1, r: ovPlot.pad.r + 1 } : null;
    const ext = mmExtent(now);
    const accs = accounts();
    const M = hist.model(modelAccounts(), now);
    const mm = { s: ext.s, e: ext.e, list: accs.map((a) => ({ color: colorOf(a), D: M[a.id] })), holes: hist.uncoveredIn(ext.s, now),
      key: `${hist.version}|${Math.round(ext.s / 60)}|${Math.round(ext.e / 60)}|${gen}|${accs.map((a) => a.id).join(",")}` };
    drawStrip(stripPlot, vp, { now, holes: hist.uncoveredIn(vp.start, Math.min(vp.end, now)), loading: hist.loadingView, mm, hint: stripPlot.w >= 480 ? STRIP_HINT : null });
  }
  // 読み込み中のアニメーションはストリップだけ（データのグラフは毎フレーム描かない）
  let loadingRaf = 0;
  function animateLoading() {
    if (loadingRaf) return;
    const step = () => {
      loadingRaf = 0;
      if (!root) return;
      drawStripNow();
      if (hist.loadingView) loadingRaf = requestAnimationFrame(step);
    };
    loadingRaf = requestAnimationFrame(step);
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
    // プリセットの左端を記録の始まりで詰めているとき: ボタンの長さと表示の長さが違う理由を出す
    const trimmed = !!p && vp.trimmed && vp.floor != null;
    E.trim.hidden = !trimmed;
    if (trimmed) {
      const d = (now - vp.floor) / 86400;
      const len = d >= 1 ? `${Math.round(d)}日分` : `${Math.max(1, Math.round(d * 24))}時間分`;
      const txt = `記録は ${fmtDate(vp.floor)} から（${len}）`;
      if (E.trim.textContent !== txt) {
        E.trim.textContent = txt;
        E.trim.title = `${PRESET_LABEL[p]}より記録が短いので、記録の始まりから表示しています`;
      }
    }
  }
  function renderLoading() {
    if (!E.loading) return;
    const busy = hist.loadingView;
    const failed = hist.failed && !busy;
    setChildren(E.loading, busy ? [spinner(), h("span", hist.hasData ? "範囲を読み込み中…" : "読み込み中…")]
      : failed ? h("span.fail", { title: hist.failed.message }, ["履歴を読み込めませんでした ", h("button.link", { type: "button", onclick: () => { hist.retry(); renderLoading(); } }, "再試行")]) : null);
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
    if (!root) return;
    M = M || hist.model(modelAccounts(), ctx.now());
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
    // ストリップのカーソル（下段: 今の範囲の上の時刻、上段: 縮図の上の時刻）
    const sc = stripPlot.ctx("ovl");
    const G = stripGeom(stripPlot);
    if (S.hoverT != null && !S.sel) {
      const { F, X } = stripPlot.xmap(vp);
      const x = X(S.hoverT);
      if (x >= F.l && x <= F.r) {
        sc.strokeStyle = K.ink3; sc.lineWidth = 1;
        sc.beginPath(); sc.moveTo(Math.round(x) + 0.5, G.axT); sc.lineTo(Math.round(x) + 0.5, G.axB); sc.stroke();
      }
    }
    const MM = mmMap(stripPlot);
    const mt = S.stripMiniT != null ? S.stripMiniT : S.hoverT;
    if (MM && mt != null && !S.sel) {
      const x = Math.round(MM.X(mt)) + 0.5;
      sc.strokeStyle = K.ink2; sc.lineWidth = 1;
      sc.beginPath(); sc.moveTo(x, G.mmT - 1); sc.lineTo(x, G.mmB + 1); sc.stroke();
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
  // stripMode: "axis"（下段）| "mini"（縮図の枠の上）| "jump"（縮図の枠の外。押すとそこへ）
  function onHover(P, cx, cy, tap = false, stripT = null, stripMode = "axis") {
    if (S.sel) return;
    const M = hist.model(modelAccounts(), ctx.now());
    if (!P) {
      if (stripT == null) { clearHover(); return; }
      if (stripMode === "axis") {
        // 下段: 時刻だけを全グラフに出す
        S.hoverT = stripT; S.stripMiniT = null;
      } else {
        // 上段（縮図）: 見えている範囲の中なら全グラフにも出す
        S.stripMiniT = stripT;
        S.hoverT = stripT >= vp.start && stripT <= vp.end ? stripT : null;
      }
      S.hoverSrc = null; S.hoverReset = null;
      drawCursors(M);
      showTip(h("div.tt", [h("b", fmtDateTime(stripT)), stripMode === "jump" ? h("span", "押すとここへ") : null]), cx, cy - 40);
      return;
    }
    S.stripMiniT = null;
    let t = P.plot.tAt(cx, vp);
    if (t == null) { clearHover(); return; }
    const { F, X } = P.plot.xmap(vp);
    const loc = P.plot.local(cx, cy);
    S.hoverReset = null;
    if (P.kind === "tile") {
      const D = M[P.id];
      if (!D) return;
      // リセット線の上（±4px）
      const near = (arr) => arr.find((rt) => rt >= vp.start && rt <= vp.end && Math.abs(X(rt) - loc.x) <= 4);
      const rw = near(D.wkRes);
      const rs = !rw && loc.y > F.b - 14 ? near(D.ssRes) : null;
      if (rw) S.hoverReset = { kind: "weekly", t: rw };
      else if (rs) S.hoverReset = { kind: "session", t: rs };
      // カーソルは実際の取得時刻に吸着する（どこが実測かがわかる）
      const n = nearest(D.wk.length ? D.wk : D.ss, t);
      if (S.hoverReset) t = S.hoverReset.t;
      else if (n && Math.abs(X(n[0]) - loc.x) < 12) t = n[0];
      S.hoverT = t; S.hoverSrc = P.id;
      drawCursors(M);
      showTip(tipTile(findAcc(P.id), D, t), cx, cy);
      return;
    }
    // 重ね合わせ・レーン
    const list = overlayList();
    let lane = null;
    if (P.kind === "lanes") {
      list.forEach((a, i) => { const tp = laneTop(i); if (loc.y >= tp - 2 && loc.y <= tp + LANE.h + 2) lane = a.id; });
    }
    if (lane !== S.hoverLane) { S.hoverLane = lane; vp.redraw(); }
    const ref = list.find((a) => M[a.id] && M[a.id].wk.length);
    const n = ref ? nearest(M[ref.id].wk, t) : null;
    if (n && Math.abs(X(n[0]) - loc.x) < 12) t = n[0];
    S.hoverT = t; S.hoverSrc = null;
    drawCursors(M);
    showTip(tipOverlay(list, M, t, lane), cx, cy);
  }
  function clearHover() {
    if (S.hoverT == null && !S.hoverLane && S.stripMiniT == null) { hideTip(); return; }
    S.hoverT = null; S.hoverSrc = null; S.hoverReset = null; S.stripMiniT = null;
    if (S.hoverLane) { S.hoverLane = null; vp.redraw(); }
    if (root) drawCursors();
    hideTip();
  }

  const keyLine = (c, dashed) => svgEl(`<path d="M1 6h20" stroke="${c}" stroke-width="2.6" ${dashed ? 'stroke-dasharray="4 2.5"' : 'stroke-linecap="round"'}/>`);
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
      rows.map((r) => h("div.r.r2", { class: lane === r.a.id ? "hl" : "" }, [keyLine(colorOf(r.a), (dups.get(r.a.id) || 0) > 0),
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
  let pkHover = false;
  function onDocMove(e) {
    const pk = e.target.closest && e.target.closest("rect.hit[data-pk]");
    if (pk) {
      const [fs, ra, pp, cur] = pk.dataset.pk.split(",").map(Number);
      showTip([h("div.tt", [h("b", `${fmtDateTime(fs, false)} 〜 ${fmtDateTime(ra, false)} の週`), h("span", cur ? "進行中" : "")]),
        h("div.r", [h("span"), h("span.val.num", fmtPct(pp)), h("span.nm", "週間のピーク")]), h("div.gaprow", "押すとこの週に拡大")], e.clientX, e.clientY);
      pkHover = true;
    } else if (pkHover) { pkHover = false; hideTip(); }
  }
  function onDocClick(e) {
    const pk = e.target.closest && e.target.closest("rect.hit[data-pk]");
    if (pk) {
      const [fs, ra] = pk.dataset.pk.split(",").map(Number);
      clearHover();
      vp.setRange(fs, Math.min(ra, ctx.now()));
      flashTile(pk.dataset.acct);
      return;
    }
    if (!(e.target.closest && e.target.closest(".pop, .man-btn, .t-hint .more"))) for (const t of tiles.values()) t.closePop();
    if (S.helpOpen && !(e.target.closest && e.target.closest(".help-wrap"))) toggleHelp(false);
  }

  // =====================================================================
  // キーボード: ←→ ページ（グラフにフォーカスがあればカーソル）、+/− ズーム、Esc 取り消し／プリセットに戻る
  // =====================================================================
  function onKey(e) {
    if (!root) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      // 近いものから1つずつ閉じる: ドラッグ中の選択 → 操作の一覧 → ポップオーバー → 独自の範囲
      if (inter && inter.cancel()) { S.sel = null; drawCursors(); return; }
      if (S.helpOpen) { toggleHelp(false); E.helpBtn.focus({ preventScroll: true }); return; }
      let handled = false;
      for (const t of tiles.values()) if (t.closePop()) handled = true;
      if (S.sel) { S.sel = null; drawCursors(); handled = true; }
      if (!handled && !vp.preset) vp.reset();
      clearHover();
      return;
    }
    const cv = tg && tg.closest && tg.closest(".plot canvas.ovl");
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && cv && !tg.closest(".strip")) {
      e.preventDefault();
      moveCursorKey(plotFor(cv), e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (tg && tg.closest && tg.closest(".strip")) return;
      if (S.view === "tiles" && pages().length > 1) { e.preventDefault(); goPage(S.page + (e.key === "ArrowRight" ? 1 : -1)); }
      return;
    }
    if (e.key === "+" || e.key === "=" || e.key === ";") { e.preventDefault(); clearHover(); vp.zoom(0.6, { animate: true }); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); clearHover(); vp.zoom(1 / 0.6, { animate: true }); return; }
    if (e.key === "?") { e.preventDefault(); toggleHelp(); }
  }
  function moveCursorKey(P, dir) {
    if (!P) return;
    const M = hist.model(modelAccounts(), ctx.now());
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

  return {
    mount, unmount, onState, highlight, gotoAccount, vp, isDirty: () => false,
    get view() { return S.view; },
  };
}
