// ccsmoni プロトタイプ B「タイル（Small multiples）」
// demo-data.js（window.CCSMONI_DEMO）だけで動く。API には繋がない。
// URL: ?n=6（6アカウントに増やす） ?theme=dark|light  ?range=24h|7d|30d  ?view=tiles|overlay
(() => {
  "use strict";
  const Q = new URLSearchParams(location.search);
  const S = {
    range: ["24h", "7d", "30d"].includes(Q.get("range")) ? Q.get("range") : "7d",
    view: Q.get("view") === "overlay" ? "overlay" : "tiles",
    bigKind: "weekly_all",
    hidden: new Set(),
    focus: null,        // 重ねる表示で強調するアカウント
    filter: null,       // サマリーのチップにホバー中: 対象の id の Set
    hoverT: null, hoverSrc: null,
    busy: new Set(),
  };

  // ---- 識別色（categorical）。dataviz の validator でライト（面 #ffffff）・ダーク（面 #1b1b1a）を検証済み。
  // 並び順が CVD 対策そのもの（隣り合う順で ΔE≥8）。赤（8番目）は状態の「危険」と紛れるので、7件までは使わない。
  const PAL = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    dark:  ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  };
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const $ = (s, el = document) => el.querySelector(s);
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const colorOf = (acc) => PAL[isDark() ? "dark" : "light"][acc._slot % 8];

  // =========================================================================
  // データ: デモのスナップショット + ?n=6 の複製
  // =========================================================================
  const RAW = JSON.parse(JSON.stringify(window.CCSMONI_DEMO));
  const NOW = RAW.state.now;
  const VARIANTS = [
    { id: "acct-x", label: "副業", plan: "max", wk: ["acct-a", 1.2, 15], ss: ["acct-b", 1.7, 4], hint: "will" },
    { id: "acct-y", label: "実験", plan: "pro", wk: ["acct-c", 0.6, 4], ss: ["acct-a", 0.45, 0], busy: true },
    { id: "acct-z", label: "OSS", plan: "max", wk: ["acct-b", 0.85, 6], ss: ["acct-c", 1.3, 0] },
    { id: "acct-w", label: "予備", plan: "pro", wk: ["acct-a", 0.4, 2], ss: ["acct-b", 0.5, 0] },
  ];
  function buildData(raw, n) {
    const st = raw.state;
    if (n && n < st.accounts.length) st.accounts = st.accounts.slice(0, n);
    for (let i = 0; n && st.accounts.length < n && i < VARIANTS.length; i++) addVariant(raw, VARIANTS[i]);
    st.accounts.forEach((a, i) => { a._slot = i; });
    const ids = new Set(st.accounts.map((a) => a.id));
    for (const k of ["history_24h", "history_7d", "history_30d"]) {
      const h = raw[k];
      h.series = h.series.filter((s) => ids.has(s.account_id));
    }
    return raw;
  }
  function addVariant(raw, v) {
    const st = raw.state;
    const tf = (scale, add) => (p) => [p[0], p[1] === 0 ? 0 : Math.max(0, Math.min(100, Math.round(p[1] * scale + add)))];
    const src = st.accounts.find((a) => a.id === v.wk[0]);
    for (const k of ["history_24h", "history_7d", "history_30d"]) {
      const h = raw[k];
      for (const [kind, [sid, sc, ad]] of [["weekly_all", v.wk], ["session", v.ss]]) {
        const s = h.series.find((x) => x.account_id === sid && x.kind === kind);
        if (!s) continue;
        h.series.push({ account_id: v.id, kind, segments: s.segments.map((g) => ({ ...g, points: g.points.map(tf(sc, ad)) })) });
        h.resets.push(...h.resets.filter((r) => r.account_id === sid && r.kind === kind).map((r) => ({ ...r, account_id: v.id })));
      }
      h.gaps.push(...h.gaps.filter((g) => g.account_id === v.wk[0]).map((g) => ({ ...g, account_id: v.id })));
    }
    const lastOf = (kind) => {
      const s = raw.history_24h.series.find((x) => x.account_id === v.id && x.kind === kind);
      const g = s && s.segments[s.segments.length - 1];
      return g ? g.points[g.points.length - 1][1] : 0;
    };
    const ssSrc = st.accounts.find((a) => a.id === v.ss[0]);
    const lim = (a, kind) => a.limits.find((l) => l.kind === kind);
    const wk = JSON.parse(JSON.stringify(lim(src, "weekly_all")));
    const ss = JSON.parse(JSON.stringify(lim(ssSrc, "session") || lim(src, "session")));
    wk.percent = lastOf("weekly_all");
    ss.percent = lastOf("session");
    const acc = {
      ...JSON.parse(JSON.stringify(src)), id: v.id, label: v.label, plan: v.plan, launch_command: "claude-" + v.id,
      limits: [ss, wk], hints: [],
    };
    if (v.hint === "will") {
      const eta = new Date((NOW + 11 * 3600) * 1000);
      acc.hints.push({ kind: "will_hit_limit", text: `このペースだと ${DOW[eta.getDay()]} ${String(eta.getHours()).padStart(2, "0")}:${String(eta.getMinutes()).padStart(2, "0")} に週間上限` });
      acc.hints.push({ kind: "session_high", text: "5時間枠も 80% を超えています" });
    }
    if (v.busy) st.collector.busy.push(v.id);
    st.accounts.push(acc);
    for (const wkey of ["windows_weekly", "windows_session"]) {
      const kind = wkey === "windows_weekly" ? v.wk : v.ss;
      const row = raw[wkey].rows.find((r) => r.account_id === kind[0]);
      if (row) raw[wkey].rows.push({ account_id: v.id, windows: row.windows.map((w) => ({ ...w, peak_percent: Math.min(100, Math.round(w.peak_percent * kind[1] + kind[2])) })) });
    }
  }
  const DATA = buildData(RAW, parseInt(Q.get("n"), 10) || 0);
  const ST = DATA.state;
  const ACC = ST.accounts;
  const WARN = ST.ui.warn_percent, DANGER = ST.ui.danger_percent;
  ST.collector.busy.forEach((id) => S.busy.add(id));

  // 期間ごとの描画用モデル（メモ化）
  const MODELS = {};
  function model(range) {
    if (MODELS[range]) return MODELS[range];
    const h = DATA["history_" + range];
    const per = {};
    let first = Infinity;
    for (const a of ACC) {
      const iv = a.interval_minutes * 60;
      const seg = (kind) => (h.series.find((s) => s.account_id === a.id && s.kind === kind) || { segments: [] }).segments;
      const wk = seg("weekly_all"), ss = seg("session");
      const flat = (segs) => segs.flatMap((g) => g.points).sort((p, q) => p[0] - q[0]);
      const wkPts = flat(wk), ssPts = flat(ss);
      if (wkPts.length) first = Math.min(first, wkPts[0][0]);
      // エラー: 続いたものを帯にまとめる（UI 側の仕事）
      const errs = h.errors.filter((e) => e.account_id === a.id).sort((p, q) => p.t - q.t);
      const bands = [];
      for (const e of errs) {
        const last = bands[bands.length - 1];
        if (last && e.t - last.to <= iv * 3 && last.status === e.status) last.to = e.t + iv;
        else bands.push({ from: e.t, to: e.t + iv, status: e.status });
      }
      if (a.status !== "ok" && bands.length) bands[bands.length - 1].to = h.until;
      per[a.id] = {
        wk, ss, wkPts, ssPts, iv, bands,
        wkRes: h.resets.filter((r) => r.account_id === a.id && r.kind === "weekly_all").map((r) => r.t),
        ssRes: h.resets.filter((r) => r.account_id === a.id && r.kind === "session").map((r) => r.t),
        gaps: h.gaps.filter((g) => g.account_id === a.id),
      };
    }
    // x 軸は全タイルで共通。記録が範囲より短ければ、全アカウントで最も古い記録まで詰める（課題8）
    const x0 = Math.max(h.since, isFinite(first) ? first - (h.until - first) * 0.01 : h.since);
    return (MODELS[range] = { x0, x1: h.until, per });
  }

  // =========================================================================
  // 書式
  // =========================================================================
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtDT = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const fmtD = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}`; };
  function remain(sec) {
    if (sec <= 0) return "リセット済み";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `あと ${d}日${h}時間`;
    if (h > 0) return `あと ${h}時間${pad2(m)}分`;
    return `あと ${m}分`;
  }
  function ago(sec) {
    if (sec < 60) return "たった今";
    if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
    return `${Math.floor(sec / 86400)}日前`;
  }
  const sev = (p) => (p >= DANGER ? "crit" : p >= WARN ? "warn" : "");
  const ICON = {
    warn: '<svg class="i" viewBox="0 0 16 16"><path d="M8 2.2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/></svg>',
    crit: '<svg class="i" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
    err: '<svg class="i" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.6M8 10.8v.1"/></svg>',
    tip: '<svg class="i" viewBox="0 0 16 16"><path d="M6 12.5h4M6.5 14.5h3M8 1.8a4.2 4.2 0 0 0-2.4 7.7c.5.4.8.9.8 1.5h3.2c0-.6.3-1.1.8-1.5A4.2 4.2 0 0 0 8 1.8z"/></svg>',
    ok: '<svg class="i" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    spin: '<svg class="i" viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 1-6 6" /></svg>',
    refresh: '<svg class="i" viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>',
    clock: '<svg class="i" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.6"/></svg>',
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // =========================================================================
  // タイル（DOM）
  // =========================================================================
  const grid = $("#grid");
  const lim = (list, kind) => (list || []).find((l) => l.kind === kind);

  function stateBadge(a) {
    if (S.busy.has(a.id)) return `<span class="t-state busy">${ICON.spin}取得中</span>`;
    if (a.status === "logged_out") return `<span class="t-state crit">${ICON.crit}ログイン切れ</span>`;
    if (a.status !== "ok" && a.status !== "never") return `<span class="t-state crit">${ICON.err}取得エラー</span>`;
    if (a.stale) return `<span class="t-state warn">${ICON.clock}${ago(NOW - a.taken_at)}の値</span>`;
    return `<span class="t-state" title="最終取得 ${fmtDT(a.taken_at)}">${ago(NOW - a.taken_at)}</span>`;
  }

  function figHTML(a, kind) {
    const ok = a.status === "ok";
    const L = ok ? lim(a.limits, kind) : lim(a.last_ok && a.last_ok.limits, kind);
    const name = kind === "session" ? "5h" : "週間";
    if (!L) return `<div class="fig stale"><div class="fig-l"><span class="k">${name}</span><span>—</span></div><div class="fig-v"><span class="v">—</span></div><div class="meter"></div></div>`;
    const p = L.percent;
    let rs;
    if (!L.resets_at) rs = "未開始";
    else if (L.resets_at <= NOW) rs = ok ? "リセット済み" : "リセット済み（推定）";
    else rs = remain(L.resets_at - NOW);
    const sv = ok ? sev(p) : "";
    let extra = "";
    if (sv) extra = `<span class="sev ${sv}">${sv === "crit" ? ICON.crit + "上限間近" : ICON.warn + "注意"}</span>`;
    else if (ok && L.pace) {
      const d = Math.round(p - L.pace.expected_percent);
      extra = `<span class="pc ${d > 5 ? "over" : ""}" title="均等に使った場合の位置 ${Math.round(L.pace.expected_percent)}% に対して ${p}%">ペース <b>${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}</b></span>`;
    } else if (!ok) extra = `<span class="pc">${ago(NOW - a.last_ok.taken_at)}の値</span>`;
    const sonnet = kind === "weekly_all" && ok ? lim(a.limits, "weekly_model:sonnet") : null;
    if (sonnet) extra += `<span class="pc" title="Sonnet だけの週間枠">Sonnet <b>${sonnet.percent}%</b></span>`;
    const tick = ok && L.pace && L.resets_at > NOW ? `<b style="left:${Math.min(100, L.pace.expected_percent)}%"></b>` : "";
    return `<div class="fig ${ok ? "" : "stale"}">
      <div class="fig-l"><span class="k">${name}</span><span class="rs num">${rs}</span></div>
      <div class="fig-v"><span class="v">${Math.round(p)}<small>%</small></span>${extra}</div>
      <div class="meter"><i class="${sv}" style="width:${Math.max(p > 0 ? 1.5 : 0, Math.min(100, p))}%"></i>${tick}</div>
    </div>`;
  }

  function peaksHTML(a) {
    const row = DATA.windows_weekly.rows.find((r) => r.account_id === a.id);
    const ws = row ? row.windows.slice(0, 6).reverse() : [];
    const W = 92, H = 28, n = 6, cw = 10, gap = (W - n * cw) / (n - 1);
    let s = "";
    for (let i = 0; i < n; i++) {
      const w = ws[i - (n - ws.length)];
      const x = i * (cw + gap);
      s += `<rect class="trk" x="${x}" y="0" width="${cw}" height="${H}" rx="2"/>`;
      if (!w) continue;
      const cur = w.resets_at > NOW;
      const h = Math.max(1.5, (w.peak_percent / 100) * H);
      s += `<rect class="pk ${cur ? "cur" : sev(w.peak_percent)}" x="${x + (cur ? 0.6 : 0)}" y="${H - h + (cur ? 0.6 : 0)}" width="${cw - (cur ? 1.2 : 0)}" height="${h - (cur ? 1.2 : 0)}" rx="2"/>`;
      s += `<rect class="hit" x="${x - gap / 2}" y="-4" width="${cw + gap}" height="${H + 8}" data-pk="${w.first_seen},${w.resets_at},${w.peak_percent},${cur ? 1 : 0}"/>`;
    }
    const prev = ws.filter((w) => w.resets_at <= NOW).pop();
    return `<div class="peaks"><div class="lbl"><span>週ピーク</span>${prev ? `<span>前週 <b>${prev.peak_percent}%</b></span>` : ""}</div><svg viewBox="0 0 ${W} ${H}">${s}</svg></div>`;
  }

  function hintHTML(a) {
    if (a.status === "logged_out") return `<footer class="t-hint crit login">${ICON.crit}<span><b>ログイン切れ</b> · ${ago(NOW - a.last_ok.taken_at)}から</span>
      <span class="man" title="手動でするなら、起動してから /login">手動 <code>${esc(a.launch_command || "claude")}</code> → <code>/login</code></span>
      <button class="btn sm" data-login="${esc(a.id)}">ログイン</button></footer>`;
    if (a.status !== "ok") return `<footer class="t-hint crit">${ICON.err}<span>${esc(a.message || "取得に失敗しました")}</span></footer>`;
    const h = a.hints || [];
    if (!h.length) {
      const nx = a.next_run_at ? `次の取得 ${Math.max(1, Math.round((a.next_run_at - NOW) / 60))}分後` : "";
      return `<footer class="t-hint none">${ICON.ok}<span>ペースどおり${nx ? " · " + nx : ""}</span></footer>`;
    }
    const k = h[0].kind === "use_it_or_lose_it" ? "tip" : "warn";
    const more = h.length > 1 ? `<span class="more" title="${esc(h.slice(1).map((x) => x.text).join("\n"))}">ほか ${h.length - 1} 件</span>` : "";
    return `<footer class="t-hint ${k}" title="${esc(h.map((x) => x.text).join("\n"))}">${k === "tip" ? ICON.tip : ICON.warn}<span>${esc(h[0].text)}</span>${more}</footer>`;
  }

  function loginCard(a) {
    if (a.status !== "logged_out") return "";
    return `<div class="login-card">
      <div class="h">${ICON.crit}ログインが必要です</div>
      <p>${ago(NOW - a.last_ok.taken_at)}から取得できていません</p>
      <div class="row"><button class="btn" data-login="${esc(a.id)}">ログイン</button>
      <span class="man" title="手動でするなら、起動してから /login">手動: <code>${esc(a.launch_command || "claude")}</code> → <code>/login</code></span></div>
    </div>`;
  }

  function renderTiles() {
    const n = ACC.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    const app = $("#app");
    app.style.setProperty("--n", n);
    grid.style.setProperty("--cols", cols);
    grid.style.setProperty("--rows", rows);
    let html = "";
    for (const a of ACC) {
      html += `<article class="tile" data-id="${esc(a.id)}" style="--c:${colorOf(a)}" tabindex="-1">
        <header class="t-head"><span class="sw"></span><h3>${esc(a.label)}</h3>${a.plan ? `<span class="plan">${esc(a.plan.toUpperCase())}</span>` : ""}
          ${stateBadge(a)}<button class="t-refresh" data-refresh="${esc(a.id)}" title="このアカウントを今すぐ更新" aria-label="${esc(a.label)} を今すぐ更新">${ICON.refresh}</button></header>
        <div class="t-figs">${figHTML(a, "weekly_all")}${figHTML(a, "session")}${peaksHTML(a)}</div>
        <div class="t-chart"><canvas class="base"></canvas><canvas class="ovl" tabindex="0" aria-label="${esc(a.label)} の推移"></canvas></div>
        ${hintHTML(a)}
      </article>`;
    }
    // 空いたマスは比較パネルで埋める（グリッドがガタつかない）
    if (n * 1 < cols * rows) {
      html += `<article class="tile cmp" data-cmp="1" style="grid-column: span ${cols * rows - n}">
        <header class="t-head"><span class="sw" style="background:var(--ink-3)"></span><h3>比較（週間・重ね合わせ）</h3><span class="t-state">「重ねる」で拡大</span></header>
        <div class="t-chart"><canvas class="base"></canvas><canvas class="ovl" tabindex="0"></canvas></div></article>`;
    }
    grid.innerHTML = html;
    applyTileClasses();
  }
  function applyTileClasses() {
    for (const el of grid.querySelectorAll(".tile[data-id]")) {
      const id = el.dataset.id;
      el.classList.toggle("dim", !!S.filter && !S.filter.has(id));
      el.classList.toggle("off", S.hidden.has(id));
      el.style.setProperty("--c", colorOf(ACC.find((a) => a.id === id)));
    }
  }

  // ---- ヘッダーのサマリー ----
  function renderSummary() {
    const groups = [
      { k: "crit", icon: ICON.crit, label: "ログイン切れ・エラー", ids: ACC.filter((a) => a.status !== "ok" && a.status !== "never").map((a) => a.id) },
      { k: "warn", icon: ICON.warn, label: "上限に届く見込み", ids: ACC.filter((a) => a.status === "ok" && (a.limits.some((l) => l.percent >= WARN) || a.hints.some((h) => h.kind === "will_hit_limit"))).map((a) => a.id) },
      { k: "tip", icon: ICON.tip, label: "使い残しそう", ids: ACC.filter((a) => a.hints.some((h) => h.kind === "use_it_or_lose_it")).map((a) => a.id) },
    ];
    const okN = ACC.length - new Set(groups.slice(0, 2).flatMap((g) => g.ids)).size;
    let h = `<span class="chip ok">${ICON.ok}問題なし <b>${okN}/${ACC.length}</b></span>`;
    for (const g of groups) if (g.ids.length) h += `<span class="chip ${g.k}" data-filter="${g.ids.join(",")}" title="${esc(g.ids.map((id) => ACC.find((a) => a.id === id).label).join("・"))}">${g.icon}${g.label} <b>${g.ids.length}</b></span>`;
    $("#summary").innerHTML = h;
    const c = ST.collector;
    $("#fresh").innerHTML = `<span>最終更新 <b>${ago(NOW - c.last_run_at)}</b></span><span>次回 <b>${c.next_run_at ? Math.max(1, Math.round((c.next_run_at - NOW) / 60)) + "分後" : "—"}</b></span>`;
    const cand = ST.candidates || [];
    $("#cand").innerHTML = cand.length ? `${ICON.tip}新しいアカウント候補 <code>${esc(cand[0].suggested_id)}</code>${cand.length > 1 ? ` ほか${cand.length - 1}` : ""} · <a href="#">設定で追加</a>` : "";
  }

  // =========================================================================
  // グラフ（canvas）
  // =========================================================================
  function setupCanvas(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function frame(w, h, kind) {
    const P = kind === "big" ? { l: 40, r: 150, t: 14, b: 24 } : kind === "cmp" ? { l: 34, r: 12, t: 8, b: 20 } : { l: 36, r: 40, t: 12, b: 20 };
    return { l: P.l, r: w - P.r, t: P.t, b: h - P.b, w: w - P.l - P.r, h: h - P.t - P.b };
  }
  const mkX = (F, M) => (t) => F.l + ((t - M.x0) / (M.x1 - M.x0)) * F.w;
  const mkY = (F) => (v) => F.b - (v / 100) * F.h;

  function xticks(M, F) {
    const span = M.x1 - M.x0;
    const steps = [3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
    const step = steps.find((s) => (s / span) * F.w >= 62) || 604800;
    const o = -new Date(M.x1 * 1000).getTimezoneOffset() * 60;
    const out = [];
    for (let t = Math.ceil((M.x0 + o) / step) * step - o; t <= M.x1; t += step) {
      const day = (t + o) % 86400 === 0;
      const d = new Date(t * 1000);
      out.push({ t, day, label: day || step >= 86400 ? fmtD(t) : `${d.getHours()}:00` });
    }
    return out;
  }
  function drawAxes(ctx, F, M, opt = {}) {
    const X = mkX(F, M), Y = mkY(F);
    const grid = cssv("--grid"), axis = cssv("--axis"), ink3 = cssv("--ink-3");
    ctx.lineWidth = 1;
    ctx.font = `10.5px ${cssv("--font")}`;
    // 横の目盛り: 0 / 50 / 100（全タイル同じ）。25/75 はさらに薄く
    for (const v of [25, 50, 75, 100]) {
      ctx.strokeStyle = grid; ctx.globalAlpha = v % 50 ? 0.55 : 1;
      ctx.beginPath(); ctx.moveTo(F.l, Math.round(Y(v)) + 0.5); ctx.lineTo(F.r, Math.round(Y(v)) + 0.5); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = ink3; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const v of opt.yLabels || [0, 50, 100]) ctx.fillText(v + "%", F.l - 6, Y(v));
    // 縦の目盛り
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const tk of xticks(M, F)) {
      const x = Math.round(X(tk.t)) + 0.5;
      ctx.strokeStyle = grid; ctx.globalAlpha = tk.day ? 1 : 0.6;
      ctx.beginPath(); ctx.moveTo(x, F.t); ctx.lineTo(x, F.b); ctx.stroke();
      ctx.globalAlpha = 1;
      if (x > F.l + 14 && x < F.r - 10) ctx.fillText(tk.label, x, F.b + 5);
    }
    ctx.strokeStyle = axis;
    ctx.beginPath(); ctx.moveTo(F.l, Math.round(F.b) + 0.5); ctx.lineTo(F.r, Math.round(F.b) + 0.5); ctx.stroke();
  }
  function hatch(ctx, x0, x1, F) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, F.t, x1 - x0, F.h); ctx.clip();
    ctx.strokeStyle = cssv("--hatch"); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0 - F.h; x < x1; x += 5) { ctx.moveTo(x, F.b); ctx.lineTo(x + F.h, F.t); }
    ctx.stroke();
    ctx.restore();
  }
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // 点（マーカー）: 値が変わった取得に打つ。密すぎるときは 6px 以内の点を間引く。
  // 点の間隔がもともと十分なら（期間が短い・記録が少ない）すべての取得に打つ。
  function markerPoints(segs, X) {
    const out = [];
    for (const g of segs) {
      const pts = g.points;
      if (!pts.length) continue;
      const spacing = pts.length > 1 ? (X(pts[pts.length - 1][0]) - X(pts[0][0])) / (pts.length - 1) : 99;
      let lastX = -99;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const chg = i === 0 || i === pts.length - 1 || p[1] !== pts[i - 1][1];
        if (!(spacing >= 6 || chg)) continue;
        const x = X(p[0]);
        if (x - lastX < 6 && i !== pts.length - 1) continue;
        out.push(p); lastX = x;
      }
    }
    return out;
  }
  function pathLine(ctx, segs, X, Y) {
    ctx.beginPath();
    for (const g of segs) g.points.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
  }
  function dot(ctx, x, y, r, fill, ring, ringW = 2) {
    ctx.beginPath(); ctx.arc(x, y, r + ringW, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
  }
  function lastPt(segs) {
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].points.length) return segs[i].points[segs[i].points.length - 1];
    return null;
  }

  function drawTile(el) {
    const a = ACC.find((x) => x.id === el.dataset.id);
    const cv = $("canvas.base", el);
    const { ctx, w, h } = setupCanvas(cv);
    const M = model(S.range), D = M.per[a.id];
    const F = frame(w, h, "tile");
    const X = mkX(F, M), Y = mkY(F);
    const col = colorOf(a), surf = cssv("--surface");
    // 背景: 取得の抜け（斜線）・エラー帯（薄い面＋下端の帯）
    for (const g of D.gaps) hatch(ctx, Math.max(F.l, X(g.from)), Math.min(F.r, X(g.to)), F);
    for (const b of D.bands) {
      const x0 = Math.max(F.l, X(b.from)), x1 = Math.min(F.r, X(b.to));
      if (x1 <= F.l) continue;
      ctx.fillStyle = cssv("--st-crit-soft"); ctx.fillRect(x0, F.t, x1 - x0, F.h);
    }
    drawAxes(ctx, F, M);
    // リセット: 週間＝全高のヘアライン、5h＝下端の短い目盛り
    ctx.lineWidth = 1;
    ctx.strokeStyle = cssv("--ink-3"); ctx.globalAlpha = 0.55;
    for (const t of D.wkRes) { const x = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, F.t - 4); ctx.lineTo(x, F.b); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cssv("--ink-4");
    for (const t of D.ssRes) { const x = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, F.b - 5); ctx.lineTo(x, F.b); ctx.stroke(); }
    // 5h: 面（薄い色）＋上辺の細い線
    const dk = isDark();
    for (const g of D.ss) {
      if (g.points.length < 1) continue;
      ctx.beginPath();
      ctx.moveTo(X(g.points[0][0]), F.b);
      for (const p of g.points) ctx.lineTo(X(p[0]), Y(p[1]));
      ctx.lineTo(X(g.points[g.points.length - 1][0]), F.b); ctx.closePath();
      ctx.fillStyle = rgba(col, dk ? 0.16 : 0.11); ctx.fill();
    }
    ctx.lineWidth = 1; ctx.strokeStyle = rgba(col, dk ? 0.42 : 0.38); ctx.lineJoin = "round";
    pathLine(ctx, D.ss, X, Y); ctx.stroke();
    // 週間: 2px の線＋点
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.lineCap = "round";
    pathLine(ctx, D.wk, X, Y); ctx.stroke();
    for (const p of markerPoints(D.wk, X)) dot(ctx, X(p[0]), Y(p[1]), 2.1, col, surf, 1.4);
    // エラーの帯（下端）
    for (const b of D.bands) {
      const x0 = Math.max(F.l, X(b.from)), x1 = Math.min(F.r, X(b.to));
      if (x1 <= F.l) continue;
      ctx.fillStyle = b.status === "logged_out" ? cssv("--st-crit") : cssv("--st-serious");
      ctx.fillRect(x0, F.b - 3, Math.max(2, x1 - x0), 3);
    }
    if (!D.wkPts.length && !D.ssPts.length) {
      ctx.font = `12px ${cssv("--font")}`; ctx.fillStyle = cssv("--ink-3"); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(D.bands.length ? "この期間は取得できていません" : "この期間の記録はありません", F.l + F.w / 2, F.t + F.h / 2);
      return;
    }
    // 終端（＝最後の取得）: 点と値のラベル
    const lw = lastPt(D.wk), ls = lastPt(D.ss);
    ctx.font = `600 11px ${cssv("--font")}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    let yw = lw ? Y(lw[1]) : null, ys = ls ? Y(ls[1]) : null;
    if (ls) dot(ctx, X(ls[0]), Y(ls[1]), 2.6, rgba(col, 1), surf, 1.6);
    if (lw) dot(ctx, X(lw[0]), Y(lw[1]), 4, col, surf, 2);
    if (yw != null && ys != null && Math.abs(yw - ys) < 13) { const m = (yw + ys) / 2; if (yw <= ys) { yw = m - 6.5; ys = m + 6.5; } else { yw = m + 6.5; ys = m - 6.5; } }
    if (lw && X(lw[0]) > F.r - 30) { ctx.fillStyle = cssv("--ink"); ctx.fillText(lw[1] + "%", X(lw[0]) + 8, clampY(yw, F)); }
    if (ls && X(ls[0]) > F.r - 30) { ctx.font = `500 10.5px ${cssv("--font")}`; ctx.fillStyle = cssv("--ink-3"); ctx.fillText(ls[1] + "%", X(ls[0]) + 8, clampY(ys, F)); }
  }
  const clampY = (y, F) => Math.max(F.t + 2, Math.min(F.b - 4, y));

  // 重ね合わせ（比較パネル／「重ねる」表示）
  function drawOverlay(cv, kind, big) {
    const { ctx, w, h } = setupCanvas(cv);
    const M = model(S.range);
    const F = frame(w, h, big ? "big" : "cmp");
    const X = mkX(F, M), Y = mkY(F);
    const surf = cssv("--surface");
    drawAxes(ctx, F, M, big ? { yLabels: [0, 25, 50, 75, 100] } : {});
    const vis = ACC.filter((a) => !S.hidden.has(a.id));
    const order = S.focus ? [...vis.filter((a) => a.id !== S.focus), vis.find((a) => a.id === S.focus)].filter(Boolean) : vis;
    const labels = [];
    for (const a of order) {
      const D = M.per[a.id];
      const segs = kind === "session" ? D.ss : D.wk;
      const col = colorOf(a);
      ctx.globalAlpha = S.focus && S.focus !== a.id ? 0.18 : 1;
      ctx.lineWidth = big ? 2 : 1.6; ctx.strokeStyle = col; ctx.lineJoin = "round"; ctx.lineCap = "round";
      pathLine(ctx, segs, X, Y); ctx.stroke();
      if (big && kind !== "session") for (const p of markerPoints(segs, X)) dot(ctx, X(p[0]), Y(p[1]), 2, col, surf, 1.3);
      const lp = lastPt(segs);
      if (lp) { dot(ctx, X(lp[0]), Y(lp[1]), big ? 4 : 3, col, surf, 2); labels.push({ a, x: X(lp[0]), y: Y(lp[1]), v: lp[1], col, ended: lp[0] < M.x1 - D.iv * 3 }); }
      ctx.globalAlpha = 1;
    }
    if (!big) return;
    // 終端の直接ラベル: 重なるときは縦にずらし、引き出し線でつなぐ
    labels.sort((p, q) => p.y - q.y);
    const gapY = 16;
    for (let i = 0; i < labels.length; i++) labels[i].ly = Math.max(labels[i].y, i ? labels[i - 1].ly + gapY : F.t);
    const over = labels.length ? labels[labels.length - 1].ly - (F.b - 4) : 0;
    if (over > 0) for (let i = labels.length - 1; i >= 0; i--) labels[i].ly = Math.min(labels[i].ly - over, i < labels.length - 1 ? labels[i + 1].ly - gapY : Infinity);
    const lx = F.r + 16;
    for (const L of labels) {
      ctx.globalAlpha = S.focus && S.focus !== L.a.id ? 0.35 : 1;
      ctx.strokeStyle = cssv("--line-strong"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.x + 6, L.y); ctx.lineTo(lx - 10, L.ly); ctx.lineTo(lx - 4, L.ly); ctx.stroke();
      ctx.strokeStyle = L.col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, L.ly); ctx.lineTo(lx + 10, L.ly); ctx.stroke();
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.font = `650 12px ${cssv("--font")}`; ctx.fillStyle = cssv("--ink");
      const vs = L.v + "%";
      ctx.fillText(vs, lx + 15, L.ly);
      const vw = ctx.measureText(vs).width;
      ctx.font = `12px ${cssv("--font")}`; ctx.fillStyle = cssv("--ink-2");
      ctx.fillText(L.a.label + (L.ended ? "（途切れ）" : ""), lx + 19 + vw, L.ly);
      ctx.globalAlpha = 1;
    }
  }

  function drawAll() {
    if (S.view === "tiles") {
      for (const el of grid.querySelectorAll(".tile[data-id]")) drawTile(el);
      const cmp = grid.querySelector(".tile.cmp canvas.base");
      if (cmp) drawOverlay(cmp, "weekly_all", false);
    } else {
      drawOverlay($("#big canvas.base"), S.bigKind, true);
    }
    drawCursors();
  }

  // =========================================================================
  // ホバー: 全タイルのカーソルを同期する
  // =========================================================================
  function nearest(pts, t) {
    if (!pts.length) return null;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] < t) lo = m; else hi = m; }
    return Math.abs(pts[lo][0] - t) <= Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
  }
  function valueAt(a, kind, t) {
    const D = model(S.range).per[a.id];
    const p = nearest(kind === "session" ? D.ssPts : D.wkPts, t);
    return p && Math.abs(p[0] - t) <= D.iv * 1.6 ? p : null;
  }
  function condAt(a, t) {
    const D = model(S.range).per[a.id];
    const b = D.bands.find((x) => t >= x.from && t <= x.to);
    if (b) return { k: "err", text: b.status === "logged_out" ? "ログイン切れ" : "取得エラー" };
    if (D.gaps.some((g) => t > g.from && t < g.to)) return { k: "gap", text: "取得できなかった区間（PC のスリープなど）" };
    return null;
  }

  function drawCursors() {
    const M = model(S.range);
    const surf = cssv("--surface");
    const cvs = S.view === "tiles" ? [...grid.querySelectorAll(".tile canvas.ovl")] : [$("#big canvas.ovl")];
    for (const cv of cvs) {
      const { ctx, w, h } = setupCanvas(cv);
      if (S.hoverT == null) continue;
      const tile = cv.closest(".tile");
      const isCmp = tile.classList.contains("cmp") || tile.id === "big";
      const F = frame(w, h, tile.id === "big" ? "big" : isCmp ? "cmp" : "tile");
      const X = mkX(F, M), Y = mkY(F);
      const x = Math.round(X(S.hoverT)) + 0.5;
      if (x < F.l || x > F.r) continue;
      ctx.strokeStyle = cssv("--ink-3"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, F.t - 4); ctx.lineTo(x, F.b); ctx.stroke();
      if (isCmp) {
        const kind = tile.id === "big" ? S.bigKind : "weekly_all";
        for (const a of ACC) {
          if (S.hidden.has(a.id) && tile.id === "big") continue;
          const p = valueAt(a, kind, S.hoverT);
          if (p) dot(ctx, X(p[0]), Y(p[1]), 3.5, colorOf(a), surf, 2);
        }
        continue;
      }
      const a = ACC.find((q) => q.id === tile.dataset.id);
      const col = colorOf(a);
      const ps = valueAt(a, "session", S.hoverT), pw = valueAt(a, "weekly_all", S.hoverT);
      if (ps) dot(ctx, X(ps[0]), Y(ps[1]), 3, col, surf, 1.8);
      if (pw) dot(ctx, X(pw[0]), Y(pw[1]), 4.5, col, surf, 2);
      // ホバー元以外のタイル: カーソル上端に小さな読み値（ツールチップは1つだけ）
      if (S.hoverSrc !== a.id) {
        const c = condAt(a, S.hoverT);
        const txt = pw || ps ? `週 ${pw ? pw[1] + "%" : "—"}  ·  5h ${ps ? ps[1] + "%" : "—"}` : c ? c.text : "記録なし";
        ctx.font = `600 11px ${cssv("--font")}`;
        const tw = ctx.measureText(txt).width + 12;
        let bx = x + 6; if (bx + tw > F.r + 30) bx = x - 6 - tw;
        ctx.fillStyle = surf; ctx.strokeStyle = cssv("--line-strong");
        roundRect(ctx, bx, F.t - 2, tw, 18, 4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = c && !pw ? cssv("--st-crit-ink") : cssv("--ink"); ctx.textBaseline = "middle"; ctx.textAlign = "left";
        ctx.fillText(txt, bx + 6, F.t + 7);
      }
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  const tip = $("#tip");
  const keyLine = (c) => `<svg viewBox="0 0 16 10"><path d="M1 5h14" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const keyArea = (c) => `<svg viewBox="0 0 16 10"><rect x="1" y="2" width="14" height="7" rx="1.5" fill="${rgba(c, 0.3)}"/><path d="M1 2.5h14" stroke="${c}" stroke-opacity=".7"/></svg>`;
  function showTip(html, cx, cy) {
    tip.innerHTML = html; tip.classList.add("on");
    const r = tip.getBoundingClientRect();
    let x = cx + 16, y = cy + 14;
    if (x + r.width > innerWidth - 8) x = cx - 16 - r.width;
    if (y + r.height > innerHeight - 8) y = cy - 14 - r.height;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => tip.classList.remove("on");

  function tipFor(srcId, t, cmpKind) {
    let h = `<div class="tt"><b>${fmtDT(t)}</b>`;
    if (cmpKind) {
      h += `<span>${cmpKind === "session" ? "5h" : "週間"}</span></div>`;
      const rows = ACC.filter((a) => !S.hidden.has(a.id)).map((a) => ({ a, p: valueAt(a, cmpKind, t) })).sort((p, q) => (q.p ? q.p[1] : -1) - (p.p ? p.p[1] : -1));
      for (const r of rows) h += `<div class="r">${keyLine(colorOf(r.a))}<span class="val num">${r.p ? r.p[1] + "%" : "—"}</span><span class="nm">${esc(r.a.label)}</span></div>`;
      return h;
    }
    const a = ACC.find((q) => q.id === srcId);
    const col = colorOf(a);
    h += `<span>${esc(a.label)}</span></div>`;
    const pw = valueAt(a, "weekly_all", t), ps = valueAt(a, "session", t);
    h += `<div class="r">${keyLine(col)}<span class="val num">${pw ? pw[1] + "%" : "—"}</span><span class="nm">週間</span></div>`;
    h += `<div class="r">${keyArea(col)}<span class="val num">${ps ? ps[1] + "%" : "—"}</span><span class="nm">5時間枠</span></div>`;
    const c = condAt(a, t);
    if (c) h += c.k === "err" ? `<div class="warnrow">${ICON.crit}${c.text}</div>` : `<div class="gaprow">${c.text}</div>`;
    return h;
  }

  function onMove(e) {
    const cv = e.target.closest("canvas.ovl");
    if (!cv) return;
    const tile = cv.closest(".tile");
    const r = cv.getBoundingClientRect();
    const M = model(S.range);
    const isBig = tile.id === "big", isCmp = tile.classList.contains("cmp");
    const F = frame(r.width, r.height, isBig ? "big" : isCmp ? "cmp" : "tile");
    const px = e.clientX - r.left;
    if (px < F.l - 4 || px > F.r + 4) { clearHover(); return; }
    let t = M.x0 + ((Math.max(F.l, Math.min(F.r, px)) - F.l) / F.w) * (M.x1 - M.x0);
    // カーソルは実際の取得時刻に吸着する（どこが実測かがわかる）
    const src = isBig || isCmp ? null : ACC.find((a) => a.id === tile.dataset.id);
    const pts = src ? model(S.range).per[src.id].wkPts : (model(S.range).per[(ACC.find((a) => !S.hidden.has(a.id)) || ACC[0]).id].wkPts);
    const n = nearest(pts, t);
    if (n && Math.abs(mkX(F, M)(n[0]) - px) < 12) t = n[0];
    S.hoverT = t; S.hoverSrc = src ? src.id : null;
    drawCursors();
    showTip(tipFor(S.hoverSrc, t, src ? null : isBig ? S.bigKind : "weekly_all"), e.clientX, e.clientY);
  }
  function clearHover() { if (S.hoverT == null) return; S.hoverT = null; S.hoverSrc = null; drawCursors(); hideTip(); }

  // キーボード: カーソルを左右に動かす（ホバーと同じ表示）
  function onKey(e) {
    const cv = e.target.closest && e.target.closest("canvas.ovl");
    if (!cv || !["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Escape") return clearHover();
    const tile = cv.closest(".tile");
    const a = ACC.find((q) => q.id === tile.dataset.id) || ACC[0];
    const pts = model(S.range).per[a.id].wkPts;
    if (!pts.length) return;
    let i = S.hoverT == null ? pts.length - 1 : pts.findIndex((p) => p[0] >= S.hoverT);
    if (i < 0) i = pts.length - 1;
    i = Math.max(0, Math.min(pts.length - 1, i + (S.hoverT == null ? 0 : e.key === "ArrowRight" ? 1 : -1)));
    S.hoverT = pts[i][0]; S.hoverSrc = tile.dataset.id || null;
    drawCursors();
    const r = cv.getBoundingClientRect();
    const F = frame(r.width, r.height, tile.id === "big" ? "big" : tile.classList.contains("cmp") ? "cmp" : "tile");
    showTip(tipFor(S.hoverSrc, S.hoverT, S.hoverSrc ? null : tile.id === "big" ? S.bigKind : "weekly_all"), r.left + mkX(F, model(S.range))(S.hoverT), r.top + F.t + 10);
  }

  // =========================================================================
  // 操作
  // =========================================================================
  function syncControls() {
    for (const b of $("#range").children) b.setAttribute("aria-pressed", b.dataset.v === S.range);
    for (const b of $("#view").children) b.setAttribute("aria-pressed", b.dataset.v === S.view);
    for (const b of $("#bigKind").children) b.setAttribute("aria-pressed", b.dataset.v === S.bigKind);
    $("#app").classList.toggle("overlay", S.view === "overlay");
  }
  function rerender() { renderSummary(); renderTiles(); syncControls(); requestAnimationFrame(drawAll); }

  $("#range").addEventListener("click", (e) => { const v = e.target.dataset.v; if (v) { S.range = v; clearHover(); syncControls(); drawAll(); } });
  $("#view").addEventListener("click", (e) => { const v = e.target.dataset.v; if (v) { S.view = v; S.focus = null; clearHover(); syncControls(); requestAnimationFrame(drawAll); } });
  $("#bigKind").addEventListener("click", (e) => { const v = e.target.dataset.v; if (v) { S.bigKind = v; syncControls(); drawAll(); } });
  $("#theme").addEventListener("click", () => {
    document.documentElement.dataset.theme = isDark() ? "light" : "dark";
    applyTileClasses(); drawAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { applyTileClasses(); drawAll(); });
  function fakeRefresh(ids) {
    ids.forEach((id) => S.busy.add(id)); rerender();
    setTimeout(() => { ids.forEach((id) => S.busy.delete(id)); ST.collector.busy.forEach((id) => S.busy.add(id)); rerender(); }, 1800);
  }
  $("#refresh").addEventListener("click", () => fakeRefresh(ACC.filter((a) => a.enabled).map((a) => a.id)));

  document.addEventListener("pointermove", (e) => {
    if (e.target.closest && e.target.closest("canvas.ovl")) return onMove(e);
    const pk = e.target.closest && e.target.closest("rect.hit");
    if (pk) {
      const [fs, ra, pp, cur] = pk.dataset.pk.split(",").map(Number);
      showTip(`<div class="tt"><b>${fmtD(fs)} 〜 ${fmtD(ra)} の週</b><span>${cur ? "進行中" : ""}</span></div><div class="r"><span></span><span class="val num">${pp}%</span><span class="nm">週間のピーク</span></div>`, e.clientX, e.clientY);
      return;
    }
    if (S.hoverT != null) clearHover(); else hideTip();
  });
  document.addEventListener("pointerleave", clearHover);
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", (e) => {
    const r = e.target.closest("[data-refresh]"); if (r) return fakeRefresh([r.dataset.refresh]);
    const l = e.target.closest("[data-login]"); if (l) { l.textContent = "待機中…"; l.disabled = true; return; }
    const c = e.target.closest(".tile.cmp"); if (c) { S.view = "overlay"; syncControls(); requestAnimationFrame(drawAll); return; }
    const t = e.target.closest(".app.overlay .tile[data-id]");
    if (t) { const id = t.dataset.id; S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id); applyTileClasses(); drawAll(); }
  });
  document.addEventListener("dblclick", (e) => {
    const t = e.target.closest(".app.overlay .tile[data-id]");
    if (!t) return;
    S.hidden = new Set(ACC.filter((a) => a.id !== t.dataset.id).map((a) => a.id));
    applyTileClasses(); drawAll();
  });
  // 重ねる表示: 帯にホバーで、その線を強調（ほかは薄く）
  grid.addEventListener("pointerover", (e) => {
    if (S.view !== "overlay") return;
    const t = e.target.closest(".tile[data-id]"); const id = t ? t.dataset.id : null;
    if (id !== S.focus) { S.focus = id; drawAll(); }
  });
  grid.addEventListener("pointerleave", () => { if (S.focus) { S.focus = null; drawAll(); } });
  // サマリーのチップ: ホバーで該当タイルだけを残す
  $("#summary").addEventListener("pointerover", (e) => {
    const c = e.target.closest("[data-filter]");
    S.filter = c ? new Set(c.dataset.filter.split(",")) : null; applyTileClasses();
  });
  $("#summary").addEventListener("pointerleave", () => { S.filter = null; applyTileClasses(); });

  new ResizeObserver(() => drawAll()).observe($("#app"));
  window.__b = { S, drawAll, hover(id, frac) {  // スクリーンショット用: タイル id の x 位置 frac にホバーさせる
    const el = id === "big" ? $("#big") : grid.querySelector(`.tile[data-id="${id}"]`);
    const cv = $("canvas.ovl", el); const r = cv.getBoundingClientRect();
    const F = frame(r.width, r.height, id === "big" ? "big" : "tile");
    const ev = new PointerEvent("pointermove", { bubbles: true, clientX: r.left + F.l + F.w * frac, clientY: r.top + F.t + F.h * 0.4 });
    cv.dispatchEvent(ev); return S.hoverT;
  } };
  rerender();
})();
