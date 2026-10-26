// 方向性 A「マトリクス（Cockpit）」— demo-data.js だけで動くプロトタイプ。
// 行＝アカウント（凡例を兼ねる）。下に週間の重ね合わせ＋5h のレーン（x 軸を共有）。
(() => {
  "use strict";

  const SRC = window.CCSMONI_DEMO;
  const Q = new URLSearchParams(location.search);
  const N = Math.max(1, Math.min(7, parseInt(Q.get("n") || "4", 10) || 4));
  const DAY = 86400, HOUR = 3600, WEEK = 7 * DAY;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const $ = (s) => document.querySelector(s);
  const NS = "http://www.w3.org/2000/svg";

  // ------------------------------------------------------------------ データ
  const M = JSON.parse(JSON.stringify(SRC));
  const NOW = M.state.now;
  const UI = M.state.ui;

  // ?n=6 など: 既存のアカウントを複製・改変して増やす
  function cloneAcct(srcId, id, label, plan, ws, ss, patch) {
    const src = M.state.accounts.find((a) => a.id === srcId);
    const a = JSON.parse(JSON.stringify(src));
    const sc = (kind, v) => clamp(Math.round(v * (kind === "session" ? ss : ws)), 0, 100);
    Object.assign(a, { id, label, plan, launch_command: "claude-" + id });
    for (const L of [a.limits, a.last_ok && a.last_ok.limits]) {
      if (!L) continue;
      for (const l of L) l.percent = sc(l.kind, l.percent);
    }
    Object.assign(a, patch || {});
    M.state.accounts.push(a);
    for (const k of ["history_24h", "history_7d", "history_30d"]) {
      const h = M[k];
      h.series.filter((s) => s.account_id === srcId).forEach((s) =>
        h.series.push({
          ...s, account_id: id,
          segments: s.segments.map((g) => ({ ...g, points: g.points.map(([t, v]) => [t, sc(s.kind, v)]) })),
        }));
      for (const key of ["resets", "gaps", "errors"])
        h[key].filter((r) => r.account_id === srcId).forEach((r) => h[key].push({ ...r, account_id: id }));
    }
    for (const k of ["windows_weekly", "windows_session"]) {
      const r = M[k].rows.find((r) => r.account_id === srcId);
      if (r) M[k].rows.push({
        account_id: id,
        windows: r.windows.map((w) => ({ ...w, peak_percent: sc(k === "windows_session" ? "session" : "w", w.peak_percent) })),
      });
    }
  }
  if (N >= 5) cloneAcct("acct-c", "acct-f", "副業", "max", 2.9, 1, {
    hints: [{ kind: "near_limit", text: "週間 90%・リセットまで 19 時間。残り 10% で配分を" }],
  });
  if (N >= 6) cloneAcct("acct-a", "acct-g", "OSS", "pro", 0.45, 0.6, {
    stale: true, taken_at: NOW - 41 * 60,
    hints: [{ kind: "stale", text: "41 分取得できていません（間隔の 3 倍超）" }],
  });
  if (N >= 7) cloneAcct("acct-b", "acct-h", "実験", "max", 0.7, 0.8, { hints: [] });
  M.state.accounts = M.state.accounts.slice(0, N);
  const ACC = M.state.accounts;
  ACC.forEach((a, i) => { a.ci = i; a.cv = `var(--c${i})`; });

  const byId = Object.fromEntries(ACC.map((a) => [a.id, a]));
  const HIST = { "24h": M.history_24h, "7d": M.history_7d, "30d": M.history_30d };
  const series = (h, id, kind) => (h.series.find((s) => s.account_id === id && s.kind === kind) || { segments: [] }).segments;
  const lim = (list, kind) => (list || []).find((l) => l.kind === kind);
  const curLimits = (a) => (a.status === "ok" ? a.limits : (a.last_ok && a.last_ok.limits) || []);

  // ------------------------------------------------------------------ 書式
  const WD = "日月火水木金土";
  const pad = (n) => String(n).padStart(2, "0");
  const D8 = (t) => new Date(t * 1000);
  const fmtHM = (t) => { const d = D8(t); return `${d.getHours()}:${pad(d.getMinutes())}`; };
  const fmtDay = (t) => { const d = D8(t); return `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})`; };
  const fmtWdHM = (t) => `${WD[D8(t).getDay()]} ${fmtHM(t)}`;
  const fmtLeft = (s) => {
    if (s <= 0) return "—";
    if (s < HOUR) return `${Math.max(1, Math.round(s / 60))}分`;
    if (s < DAY) return `${Math.floor(s / HOUR)}:${pad(Math.floor((s % HOUR) / 60))}`;
    return `${Math.floor(s / DAY)}日 ${Math.floor((s % DAY) / HOUR)}時間`;
  };
  const ago = (s) => s < 60 ? "たった今" : s < HOUR ? `${Math.round(s / 60)}分前` : s < DAY ? `${Math.round(s / HOUR)}時間前` : `${Math.round(s / DAY)}日前`;
  const sev = (p) => (p >= UI.danger_percent ? "crit" : p >= UI.warn_percent ? "warn" : "");

  // DOM ヘルパー（ラベルは textContent で入れる）
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "html") e.innerHTML = v; // 固定の SVG アイコンだけに使う
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  function sv(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    return e;
  }

  const ICON = {
    warn: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1.8 13 12.2H1z" fill="var(--warn)"/><path d="M7 5.6v3.2M7 10.2v.1" stroke="#0b0b0b" stroke-width="1.4" stroke-linecap="round"/></svg>',
    crit: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2.2" y="2.2" width="9.6" height="9.6" rx="1.6" transform="rotate(45 7 7)" fill="var(--crit)"/><path d="M7 4.4v3.4M7 9.5v.1" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.4" fill="none" stroke="var(--ink-2)" stroke-width="1.3"/><path d="M7 6.4v3.4M7 4.3v.1" stroke="var(--ink-2)" stroke-width="1.4" stroke-linecap="round"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.4" fill="none" stroke="var(--muted)" stroke-width="1.3"/><path d="M7 4v3.2l2 1.3" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linecap="round"/></svg>',
    ok: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 7.3 6 9.6l4.5-5" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M11.6 6.2A4.7 4.7 0 1 0 10.4 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.9 2.6v3.8H8.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    moon: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M11.8 8.6A5.2 5.2 0 0 1 5.4 2.2a5.2 5.2 0 1 0 6.4 6.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    sun: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13M2.8 2.8l1.1 1.1M10.1 10.1l1.1 1.1M2.8 11.2l1.1-1.1M10.1 3.9l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    plus: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  // ------------------------------------------------------------------ 状態
  const S = { range: "7d", lanes: true, hidden: new Set(), hover: null, pinned: null };
  const focusId = () => S.hover || S.pinned;

  // ------------------------------------------------------------------ ツールチップ
  const tip = $("#tip");
  function showTip(x, y, build) {
    tip.replaceChildren();
    build(tip);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  const tipText = (title, lines) => (t) => {
    if (title) t.append(el("h4", null, title));
    for (const l of lines) t.append(l.nodeType ? l : el("p", null, l));
  };

  // ------------------------------------------------------------------ ヘッダー
  function renderTop() {
    let crit = 0, warn = 0, out = 0;
    for (const a of ACC) {
      if (a.status !== "ok") { out++; continue; }
      const mx = Math.max(...a.limits.map((l) => l.percent));
      if (mx >= UI.danger_percent) crit++;
      else if (mx >= UI.warn_percent || a.hints.some((h) => h.kind === "will_hit_limit")) warn++;
    }
    const sum = $("#sum");
    sum.replaceChildren(...[
      el("span", { class: "chip" }, el("b", { class: "num" }, String(ACC.length)), "アカウント"),
      crit ? el("span", { class: "chip" }, el("span", { html: ICON.crit }), "上限間近", el("b", { class: "num" }, crit)) : null,
      warn ? el("span", { class: "chip" }, el("span", { html: ICON.warn }), "要注意", el("b", { class: "num" }, warn)) : null,
      out ? el("span", { class: "chip" }, el("span", { html: ICON.crit }), "ログイン切れ", el("b", { class: "num" }, out)) : null,
      ...M.state.candidates.map((c) => el("span", {
        class: "chip cand", tabindex: 0,
        onmouseenter: (e) => showTip(e.clientX, e.clientY, tipText("新しいアカウント候補", [c.config_dir])),
        onmouseleave: hideTip,
      }, el("span", { html: ICON.plus }), "候補 ", el("b", null, c.suggested_id), el("span", { class: "go" }, "設定で追加 →"))),
    ].filter(Boolean));
    const c = M.state.collector;
    $("#fresh").replaceChildren("最終更新 ", el("b", null, ago(NOW - c.last_run_at)), el("span", { class: "fresh-sep" }, " ・ 次回 "), el("b", { class: "fresh-sep" }, fmtLeft(c.next_run_at - NOW) + "後"));
    $("#refreshAll").innerHTML = ICON.refresh + "<span>今すぐ更新</span>";
    syncThemeIcon();
  }
  function syncThemeIcon() {
    const dark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    $("#themeBtn").innerHTML = dark ? ICON.sun : ICON.moon;
    return dark;
  }
  $("#themeBtn").addEventListener("click", () => {
    document.documentElement.dataset.theme = syncThemeIcon() ? "light" : "dark";
    syncThemeIcon();
  });
  function fakeSpin(btn) {
    btn.classList.add("spin");
    setTimeout(() => btn.classList.remove("spin"), 1600);
  }
  $("#refreshAll").addEventListener("click", (e) => fakeSpin(e.currentTarget));

  // ------------------------------------------------------------------ 行
  function meterCell(a, kind) {
    const live = a.status === "ok";
    const l = lim(curLimits(a), kind);
    const box = el("div", { class: "meter" + (live ? "" : " stale-v") });
    if (!l) { box.append(el("span", { class: "v num" }, "—"), el("div", { class: "bar" }), el("span", { class: "m" }, "値なし")); return box; }
    const p = l.percent;
    const reset = l.resets_at;
    const notStarted = reset == null && p === 0;
    const passed = reset != null && reset <= NOW;
    const bar = el("div", { class: "bar" });
    if (p > 0) bar.append(el("div", { class: "f " + (live ? sev(p) : ""), style: `width:${clamp(p, 0, 100)}%` }));
    if (live && l.pace) bar.append(el("div", { class: "pace", style: `left:${clamp(l.pace.expected_percent, 0, 100)}%` }));
    let meta;
    if (notStarted) meta = el("span", { class: "m" }, "未開始");
    else if (!live) meta = el("span", { class: "m" }, passed ? "リセット済み（推定）" : `前回値 ・ あと ${fmtLeft(reset - NOW)}`);
    else {
      meta = el("span", { class: "m" }, "あと ", el("b", { class: "num" }, fmtLeft(reset - NOW)),
        l.pace ? ` ・ 目安 ${Math.round(l.pace.expected_percent)}%` : "");
    }
    box.append(el("span", { class: "v num" }, String(Math.round(p)), el("small", null, "%")), bar, meta);
    box.addEventListener("mousemove", (e) => showTip(e.clientX, e.clientY, (t) => {
      t.append(el("h4", null, `${a.label} ・ ${kind === "session" ? "5時間枠" : "週間枠"}${live ? "" : "（前回わかった値）"}`));
      t.append(el("p", null, "使用率 ", el("b", null, `${p}%`)));
      if (l.pace) t.append(el("p", null, "均等ペースの目安 ", el("b", null, `${Math.round(l.pace.expected_percent)}%`), el("span", { class: "muted" }, "（目盛り）")));
      if (reset) t.append(el("p", null, "リセット ", el("b", null, fmtWdHM(reset)), el("span", { class: "muted" }, reset > NOW ? `（あと ${fmtLeft(reset - NOW)}）` : "")));
      if (l.pace && l.pace.eta_full) t.append(el("p", null, "このペースで 100% ", el("b", null, fmtWdHM(l.pace.eta_full))));
      if (kind === "session") {
        const row = M.windows_session.rows.find((r) => r.account_id === a.id);
        if (row) t.append(el("p", { class: "muted" }, "直近の5h枠ピーク: " + row.windows.slice(0, 8).map((w) => w.peak_percent).join(" · ")));
      }
    }));
    box.addEventListener("mouseleave", hideTip);
    return box;
  }

  // 今週の枠（開始 → リセット）のスパークライン
  function sparkCell(a) {
    const wrap = el("div", { class: "spark" });
    wrap._draw = () => drawSpark(wrap, a);
    return wrap;
  }
  function drawSpark(wrap, a) {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W) return;
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
    const wl = lim(curLimits(a), "weekly_all");
    if (!wl || !wl.resets_at) { wrap.replaceChildren(svg); return; }
    const R = wl.resets_at, S0 = R - WEEK;
    const h = M.history_7d;
    const x = (t) => ((t - S0) / WEEK) * W;
    const y = (v) => H - 3 - (v / 100) * (H - 6);
    const xn = x(NOW);
    // 未来の部分（今 → リセット）は薄く敷く
    svg.append(sv("rect", { x: xn, y: 0, width: Math.max(0, W - xn), height: H, fill: "var(--future)" }));
    svg.append(sv("line", { x1: 0, x2: W, y1: y(0) + 0.5, y2: y(0) + 0.5, stroke: "var(--axis)", "stroke-width": 1 }));
    // 均等ペースの対角線
    svg.append(sv("line", { x1: 0, y1: y(0), x2: W, y2: y(100), stroke: "var(--axis)", "stroke-width": 1 }));
    const g = sv("g", { class: "spk" });
    // 5h の面
    for (const seg of series(h, a.id, "session")) {
      const pts = seg.points.filter(([t]) => t >= S0);
      if (pts.length < 2) continue;
      const d = "M" + pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("L") + `L${x(pts[pts.length - 1][0]).toFixed(1)},${y(0)}L${x(pts[0][0]).toFixed(1)},${y(0)}Z`;
      g.append(sv("path", { d, fill: a.cv, "fill-opacity": 0.16 }));
    }
    // 週間の線＋変化した点
    let last = null;
    for (const seg of series(h, a.id, "weekly_all")) {
      if (seg.resets_at !== R) continue;
      const pts = seg.points;
      g.append(sv("path", { d: "M" + pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("L"), fill: "none", stroke: a.cv, "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      last = pts[pts.length - 1];
    }
    if (last) g.append(sv("circle", { cx: x(last[0]), cy: y(last[1]), r: 3.2, fill: a.cv, stroke: "var(--panel)", "stroke-width": 1.5 }));
    svg.append(g);
    svg.append(sv("line", { x1: xn, x2: xn, y1: 0, y2: H, stroke: "var(--ink-2)", "stroke-width": 1, "stroke-opacity": 0.5 }));
    // ホバー
    const cross = sv("line", { x1: 0, x2: 0, y1: 0, y2: H, stroke: "var(--ink)", "stroke-width": 1, visibility: "hidden" });
    svg.append(cross);
    wrap.replaceChildren(svg);
    wrap.onmousemove = (e) => {
      const r = wrap.getBoundingClientRect();
      const t = S0 + ((e.clientX - r.left) / r.width) * WEEK;
      cross.setAttribute("x1", e.clientX - r.left); cross.setAttribute("x2", e.clientX - r.left); cross.setAttribute("visibility", "visible");
      const wv = valueAt(series(h, a.id, "weekly_all").filter((s) => s.resets_at === R), t);
      const sv5 = valueAt(series(h, a.id, "session"), t);
      showTip(e.clientX, e.clientY, (tp) => {
        tp.append(el("h4", null, `${a.label} ・ ${fmtDay(Math.min(t, NOW))} ${fmtHM(Math.min(t, NOW))}`));
        if (t > NOW) { tp.append(el("p", null, "リセットまで ", el("b", null, fmtLeft(R - NOW)), el("span", { class: "muted" }, `（${fmtWdHM(R)}）`))); return; }
        tp.append(el("p", null, "週間 ", el("b", null, wv == null ? "—" : `${wv}%`), el("span", { class: "muted" }, `  均等ペース ${Math.round(((t - S0) / WEEK) * 100)}%`)));
        tp.append(el("p", null, "5h ", el("b", null, sv5 == null ? "—" : `${sv5}%`)));
      });
    };
    wrap.onmouseleave = () => { cross.setAttribute("visibility", "hidden"); hideTip(); };
  }

  // 週ピーク（6週。古い → 今週）。色は無彩色の濃淡（量）
  function peaksCell(a) {
    const row = M.windows_weekly.rows.find((r) => r.account_id === a.id);
    const ws = row ? row.windows.slice(0, 6).reverse() : [];
    const box = el("div", { class: "peaks" });
    for (let i = 0; i < 6 - ws.length; i++) box.append(el("div", { class: "pk empty" }, "—"));
    for (const w of ws) {
      const p = w.peak_percent;
      const k = 5 + p * 0.5; // インクの濃さ 5〜60%
      const cur = w.resets_at > NOW;
      const c = el("div", {
        class: "pk num" + (cur ? " now" : "") + (p >= UI.danger_percent ? " over" : ""),
        style: `background:color-mix(in oklab, var(--ink) ${k}%, var(--panel));color:${k > 40 ? "var(--panel)" : "var(--ink)"}`,
      }, String(Math.round(p)));
      c.addEventListener("mousemove", (e) => showTip(e.clientX, e.clientY, tipText(`${a.label} ・ ${cur ? "今週（進行中）" : "週間枠"}`, [
        el("p", null, `${fmtDay(w.resets_at - WEEK)} 〜 ${fmtDay(w.resets_at)}`),
        el("p", null, "ピーク ", el("b", null, `${p}%`), p >= UI.danger_percent ? el("span", { class: "muted" }, `（${UI.danger_percent}% 超）`) : ""),
      ])));
      c.addEventListener("mouseleave", hideTip);
      box.append(c);
    }
    return box;
  }

  function hintCell(a) {
    const box = el("div", { class: "hint" });
    if (a.status !== "ok") {
      box.classList.add("crit");
      const label = a.status === "logged_out" ? "ログイン切れ" : a.status === "never" ? "未取得" : "取得エラー";
      const since = a.last_ok ? ` ・ ${ago(NOW - a.last_ok.taken_at)}の値を表示` : "";
      box.append(el("span", { class: "ic", html: ICON.crit }), el("span", { class: "tx" }, el("b", null, label), since));
      if (a.status === "logged_out") {
        const b = el("button", { class: "btn sm", type: "button" }, "ログイン");
        b.addEventListener("click", (e) => { e.stopPropagation(); openLogin(a, b); });
        box.append(b);
      }
      box.addEventListener("mousemove", (e) => { if (!e.target.closest("button")) showTip(e.clientX, e.clientY, tipText(label, [a.message || ""])); });
      box.addEventListener("mouseleave", hideTip);
      return box;
    }
    if (!a.hints.length) {
      box.classList.add("none");
      box.append(el("span", { class: "ic", html: ICON.ok }), el("span", { class: "tx" }, "問題なし"));
      return box;
    }
    const icon = (h) => (h.kind === "will_hit_limit" || h.kind === "near_limit" ? ICON.warn : h.kind === "stale" ? ICON.clock : ICON.info);
    const h0 = a.hints[0];
    box.append(el("span", { class: "ic", html: icon(h0) }), el("span", { class: "tx" }, h0.text));
    if (a.hints.length > 1) box.append(el("span", { class: "more" }, `+${a.hints.length - 1}`));
    box.addEventListener("mousemove", (e) => showTip(e.clientX, e.clientY, tipText("ヒント", a.hints.map((h) => el("p", null, el("span", { html: icon(h), style: "display:inline-block;vertical-align:-2px;margin-right:6px" }), h.text)))));
    box.addEventListener("mouseleave", hideTip);
    return box;
  }

  function whoCell(a) {
    const meta = a.stale
      ? el("div", { class: "meta" }, el("span", { class: "stale" }, `${ago(NOW - a.taken_at)} ・ 遅延`))
      : el("div", { class: "meta" }, `${a.interval_minutes}分ごと ・ ${ago(NOW - a.taken_at)}`);
    return el("div", { class: "who" },
      el("div", { class: "nm" }, el("b", null, a.label), a.plan ? el("span", { class: "plan" }, a.plan.toUpperCase()) : null),
      meta);
  }

  const rowsEl = $("#rows");
  function renderRows() {
    rowsEl.replaceChildren();
    for (const a of ACC) {
      const vis = el("button", {
        class: "vis", type: "button", style: `--acc:${a.cv}`, "aria-pressed": String(!S.hidden.has(a.id)),
        title: "クリックで表示／非表示・ダブルクリックでこれだけ表示", "aria-label": `${a.label} をグラフに表示`,
      }, el("i"));
      vis.addEventListener("click", (e) => { e.stopPropagation(); toggleHidden(a.id); });
      vis.addEventListener("dblclick", (e) => { e.stopPropagation(); solo(a.id); });
      const refresh = el("button", { type: "button", title: "このアカウントを今すぐ更新", "aria-label": "今すぐ更新", html: ICON.refresh });
      refresh.addEventListener("click", (e) => { e.stopPropagation(); fakeSpin(refresh); });
      const row = el("div", { class: "grid-row row", "data-id": a.id, style: `--acc:${a.cv}` },
        el("div", { class: "c-vis" }, vis),
        el("div", { class: "c-who dim-when-off" }, whoCell(a)),
        el("div", { class: "c-5h" }, meterCell(a, "session")),
        el("div", { class: "c-wk" }, meterCell(a, "weekly_all")),
        el("div", { class: "c-sp dim-when-off" }, sparkCell(a)),
        el("div", { class: "c-pk" }, peaksCell(a)),
        el("div", { class: "c-hn" }, hintCell(a)),
        el("div", { class: "c-act act" }, refresh),
      );
      row.addEventListener("mouseenter", () => setHover(a.id));
      row.addEventListener("mouseleave", () => setHover(null));
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        S.pinned = S.pinned === a.id ? null : a.id;
        applyFocus();
      });
      rowsEl.append(row);
    }
    syncRows();
    drawSparks();
  }
  function drawSparks() { rowsEl.querySelectorAll(".spark").forEach((w) => w._draw && w._draw()); }
  function syncRows() {
    for (const r of rowsEl.children) {
      const id = r.dataset.id;
      r.classList.toggle("off", S.hidden.has(id));
      r.querySelector(".vis").setAttribute("aria-pressed", String(!S.hidden.has(id)));
      r.classList.toggle("pinned", S.pinned === id);
      r.classList.toggle("hl", S.hover === id);
    }
  }
  function toggleHidden(id) {
    S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
    syncRows(); renderChart();
  }
  function solo(id) {
    const only = ACC.every((a) => a.id === id || S.hidden.has(a.id)) && !S.hidden.has(id);
    S.hidden = new Set(only ? [] : ACC.filter((a) => a.id !== id).map((a) => a.id));
    syncRows(); renderChart();
  }
  function setHover(id) { S.hover = id; applyFocus(); }
  function applyFocus() {
    syncRows();
    const f = focusId();
    const svg = $("#chart");
    svg.classList.toggle("focusing", !!f && !S.hidden.has(f));
    svg.querySelectorAll(".acc").forEach((g) => g.classList.toggle("on", g.dataset.id === f));
    // 強調した線を最前面へ
    const on = svg.querySelector(`.acc.on[data-layer="w"]`);
    if (on) on.parentNode.append(on);
  }

  // ログイン（小さなポップオーバー。めったに使わない操作なので場所を取らない）
  const pop = $("#pop");
  function openLogin(a, btn) {
    const r = btn.getBoundingClientRect();
    const copy = el("button", { class: "btn sm", type: "button" }, "コピー");
    copy.addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(a.launch_command).catch(() => {}); copy.textContent = "コピー済み"; });
    const state = el("div", { class: "state" }, el("span", { class: "spin", html: ICON.refresh }), "PC にログイン画面を開きました。完了を待っています…");
    const close = el("button", { class: "btn sm", type: "button" }, "閉じる");
    close.addEventListener("click", () => { pop.hidden = true; });
    pop.replaceChildren(
      el("h4", null, `${a.label} にログイン`),
      state,
      el("p", { style: "margin-top:10px" }, "手動でするなら、起動してから /login:"),
      el("div", { class: "cmd" }, el("code", null, a.launch_command), copy, "→", el("code", null, "/login")),
      el("div", { class: "row2" }, el("span", { class: "spacer" }), close),
    );
    pop.hidden = false;
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - pr.width - 8, r.right - pr.width)) + "px";
    pop.style.top = (r.bottom + 6 + pr.height > innerHeight ? r.top - pr.height - 6 : r.bottom + 6) + "px";
  }
  document.addEventListener("mousedown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".hint .btn")) pop.hidden = true; });

  // ------------------------------------------------------------------ 推移グラフ
  function valueAt(segs, t) {
    for (const s of segs) {
      const p = s.points;
      if (!p.length || t < p[0][0] || t > p[p.length - 1][0] + 60) continue;
      let lo = 0, hi = p.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (p[m][0] <= t) lo = m; else hi = m - 1; }
      return p[lo][1];
    }
    return null;
  }
  function mergeErrors(h, a) {
    const ts = h.errors.filter((e) => e.account_id === a.id).map((e) => e.t).sort((p, q) => p - q);
    const step = a.interval_minutes * 60 * 3;
    const out = [];
    for (const t of ts) {
      const last = out[out.length - 1];
      if (last && t - last[1] <= step) last[1] = t;
      else out.push([t, t]);
    }
    // ログイン切れが続いて今に至るなら、今まで伸ばす
    if (a.status !== "ok" && out.length && NOW - out[out.length - 1][1] <= step) out[out.length - 1][1] = NOW;
    return out;
  }

  const chartWrap = $("#chartwrap");
  const svgEl = $("#chart");
  let geo = null;

  function ticksFor(range, t0, t1) {
    const out = [];
    const d = D8(t0);
    if (range === "24h") {
      d.setMinutes(0, 0, 0);
      d.setHours(Math.ceil(d.getHours() / 3) * 3);
      for (let t = d / 1000; t <= t1; t += 3 * HOUR) {
        const dd = D8(t);
        out.push({ t, label: dd.getHours() === 0 ? `${dd.getMonth() + 1}/${dd.getDate()}` : `${dd.getHours()}:00`, major: dd.getHours() === 0 });
      }
    } else {
      d.setHours(24, 0, 0, 0);
      const every = range === "30d" ? 1 : 1;
      for (let t = d / 1000; t <= t1; t += DAY * every) {
        const dd = D8(t);
        if (range === "30d") {
          const lab = dd.getDay() === 1;
          out.push({ t, label: lab ? `${dd.getMonth() + 1}/${dd.getDate()}` : "", major: lab });
        } else out.push({ t, label: `${dd.getMonth() + 1}/${dd.getDate()} ${WD[dd.getDay()]}`, major: true });
      }
    }
    return out;
  }

  function renderChart() {
    const W = chartWrap.clientWidth, H = chartWrap.clientHeight;
    if (!W || !H) return;
    const mobile = W < 600;
    const h = HIST[S.range];
    const vis = ACC.filter((a) => !S.hidden.has(a.id));
    // x の範囲: 記録の最初の点から今まで（記録が短いうちも空白を作らない）
    let first = NOW;
    for (const a of ACC) for (const sg of series(h, a.id, "weekly_all")) if (sg.points.length) first = Math.min(first, sg.points[0][0]);
    const t0 = Math.max(h.since, first), t1 = NOW;

    const padL = mobile ? 34 : 76, padR = mobile ? 76 : 118, padT = 12;
    const axisH = 22;
    const laneH = mobile ? 14 : 16, laneGap = 4;
    const lanesH = S.lanes && vis.length ? 18 + vis.length * (laneH + laneGap) : 0;
    const plotT = padT, plotB = H - axisH - lanesH - (lanesH ? 4 : 0);
    const plotH = plotB - plotT;
    const x0 = padL, x1 = W - padR;
    const X = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
    const Y = (v) => plotB - (v / 100) * plotH;
    const laneTop = (i) => plotB + 18 + i * (laneH + laneGap);
    const bottom = lanesH ? laneTop(vis.length) - laneGap : plotB;

    svgEl.replaceChildren();
    svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const defs = sv("defs");
    defs.innerHTML =
      `<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch)" stroke-width="1.5"/></pattern>` +
      `<pattern id="hatchCrit" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="5" height="5" fill="var(--crit-wash)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--crit)" stroke-opacity=".55" stroke-width="1.3"/></pattern>` +
      `<clipPath id="plotClip"><rect x="${x0}" y="0" width="${x1 - x0 + 5}" height="${H}"/></clipPath>`;
    svgEl.append(defs);
    const gBack = sv("g"), gData = sv("g", { "clip-path": "url(#plotClip)" }), gFront = sv("g");
    svgEl.append(gBack, gData, gFront);

    // 危険域（90〜100%）を薄く
    gBack.append(sv("rect", { x: x0, y: Y(100), width: x1 - x0, height: Y(UI.danger_percent) - Y(100), fill: "var(--crit-wash)" }));
    // y グリッド
    for (const v of [0, 25, 50, 75, 100]) {
      gBack.append(sv("line", { x1: x0, x2: x1, y1: Y(v) + 0.5, y2: Y(v) + 0.5, stroke: v === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      const tx = sv("text", { x: x0 - 8, y: Y(v) + 3.5, "text-anchor": "end", class: "ax" });
      tx.textContent = v + (v === 100 ? "%" : "");
      gBack.append(tx);
    }
    // x の目盛り
    const tks = ticksFor(S.range, t0, t1);
    // 目盛りの文字が重ならないように間引く（スマホ幅など）
    const lab = tks.filter((t) => t.label);
    const spanPx = lab.length > 1 ? (X(lab[1].t) - X(lab[0].t)) : 999;
    const need = (lab[0] ? lab[0].label.length : 4) * 6.4 + 8;
    if (spanPx < need) {
      for (const t of lab) if (/ /.test(t.label)) t.label = t.label.split(" ")[0];
      const need2 = 40, every = Math.ceil(need2 / spanPx);
      lab.forEach((t, i) => { if (i % every) t.label = ""; });
    }
    for (const tk of tks) {
      const xx = Math.round(X(tk.t)) + 0.5;
      if (xx < x0 || xx > x1) continue;
      gBack.append(sv("line", { x1: xx, x2: xx, y1: plotT, y2: bottom, stroke: "var(--grid)", "stroke-width": 1, "stroke-opacity": tk.major ? 1 : 0.55 }));
      if (tk.label) {
        const tx = sv("text", { x: xx + 4, y: bottom + 15, class: "ax" + (tk.major && S.range !== "30d" ? "" : "") });
        tx.textContent = tk.label;
        gBack.append(tx);
      }
    }
    // 取得の抜け（全アカウント共通の抜けは全体に、個別は各レーンに）
    const gaps = h.gaps.filter((g) => !S.hidden.has(g.account_id));
    const common = [];
    for (const g of gaps) {
      const c = common.find((c) => g.from < c.to && g.to > c.from);
      if (c) { c.from = Math.max(c.from, g.from); c.to = Math.min(c.to, g.to); c.n++; } else common.push({ from: g.from, to: g.to, n: 1 });
    }
    for (const c of common) {
      if (c.n < vis.length || c.to < t0) continue;
      gData.append(sv("rect", { x: X(Math.max(c.from, t0)), y: plotT, width: Math.max(1, X(c.to) - X(Math.max(c.from, t0))), height: plotH, fill: "url(#hatch)" }));
    }
    // 今
    gBack.append(sv("line", { x1: x1 + 0.5, x2: x1 + 0.5, y1: plotT, y2: bottom, stroke: "var(--axis)", "stroke-width": 1 }));

    // 週間の線
    const markers = S.range === "24h" ? "all" : S.range === "7d" ? "change" : "none";
    const ends = [];
    const gW = sv("g");
    gData.append(gW);
    for (const a of vis) {
      const g = sv("g", { class: "acc", "data-id": a.id, "data-layer": "w" });
      // 週間リセット: 上端に小さな印と、ごく薄い縦線
      for (const r of h.resets.filter((r) => r.account_id === a.id && r.kind === "weekly_all" && r.t >= t0)) {
        const xx = Math.round(X(r.t)) + 0.5;
        g.append(sv("line", { x1: xx, x2: xx, y1: plotT, y2: plotB, stroke: a.cv, "stroke-width": 1, "stroke-opacity": S.range === "30d" ? 0.18 : 0.35 }));
        g.append(sv("path", { d: `M${xx - 4},${plotT - 1}h8l-4,5z`, fill: a.cv }));
      }
      let last = null;
      for (const seg of series(h, a.id, "weekly_all")) {
        const pts = seg.points.filter(([t]) => t >= t0);
        if (!pts.length) continue;
        g.append(sv("path", {
          class: "ln", d: "M" + pts.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("L"),
          fill: "none", stroke: a.cv, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
        }));
        if (markers !== "none") {
          let pv = null, lastX = -99;
          for (const [t, v] of pts) {
            const xx = X(t);
            if ((markers === "all" && xx - lastX >= 3) || (markers === "change" && v !== pv)) {
              g.append(sv("circle", { cx: xx.toFixed(1), cy: Y(v).toFixed(1), r: markers === "all" ? 2.2 : 1.7, fill: a.cv, stroke: markers === "all" ? "var(--panel)" : "none", "stroke-width": 1 }));
              lastX = xx;
            }
            pv = v;
          }
        }
        last = pts[pts.length - 1];
      }
      if (last) {
        g.append(sv("circle", { cx: X(last[0]), cy: Y(last[1]), r: 4.5, fill: a.cv, stroke: "var(--panel)", "stroke-width": 2 }));
        ends.push({ a, x: X(last[0]), y: Y(last[1]), v: last[1], t: last[0] });
      }
      gW.append(g);
    }
    // 線の終端ラベル（右の余白に。重なれば押し広げて、引き出し線でつなぐ）
    const LH = 15;
    ends.sort((p, q) => p.y - q.y);
    for (const e of ends) e.ly = e.y;
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (let i = 1; i < ends.length; i++) {
        const d = ends[i].ly - ends[i - 1].ly;
        if (d < LH) { const s = (LH - d) / 2; ends[i].ly += s; ends[i - 1].ly -= s; moved = true; }
      }
      for (const e of ends) e.ly = clamp(e.ly, plotT + 4, plotB - 2);
      if (!moved) break;
    }
    for (const e of ends) {
      const g = sv("g", { class: "acc", "data-id": e.a.id });
      const old = e.a.status !== "ok" || e.t < NOW - 3 * e.a.interval_minutes * 60;
      const lx = x1 + 10;
      if (old) g.append(sv("path", { d: `M${e.x + 6},${e.y}h6`, fill: "none", stroke: e.a.cv, "stroke-width": 1, "stroke-opacity": 0.7 }));
      if (Math.abs(e.ly - e.y) > 2 || e.x < x1 - 2) g.append(sv("path", { d: `M${x1 + 5},${e.y}L${lx - 3},${e.ly}`, fill: "none", stroke: e.a.cv, "stroke-width": 1, "stroke-opacity": 0.8 }));
      const tx = sv("text", { x: lx, y: e.ly + 4, class: "lbl" + (old ? " old" : "") });
      const v = sv("tspan", { class: "v" }); v.textContent = `${Math.round(e.v)}%`;
      const n = sv("tspan", { dx: 5 }); n.textContent = mobile ? e.a.label.slice(0, 3) : e.a.label + (old ? " ・前回" : "");
      tx.append(v, n);
      g.append(tx);
      gFront.append(g);
    }

    // 5h のレーン（アカウントごとの小さな面。x 軸は上と共有）
    if (lanesH) {
      const cap = sv("text", { x: mobile ? 6 : 10, y: plotB + 13, class: "ax strong" });
      cap.textContent = "5時間枠";
      gBack.append(cap);
      vis.forEach((a, i) => {
        const top = laneTop(i), ly = (v) => top + laneH - (v / 100) * laneH;
        const g = sv("g", { class: "acc", "data-id": a.id });
        g.append(sv("rect", { x: x0, y: top, width: x1 - x0, height: laneH, fill: "var(--grid)", "fill-opacity": 0.55, rx: 2 }));
        for (const gp of h.gaps.filter((g) => g.account_id === a.id && g.to > t0))
          g.append(sv("rect", { x: X(Math.max(gp.from, t0)), y: top, width: Math.max(1, X(gp.to) - X(Math.max(gp.from, t0))), height: laneH, fill: "url(#hatch)" }));
        for (const seg of series(h, a.id, "session")) {
          const pts = seg.points.filter(([t]) => t >= t0);
          if (pts.length < 2) continue;
          const line = pts.map(([t, v]) => `${X(t).toFixed(1)},${ly(v).toFixed(1)}`).join("L");
          g.append(sv("path", { d: `M${line}L${X(pts[pts.length - 1][0]).toFixed(1)},${top + laneH}L${X(pts[0][0]).toFixed(1)},${top + laneH}Z`, fill: a.cv, "fill-opacity": 0.32 }));
          g.append(sv("path", { d: "M" + line, fill: "none", stroke: a.cv, "stroke-width": 1.2, "stroke-linejoin": "round" }));
        }
        for (const [f, t] of mergeErrors(h, a)) {
          if (t < t0) continue;
          const xa = X(Math.max(f, t0)), xb = X(t);
          g.append(sv("rect", { x: xa - 1, y: top, width: Math.max(2, xb - xa + 2), height: laneH, fill: "url(#hatchCrit)" }));
        }
        // 名前（左）と今の 5h（右）はクリップの外に置く
        const gl = sv("g", { class: "acc", "data-id": a.id });
        gFront.append(gl);
        gl.append(sv("line", { x1: mobile ? 6 : 10, x2: mobile ? 22 : 18, y1: top + laneH / 2, y2: top + laneH / 2, stroke: a.cv, "stroke-width": 2, "stroke-linecap": "round" }));
        if (!mobile) {
          const nm = sv("text", { x: 24, y: top + laneH / 2 + 3.5, class: "lane-n" });
          nm.textContent = a.label.length > 4 ? a.label.slice(0, 4) + "…" : a.label;
          gl.append(nm);
        }
        const l5 = a.status === "ok" ? lim(a.limits, "session") : null;
        const tv = sv("text", { x: x1 + 10, y: top + laneH / 2 + 3.5, class: "lane-v" });
        tv.textContent = l5 ? `${Math.round(l5.percent)}%` : a.status === "logged_out" ? "ログイン切れ" : "—";
        if (!l5) tv.setAttribute("style", "fill:var(--muted);font-weight:500");
        gl.append(tv);
        gData.append(g);
      });
    }

    // クロスヘア
    const gx = sv("g", { visibility: "hidden" });
    const cl = sv("line", { y1: plotT, y2: bottom, stroke: "var(--ink)", "stroke-width": 1, "stroke-opacity": 0.55 });
    gx.append(cl);
    const dots = vis.map((a) => { const c = sv("circle", { r: 4, fill: a.cv, stroke: "var(--panel)", "stroke-width": 2 }); gx.append(c); return c; });
    gFront.append(gx);
    const hit = sv("rect", { x: x0, y: plotT, width: x1 - x0, height: bottom - plotT, fill: "transparent" });
    gFront.append(hit);
    geo = { X, Y, t0, t1, x0, x1, vis, h, laneTop, laneH };

    hit.addEventListener("mousemove", (e) => {
      const r = svgEl.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const t = t0 + ((px - x0) / (x1 - x0)) * (t1 - t0);
      gx.setAttribute("visibility", "visible");
      cl.setAttribute("x1", px); cl.setAttribute("x2", px);
      const rows = vis.map((a, i) => {
        const w = valueAt(series(h, a.id, "weekly_all"), t);
        const s5 = valueAt(series(h, a.id, "session"), t);
        if (w == null) dots[i].setAttribute("visibility", "hidden");
        else { dots[i].setAttribute("visibility", "visible"); dots[i].setAttribute("cx", px); dots[i].setAttribute("cy", Y(w)); }
        return { a, w, s5 };
      });
      // ポインタに一番近い線（またはレーン）のアカウントを強調する
      let near = null, best = 12;
      if (py <= plotB) for (const r2 of rows) { if (r2.w != null && Math.abs(Y(r2.w) - py) < best) { best = Math.abs(Y(r2.w) - py); near = r2.a.id; } }
      else vis.forEach((a, i) => { const tp = laneTop(i); if (py >= tp - 2 && py <= tp + laneH + 2) near = a.id; });
      if (near !== S.hover) { S.hover = near; applyFocus(); }
      showTip(e.clientX, e.clientY, (tp) => {
        tp.append(el("h4", null, `${fmtDay(t)} ${fmtHM(t)}`));
        for (const r2 of rows) {
          const err = r2.w == null && h.errors.some((x) => x.account_id === r2.a.id && Math.abs(x.t - t) < r2.a.interval_minutes * 60);
          tp.append(el("div", { class: "tr" + (r2.a.id === near ? " on" : "") },
            el("span", { class: "k", style: `background:${r2.a.cv}` }),
            el("b", null, r2.w == null ? "—" : `${r2.w}%`),
            el("span", { class: "n" }, r2.a.label),
            el("span", { class: "s" }, r2.w == null ? (err ? "取得エラー" : "記録なし") : `5h ${r2.s5 == null ? "—" : r2.s5 + "%"}`)));
        }
      });
    });
    hit.addEventListener("mouseleave", () => { gx.setAttribute("visibility", "hidden"); hideTip(); S.hover = null; applyFocus(); });

    applyFocus();
  }

  function renderKeys() {
    const k = $("#keys");
    k.innerHTML =
      `<span><svg width="16" height="8"><line x1="1" y1="4" x2="15" y2="4" stroke="var(--ink-2)" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="4" r="2.4" fill="var(--ink-2)" stroke="var(--panel)" stroke-width="1.2"/></svg>週間（点＝値が変わった観測）</span>` +
      `<span><svg width="14" height="10"><rect x="0" y="2" width="14" height="8" rx="1.5" fill="var(--ink-2)" fill-opacity=".3"/></svg>5h</span>` +
      `<span class="opt"><svg width="10" height="10"><path d="M1 1h8L5 6z" fill="var(--ink-2)"/></svg>週間リセット</span>` +
      `<span class="opt"><svg width="14" height="10"><rect width="14" height="10" rx="1.5" fill="url(#kh)"/><defs><pattern id="kh" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--hatch)" stroke-width="1.5"/></pattern></defs></svg>取得の抜け</span>` +
      `<span><svg width="14" height="10"><rect width="14" height="10" rx="1.5" fill="url(#kc)"/><defs><pattern id="kc" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="5" height="5" fill="var(--crit-wash)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--crit)" stroke-opacity=".55" stroke-width="1.3"/></pattern></defs></svg>エラー・ログイン切れ</span>`;
  }

  // 期間・レーンの切り替え
  $("#rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.range = b.dataset.r;
    for (const x of $("#rangeSeg").children) x.setAttribute("aria-pressed", String(x === b));
    renderChart();
  });
  $("#laneSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.lanes = b.dataset.l === "1";
    for (const x of $("#laneSeg").children) x.setAttribute("aria-pressed", String(x === b));
    $("#chartDesc").textContent = S.lanes ? "週間枠の使用率 ・ 下段は 5時間枠" : "週間枠の使用率";
    renderChart();
  });

  // ------------------------------------------------------------------ 起動
  renderTop();
  renderKeys();
  renderRows();
  renderChart();
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderChart(); drawSparks(); }); }).observe(chartWrap);
  addEventListener("resize", () => drawSparks());

  // 撮影・確認用のフック
  window.__proto = {
    hoverRow: (i) => { const r = rowsEl.children[i]; S.hover = r.dataset.id; applyFocus(); return r.dataset.id; },
    pointChart: (fx, fy) => {
      const r = svgEl.getBoundingClientRect();
      const hit = svgEl.querySelector("rect[fill='transparent']");
      const x = r.left + geo.x0 + fx * (geo.x1 - geo.x0), y = r.top + fy * r.height;
      hit.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
      return [x, y];
    },
    hoverEl: (sel, fx = 0.5) => {
      const e = document.querySelector(sel); const r = e.getBoundingClientRect();
      e.dispatchEvent(new MouseEvent("mousemove", { clientX: r.left + r.width * fx, clientY: r.top + r.height / 2, bubbles: true }));
    },
    toggle: toggleHidden,
    range: (r) => $(`#rangeSeg [data-r="${r}"]`).click(),
  };
})();
