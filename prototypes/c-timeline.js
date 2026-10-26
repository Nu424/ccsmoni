// 方向性 C「レール＋分析（Timeline）」のプロトタイプ。
// demo-data.js（window.CCSMONI_DEMO）だけで動く。?n=6 で6アカウント、?theme=dark でダーク。
(function () {
  "use strict";

  const P = new URLSearchParams(location.search);
  const N = Math.max(1, Math.min(7, parseInt(P.get("n") || "4", 10) || 4));
  const NCOL = 7; // categorical スロット数（c0〜c6）

  // ---- データの準備 ---------------------------------------------------------
  // ?n=5〜7 のときに足すアカウント（既存のものを複製して値を変える）
  const EXTRA = [
    { id: "acct-p", from: "acct-a", label: "副業", plan: "max", w: [1.25, 6], s: [1.45, 8],
      hints: [{ kind: "will_hit_limit", text: "このペースだと 18:40 に5時間枠の上限" },
              { kind: "will_hit_limit", text: "このペースだと 水 21:10 に週間上限" }] },
    { id: "acct-q", from: "acct-c", label: "研究", plan: "pro", w: [0.8, 14], s: [1, 0], hints: [] },
    { id: "acct-r", from: "acct-b", label: "共有", plan: "max", w: [0.55, 22], s: [0.8, 4], hints: [] },
  ];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function buildData() {
    const src = JSON.parse(JSON.stringify(window.CCSMONI_DEMO));
    const st = src.state;
    const extras = EXTRA.slice(0, Math.max(0, N - st.accounts.length));
    st.accounts = st.accounts.slice(0, N);
    for (const ex of extras) {
      const fw = (v) => (v === 0 ? 0 : clamp(Math.round(v * ex.w[0] + ex.w[1]), 0, 100));
      const fs = (v) => (v === 0 ? 0 : clamp(Math.round(v * ex.s[0] + ex.s[1]), 0, 100));
      const f = (kind) => (kind === "session" ? fs : fw);
      const base = JSON.parse(JSON.stringify(window.CCSMONI_DEMO.state.accounts.find((a) => a.id === ex.from)));
      base.id = ex.id; base.label = ex.label; base.plan = ex.plan; base.hints = ex.hints;
      base.launch_command = "claude-" + ex.id;
      for (const l of base.limits) l.percent = f(l.kind)(l.percent);
      if (base.last_ok) for (const l of base.last_ok.limits) l.percent = f(l.kind)(l.percent);
      st.accounts.push(base);
      for (const r of ["history_24h", "history_7d", "history_30d"]) {
        const h = src[r];
        for (const s of window.CCSMONI_DEMO[r].series) {
          if (s.account_id !== ex.from || (s.kind !== "weekly_all" && s.kind !== "session")) continue;
          h.series.push({ account_id: ex.id, kind: s.kind,
            segments: s.segments.map((g) => ({ ...g, points: g.points.map(([t, v]) => [t, f(s.kind)(v)]) })) });
        }
        for (const k of ["resets", "gaps", "errors"])
          for (const e of window.CCSMONI_DEMO[r][k]) if (e.account_id === ex.from) h[k].push({ ...e, account_id: ex.id });
      }
      for (const k of ["windows_weekly", "windows_session"]) {
        const row = window.CCSMONI_DEMO[k].rows.find((r) => r.account_id === ex.from);
        if (row) src[k].rows.push({ account_id: ex.id,
          windows: row.windows.map((w) => ({ ...w, peak_percent: f(k === "windows_session" ? "session" : "weekly")(w.peak_percent) })) });
      }
    }
    return src;
  }

  const DATA = buildData();
  const S = DATA.state;
  const NOW = S.now;
  const UI = S.ui;
  const ACC = S.accounts.map((a, i) => ({
    ...a, idx: i, col: `var(--c${i % NCOL})`,
    W: lim(a, "weekly_all"), H5: lim(a, "session"),
    tol: 3 * (a.interval_minutes || 10) * 60,
  }));
  const byId = Object.fromEntries(ACC.map((a) => [a.id, a]));
  function lim(a, kind) {
    const src = a.status === "ok" ? a.limits : (a.last_ok ? a.last_ok.limits : []);
    const l = src.find((x) => x.kind === kind);
    return l ? { ...l, stale: a.status !== "ok" } : null;
  }

  // 期間ごとの系列
  const HIST = {};
  for (const r of ["24h", "7d", "30d"]) {
    const h = DATA["history_" + r];
    const per = {};
    for (const a of ACC) per[a.id] = { w: [], s: [], resets: [], gaps: [], errors: [] };
    for (const s of h.series) {
      const p = per[s.account_id]; if (!p) continue;
      if (s.kind === "weekly_all") p.w = s.segments;
      else if (s.kind === "session") p.s = s.segments;
    }
    for (const e of h.resets) if (per[e.account_id] && e.kind === "weekly_all") per[e.account_id].resets.push(e.t);
    for (const g of h.gaps) if (per[g.account_id]) per[g.account_id].gaps.push([g.from, g.to]);
    for (const e of h.errors) if (per[e.account_id]) per[e.account_id].errors.push(e);
    for (const a of ACC) {
      const p = per[a.id];
      p.fw = flat(p.w); p.fs = flat(p.s);
      p.errBands = bands(p.errors.map((e) => e.t).sort((x, y) => x - y), a.tol, (a.interval_minutes || 10) * 60);
    }
    HIST[r] = { since: h.since, until: h.until, per };
  }
  function flat(segs) {
    const T = [], V = [];
    for (const g of segs) for (const [t, v] of g.points) { T.push(t); V.push(v); }
    return { T, V };
  }
  function bands(ts, tol, iv) {
    const out = [];
    for (const t of ts) {
      const b = out[out.length - 1];
      if (b && t - b[1] <= tol) b[1] = t; else out.push([t, t]);
    }
    return out.map(([a, b]) => [a - iv / 2, b + iv / 2]);
  }
  function idxAtOrBefore(T, t) {
    let lo = 0, hi = T.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (T[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  function valAt(f, t, tol) {
    const i = idxAtOrBefore(f.T, t);
    if (i < 0 || t - f.T[i] > tol) return null;
    return f.V[i];
  }

  // ---- 状態 ------------------------------------------------------------------
  let range = "7d";
  const hidden = new Set();
  let hl = null;
  let rightPinned = false;

  // ---- 書式 ------------------------------------------------------------------
  const pad2 = (n) => String(n).padStart(2, "0");
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v) => (v == null ? "—" : Math.round(v) + "%");
  const clock = (t) => { const d = new Date(t * 1000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const md = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const mdw = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
  function ago(t) {
    const s = Math.max(0, NOW - t);
    if (s < 60) return "たった今";
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return `${Math.floor(s / 86400)}日前`;
  }
  function inT(t) {
    const m = Math.ceil((t - NOW) / 60);
    if (m <= 0) return "まもなく";
    if (m < 60) return `${m}分後`;
    return `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}後`;
  }
  function remain(t) { // レールの「リセットまで」列（短く）
    if (!t) return null;
    const s = t - NOW;
    if (s <= 0) return "リセット済";
    if (s < 3600) return `${Math.ceil(s / 60)}分`;
    if (s < 86400) return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}`;
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return h ? `${d}日${h}時間` : `${d}日`;
  }
  const level = (p) => (p == null ? "" : p >= UI.danger_percent ? "danger" : p >= UI.warn_percent ? "warn" : "");

  // アイコン（status は必ず形＋文字と一緒）
  const ICON = {
    warn: `<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2L11.2 10.6H.8z" fill="var(--warning)"/><path d="M6 4.6v3M6 8.9v.1" stroke="#111" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    crit: `<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.2" fill="var(--critical)"/><path d="M6 3.2v3.3M6 8.5v.1" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    good: `<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8L11.2 6 6 11.2.8 6z" fill="var(--good)"/><path d="M6 3.5v3M6 8.3v.1" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    info: `<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="var(--muted)" stroke-width="1.2"/><path d="M6 3.6V6.2l1.6 1" fill="none" stroke="var(--muted)" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    eye: `<svg class="eye" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z M3 13L13 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  };
  const hintIcon = (k) => (k === "use_it_or_lose_it" ? ICON.good : ICON.warn);

  // ---- ヘッダー ----------------------------------------------------------------
  function renderHeader() {
    const out = ACC.filter((a) => a.status === "logged_out").length;
    const errs = ACC.filter((a) => a.status !== "ok" && a.status !== "logged_out" && a.status !== "never").length;
    const warn = ACC.filter((a) => a.status === "ok" && ((a.W && level(a.W.percent)) || (a.H5 && level(a.H5.percent)) || a.hints.some((h) => h.kind === "will_hit_limit"))).length;
    let html = `<span class="pill"><b>${ACC.length}</b> アカウント</span>`;
    if (warn) html += `<span class="pill">${ICON.warn}要注意 <b>${warn}</b></span>`;
    if (out) html += `<span class="pill">${ICON.crit}ログイン切れ <b>${out}</b></span>`;
    if (errs) html += `<span class="pill">${ICON.crit}取得エラー <b>${errs}</b></span>`;
    document.getElementById("summary").innerHTML = html;
    const c = S.candidates || [];
    document.getElementById("cand").innerHTML = c.length
      ? `<span class="pill" title="${esc(c[0].config_dir)}">＋ 新しいアカウント <b>${esc(c[0].suggested_id)}</b></span>` : "";
    document.getElementById("upd").innerHTML =
      `最終更新 <b>${ago(S.collector.last_run_at)}</b> · 次回 <b>${S.collector.next_run_at ? inT(S.collector.next_run_at) : "—"}</b>`;
  }

  // ---- レール ------------------------------------------------------------------
  const railEl = document.getElementById("rail");
  function meterRow(lab, l, a) {
    if (!l) return `<div class="mrow"><span class="lab">${lab}</span><div class="meter"></div><span class="val">—</span><span class="rem"></span></div>`;
    const p = l.percent;
    const lv = l.stale ? "ghost" : level(p);
    const pace = l.pace && !l.stale ? `<i class="pace" style="left:${clamp(l.pace.expected_percent, 0, 100)}%" title="均等に使った場合の位置 ${Math.round(l.pace.expected_percent)}%"></i>` : "";
    let rem = remain(l.resets_at);
    if (rem == null) rem = p === 0 ? "未開始" : "—";
    return `<div class="mrow${l.stale ? " stale" : ""}"><span class="lab">${lab}</span>` +
      `<div class="meter ${lv}" role="meter" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100" aria-label="${lab} ${p}%"><i class="fill" style="width:${clamp(p, 0, 100)}%"></i>${pace}</div>` +
      `<span class="val">${pct(p)}</span><span class="rem">${rem}</span></div>`;
  }
  function noteRow(a) {
    if (a.status === "logged_out")
      return `<div class="ri-note" data-pop="1">${ICON.crit}<span class="st crit">ログイン切れ</span><span class="txt">· ${ago(a.last_ok ? a.last_ok.taken_at : a.taken_at)}の値</span><button class="mini-btn" data-login="${esc(a.id)}" type="button">ログイン</button></div>`;
    if (a.status !== "ok" && a.status !== "never")
      return `<div class="ri-note" data-pop="1">${ICON.crit}<span class="st crit">取得エラー</span><span class="txt">${esc(a.status)}</span><button class="mini-btn" type="button">再取得</button></div>`;
    if (a.hints.length) {
      const h = a.hints[0];
      return `<div class="ri-note" data-pop="1">${hintIcon(h.kind)}<span class="txt">${esc(h.text)}</span>${a.hints.length > 1 ? `<span class="st" style="color:var(--muted)">+${a.hints.length - 1}</span>` : ""}</div>`;
    }
    return `<div class="ri-note quiet">${ICON.info}<span class="txt">次の取得 ${a.next_run_at ? inT(a.next_run_at) : "—"} · ${a.interval_minutes}分ごと</span></div>`;
  }
  function renderRail() {
    railEl.innerHTML = ACC.map((a) => {
      const age = a.status === "ok" ? ago(a.taken_at) : "";
      const stale = a.stale ? `<span class="st warn">${ICON.warn}遅延</span>` : "";
      return `<li class="ri${hidden.has(a.id) ? " off" : ""}${hl === a.id ? " hl" : ""}" data-id="${esc(a.id)}" style="--sc:${a.col}" tabindex="0" role="switch" aria-checked="${!hidden.has(a.id)}" aria-label="${esc(a.label)} を表示">` +
        `<div class="ri-h"><span class="ri-name">${esc(a.label)}</span>${a.plan ? `<span class="plan">${esc(a.plan.toUpperCase())}</span>` : ""}${stale}<span class="ri-age">${age}</span>${ICON.eye}</div>` +
        meterRow("週", a.W, a) + meterRow("5h", a.H5, a) + noteRow(a) + `</li>`;
    }).join("");
    const nh = hidden.size;
    document.getElementById("railfoot").innerHTML = nh
      ? `<span>${ACC.length - nh}/${ACC.length} を表示中</span><button type="button" id="showall">すべて表示</button>`
      : `<span>縦線＝均等に使った場合のペース</span>`;
    const sa = document.getElementById("showall");
    if (sa) sa.onclick = () => { hidden.clear(); update(); };
  }
  // これから起きること（リセットと上限の予測）。レールの残りの高さに入るだけ出す
  function renderUpcoming() {
    const ev = [];
    for (const a of ACC) {
      if (a.status !== "ok") continue;
      if (a.H5 && a.H5.resets_at > NOW) ev.push({ a, t: a.H5.resets_at, txt: "5h リセット" });
      if (a.W && a.W.resets_at > NOW) ev.push({ a, t: a.W.resets_at, txt: "週間リセット" });
      for (const l of [a.H5, a.W]) if (l && l.pace && l.pace.eta_full && l.pace.eta_full > NOW && l.pace.eta_full < l.resets_at)
        ev.push({ a, t: l.pace.eta_full, txt: (l === a.W ? "週間" : "5h") + "上限の予測", warn: true });
    }
    ev.sort((p, q) => p.t - q.t);
    const when = (t) => (t - NOW < 86400 && new Date(t * 1000).getDate() === new Date(NOW * 1000).getDate() ? clock(t) : `${WD[new Date(t * 1000).getDay()]} ${clock(t)}`);
    document.getElementById("up").innerHTML = `<div class="up-h"><h2>これから</h2><span class="sub2">リセットと上限の予測</span></div>` +
      ev.map((e) => `<div class="ev${hidden.has(e.a.id) ? " off" : ""}" data-row="${esc(e.a.id)}" style="--sc:${e.a.col}"><span class="t">${when(e.t)}</span><i class="k"></i>` +
        `<span class="d">${e.warn ? ICON.warn : ""}<b>${esc(e.a.label)}</b>${esc(e.txt)}</span><span class="r">あと ${remain(e.t)}</span></div>`).join("");
  }
  function fitUpcoming() { // はみ出す行は消す（途中で切れた行を出さない）
    const up = document.getElementById("up");
    const evs = up.querySelectorAll(".ev");
    for (let i = evs.length - 1; i >= 0 && up.scrollHeight > up.clientHeight + 1; i--) evs[i].remove();
    up.style.display = up.querySelector(".ev") ? "" : "none";
  }
  document.getElementById("up").addEventListener("mouseover", (e) => { const r = e.target.closest("[data-row]"); setHl(r && !hidden.has(r.dataset.row) ? r.dataset.row : null); });
  document.getElementById("up").addEventListener("mouseleave", () => setHl(null));

  let clickTimer = null;
  railEl.addEventListener("click", (e) => {
    const lg = e.target.closest("[data-login]");
    if (lg) { e.stopPropagation(); toast("PC 側にログイン画面を開きました（デモ）"); return; }
    if (e.target.closest(".mini-btn")) { e.stopPropagation(); toast("再取得を予約しました（デモ）"); return; }
    const li = e.target.closest(".ri"); if (!li) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => toggle(li.dataset.id), 220);
  });
  railEl.addEventListener("dblclick", (e) => {
    const li = e.target.closest(".ri"); if (!li || e.target.closest(".mini-btn")) return;
    clearTimeout(clickTimer);
    solo(li.dataset.id);
  });
  railEl.addEventListener("keydown", (e) => {
    const li = e.target.closest(".ri"); if (!li) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.shiftKey ? solo(li.dataset.id) : toggle(li.dataset.id); }
  });
  railEl.addEventListener("mouseover", (e) => {
    const li = e.target.closest(".ri");
    setHl(li && !hidden.has(li.dataset.id) ? li.dataset.id : null);
    const n = e.target.closest("[data-pop]");
    if (n && li) showPop(byId[li.dataset.id], li);
  });
  railEl.addEventListener("mouseleave", () => { setHl(null); schedHidePop(); });
  railEl.addEventListener("mouseout", (e) => {
    const n = e.target.closest("[data-pop]");
    if (n && !n.contains(e.relatedTarget)) schedHidePop();
  });
  function toggle(id) { hidden.has(id) ? hidden.delete(id) : hidden.add(id); update(); }
  function solo(id) {
    const others = ACC.filter((a) => a.id !== id);
    const isSolo = !hidden.has(id) && others.every((a) => hidden.has(a.id));
    hidden.clear();
    if (!isSolo) others.forEach((a) => hidden.add(a.id));
    update();
  }

  // ---- ポップオーバー（ヒント・ログイン切れの詳細） ---------------------------------
  const popEl = document.getElementById("pop");
  let popTimer = null;
  function showPop(a, anchor) {
    clearTimeout(popTimer);
    let body = `<h3><span style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${a.col}"></span>${esc(a.label)}</h3>`;
    if (a.status === "logged_out") {
      body += `<div class="row">${ICON.crit}<span>${esc(a.message || "ログインが切れています")}</span></div>`;
      body += `<div class="acts"><button class="btn primary" data-login="${esc(a.id)}" type="button" style="height:24px">ログイン</button><span style="color:var(--muted)">PC にログイン画面を開きます</span></div>`;
      body += `<div class="row" style="margin-top:8px">手動なら <code>${esc(a.launch_command || "claude")}</code> を起動して <code>/login</code></div>`;
    }
    for (const h of a.hints) body += `<div class="row">${hintIcon(h.kind)}<span>${esc(h.text)}</span></div>`;
    const W = a.W, H = a.H5;
    body += `<dl>` +
      (W ? `<dt>週間</dt><dd>${pct(W.percent)}${W.pace ? `（ペース ${Math.round(W.pace.expected_percent)}%）` : ""}${W.resets_at ? ` · ${mdw(W.resets_at)} ${clock(W.resets_at)} にリセット` : ""}</dd>` : "") +
      (H ? `<dt>5時間</dt><dd>${pct(H.percent)}${H.resets_at && H.resets_at > NOW ? ` · ${clock(H.resets_at)} にリセット` : ""}</dd>` : "") +
      (W && W.pace && W.pace.eta_full ? `<dt>上限の予測</dt><dd>${mdw(W.pace.eta_full)} ${clock(W.pace.eta_full)}</dd>` : "") +
      `<dt>最終取得</dt><dd>${a.last_ok ? ago(a.last_ok.taken_at) + "（成功）" : ago(a.taken_at)}</dd>` +
      `<dt>次の取得</dt><dd>${a.next_run_at ? inT(a.next_run_at) : "—"}（${a.interval_minutes}分ごと）</dd></dl>`;
    popEl.innerHTML = body;
    popEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
    let x = r.right + 8, y = r.top;
    if (x + pw > innerWidth - 8) { x = clamp(r.left, 8, innerWidth - pw - 8); y = r.bottom + 6; }
    if (y + ph > innerHeight - 8) y = Math.max(8, innerHeight - ph - 8);
    popEl.style.left = x + "px"; popEl.style.top = y + "px";
  }
  function schedHidePop() { clearTimeout(popTimer); popTimer = setTimeout(() => { popEl.hidden = true; }, 220); }
  popEl.addEventListener("mouseenter", () => clearTimeout(popTimer));
  popEl.addEventListener("mouseleave", schedHidePop);
  popEl.addEventListener("click", (e) => { if (e.target.closest("[data-login]")) toast("PC 側にログイン画面を開きました（デモ）"); });

  // ---- 期間 ------------------------------------------------------------------
  const RANGES = [["24h", "24時間"], ["7d", "7日"], ["30d", "30日"]];
  function renderRange() {
    const el = document.getElementById("range");
    el.innerHTML = RANGES.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === range}" data-v="${v}">${l}</button>`).join("");
    el.onclick = (e) => { const b = e.target.closest("button"); if (b) { range = b.dataset.v; update(); } };
  }

  // ---- グラフ（週間＋5h＋取得状況、x 軸を共有する1枚の SVG） --------------------------
  const chartEl = document.getElementById("chart");
  const svg = document.getElementById("svg");
  const tip = document.getElementById("tip");
  let G = null; // 直近の描画のジオメトリ（ホバーで使う）

  function domain() {
    const H = HIST[range];
    let first = Infinity;
    for (const a of ACC) {
      if (hidden.has(a.id)) continue;
      const f = H.per[a.id].fw; if (f.T.length) first = Math.min(first, f.T[0]);
      const g = H.per[a.id].fs; if (g.T.length) first = Math.min(first, g.T[0]);
    }
    // 記録が短いときは、最初の観測から始める（空白を作らない）
    const t0 = isFinite(first) ? Math.max(H.since, first - (NOW - Math.max(H.since, first)) * 0.01) : H.since;
    return [t0, NOW];
  }
  function xTicks(t0, t1, pw) {
    const HR = 3600, steps = [1, 2, 3, 6, 12, 24, 48, 96, 168].map((h) => h * HR);
    const minPx = pw < 500 ? 62 : 88;
    const step = steps.find((s) => (s / (t1 - t0)) * pw >= minPx) || steps[steps.length - 1];
    const d = new Date(t0 * 1000); d.setHours(0, 0, 0, 0);
    let t = d.getTime() / 1000;
    const out = [];
    for (; t <= t1; t += step) if (t >= t0) out.push(t);
    return { ticks: out, step };
  }

  function segPathAndDots(segs, X, Y, t0, dotMode, area, yBase) {
    let d = "", a = "", dots = "";
    for (const g of segs) {
      const pts = g.points;
      let started = false, lastX = -1e9, lastV = null, sx = 0, ex = 0, prevV = null;
      let seg = "";
      for (let i = 0; i < pts.length; i++) {
        const [t, v] = pts[i];
        if (t < t0) { prevV = v; continue; }
        const x = X(t), y = Y(v);
        const keep = !started || i === pts.length - 1 || v !== lastV || x - lastX >= 1.5;
        if (keep) {
          seg += (started ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
          if (!started) sx = x;
          ex = x; started = true; lastX = x; lastV = v;
        }
        if (dotMode === "all" || (dotMode === "change" && prevV !== null && v !== prevV)) {
          const r = dotMode === "all" ? 1.7 : 1.25;
          dots += `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0-${2 * r} 0`;
        }
        prevV = v;
      }
      if (!started) continue;
      d += seg;
      if (area && g.window_id != null) a += seg + `L${ex.toFixed(1)} ${yBase}L${sx.toFixed(1)} ${yBase}Z`;
    }
    return { d, a, dots };
  }

  // 終端ラベルの配置（重ならないように縦に送る。動かしたものは引き出し線でつなぐ）
  function placeLabels(items, top, bottom, h) {
    items.sort((p, q) => p.y0 - q.y0);
    for (let i = 0; i < items.length; i++) items[i].y = Math.max(items[i].y0, i ? items[i - 1].y + h : top);
    const over = items.length ? items[items.length - 1].y - bottom : 0;
    if (over > 0) {
      items[items.length - 1].y = bottom;
      for (let i = items.length - 2; i >= 0; i--) items[i].y = Math.min(items[i].y, items[i + 1].y - h);
      for (let i = 0; i < items.length; i++) items[i].y = Math.max(items[i].y, i ? items[i - 1].y + h : top);
    }
    return items;
  }

  function renderChart() {
    const W = chartEl.clientWidth, Hh = chartEl.clientHeight;
    if (!W || !Hh) return;
    const narrow = W < 620;
    const L = 32, R = narrow ? 88 : 128;
    const pw = W - L - R;
    const Hd = HIST[range];
    const [t0, t1] = domain();
    const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
    const vis = ACC.filter((a) => !hidden.has(a.id));
    const rows = vis.length;
    const stripRow = 5, stripGap = 2;
    const stripH = Math.max(1, rows * (stripRow + stripGap) - stripGap);

    // 縦の割り付け
    const titleH = 22, gap = 18, axisH = 20, stripPad = 12;
    const avail = Hh - (titleH * 2 + gap + stripPad + stripH + axisH + 4);
    const hw = Math.round(avail * 0.62), hs = avail - hw;
    const wTop = titleH, wBot = wTop + hw;
    const sTop = wBot + gap + titleH, sBot = sTop + hs;
    const stTop = sBot + stripPad, stBot = stTop + stripH;
    const Yw = (v) => wTop + (1 - v / 100) * hw;
    const Ys = (v) => sTop + (1 - v / 100) * hs;

    const iv = 600;
    const spacing = (pw * iv) / (t1 - t0);
    const dotMode = spacing >= 4 ? "all" : range === "30d" ? "none" : "change";
    const dotModeS = spacing >= 4 ? "all" : "none"; // 5h は 7日以上だと点が線を埋めてしまうので省く（ホバーで観測点を示す）

    let o = `<defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--surface)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--hatch)" stroke-width="2"/></pattern>` +
      `<clipPath id="clipW"><rect x="${L - 4}" y="${wTop - 6}" width="${pw + 10}" height="${hw + 12}"/></clipPath>` +
      `<clipPath id="clipS"><rect x="${L - 4}" y="${sTop - 6}" width="${pw + 10}" height="${hs + 8}"/></clipPath></defs>`;

    // タイトル
    o += `<text class="ttl" x="${L}" y="${wTop - 8}">週間</text><text class="sub" x="${L + 32}" y="${wTop - 8}">全モデル · 7日枠 · 線の終端＝いま</text>`;
    o += `<text class="ttl" x="${L}" y="${sTop - 8}">5時間枠</text><text class="sub" x="${L + 52}" y="${sTop - 8}">枠ごとに線が切れます</text>`;

    // グリッド
    const { ticks } = xTicks(t0, t1, pw);
    o += `<g class="grid">`;
    for (const v of [0, 25, 50, 75, 100]) o += `<line x1="${L}" x2="${L + pw}" y1="${Yw(v) + 0.5}" y2="${Yw(v) + 0.5}"/>`;
    for (const v of [0, 50, 100]) o += `<line x1="${L}" x2="${L + pw}" y1="${Ys(v) + 0.5}" y2="${Ys(v) + 0.5}"/>`;
    for (const t of ticks) { const x = Math.round(X(t)) + 0.5; o += `<line x1="${x}" x2="${x}" y1="${wTop}" y2="${wBot}"/><line x1="${x}" x2="${x}" y1="${sTop}" y2="${sBot}"/>`; }
    o += `</g>`;
    o += `<line class="base" x1="${L}" x2="${L + pw}" y1="${Yw(0) + 0.5}" y2="${Yw(0) + 0.5}"/><line class="base" x1="${L}" x2="${L + pw}" y1="${Ys(0) + 0.5}" y2="${Ys(0) + 0.5}"/>`;
    o += `<g class="ax">`;
    for (const v of [0, 25, 50, 75, 100]) o += `<text x="${L - 6}" y="${Yw(v) + 3.5}" text-anchor="end">${v}</text>`;
    for (const v of [0, 50, 100]) o += `<text x="${L - 6}" y="${Ys(v) + 3.5}" text-anchor="end">${v}</text>`;
    // しきい値（危険）の目盛り: 右端の小さな刻み
    o += `</g>`;

    // 取得なし（表示中の全アカウントが取れていない区間＝PC のスリープなど）
    let common = null;
    for (const a of vis) {
      const gs = Hd.per[a.id].gaps;
      if (common === null) common = gs.map((g) => g.slice());
      else common = common.flatMap(([f, t]) => gs.filter(([f2, t2]) => f2 < t && t2 > f).map(([f2, t2]) => [Math.max(f, f2), Math.min(t, t2)]));
    }
    for (const [f, t] of common || []) {
      if (t < t0) continue;
      const x0 = X(Math.max(f, t0)), x1 = X(t);
      o += `<rect class="gapband" x="${x0}" y="${wTop}" width="${Math.max(1, x1 - x0)}" height="${hw}"/><rect class="gapband" x="${x0}" y="${sTop}" width="${Math.max(1, x1 - x0)}" height="${hs}"/>`;
    }

    // 系列
    const wl = [], sl = [];
    let gw = `<g clip-path="url(#clipW)">`, gs = `<g clip-path="url(#clipS)">`;
    for (const a of vis) {
      const p = Hd.per[a.id];
      const cls = `series${hl === a.id ? " hl" : ""}${a.status !== "ok" ? " stale" : ""}`;
      // 週間
      const w = segPathAndDots(p.w, X, Yw, t0, dotMode, false, 0);
      let rs = "";
      for (const t of p.resets) if (t >= t0) { const x = Math.round(X(t)) + 0.5; rs += `<line class="rs" x1="${x}" x2="${x}" y1="${wTop}" y2="${wBot}" style="stroke:${a.col}"/><path d="M${x - 3.5} ${wTop}h7l-3.5 4.5z" style="fill:${a.col}"/>`; }
      let end = "";
      const fw = p.fw;
      if (fw.T.length && fw.T[fw.T.length - 1] >= t0) {
        const lt = fw.T[fw.T.length - 1], lv = fw.V[fw.V.length - 1];
        end = `<circle class="end" cx="${X(lt)}" cy="${Yw(lv)}" r="4" style="fill:${a.col}"/>`;
        wl.push({ a, y0: Yw(lv), ex: X(lt), v: lv, old: NOW - lt > a.tol ? ago(lt) : null });
      }
      gw += `<g class="${cls}" data-id="${esc(a.id)}">${rs}<path class="ln" d="${w.d}" style="stroke:${a.col}"/><path class="dt" d="${w.dots}" style="fill:${a.col}"/>${end}</g>`;
      // 5h
      const s = segPathAndDots(p.s, X, Ys, t0, dotModeS, true, Ys(0));
      let send = "";
      const fs = p.fs;
      if (fs.T.length && NOW - fs.T[fs.T.length - 1] <= a.tol) {
        const lt = fs.T[fs.T.length - 1], lv = fs.V[fs.V.length - 1];
        send = `<circle class="end" cx="${X(lt)}" cy="${Ys(lv)}" r="3.5" style="fill:${a.col}"/>`;
        if (lv > 0) sl.push({ a, y0: Ys(lv), ex: X(lt), v: lv });
      }
      gs += `<g class="${cls} s5" data-id="${esc(a.id)}"><path class="ar" d="${s.a}" style="fill:${a.col}"/><path class="ln" d="${s.d}" style="stroke:${a.col}"/><path class="dt" d="${s.dots}" style="fill:${a.col}"/>${send}</g>`;
    }
    o += gw + `</g>` + gs + `</g>`;

    // 終端ラベル
    const lx = L + pw + 12;
    const nameMax = narrow ? 3 : 6;
    const lab = (items, top, bottom) => {
      let s = "";
      for (const it of placeLabels(items, top, bottom, 15)) {
        const a = it.a;
        const moved = Math.abs(it.y - it.y0) > 1.5 || it.ex < L + pw - 6;
        const nm = a.label.length > nameMax ? a.label.slice(0, nameMax - 1) + "…" : a.label;
        s += `<g class="lbl${hl === a.id ? " hl" : ""}" data-id="${esc(a.id)}">`;
        if (moved) s += `<path class="leader" d="M${(it.ex + 6).toFixed(1)} ${it.y0.toFixed(1)}H${L + pw + 3}L${lx - 2} ${it.y.toFixed(1)}"/>`;
        s += `<line class="key" x1="${lx}" x2="${lx + 8}" y1="${it.y}" y2="${it.y}" style="stroke:${a.col}"/>` +
          `<text class="ln-name" x="${lx + 13}" y="${it.y + 4}">${esc(nm)}${it.old && !narrow ? `<tspan class="ln-old" dx="4">${esc(it.old)}</tspan>` : ""}</text>` +
          `<text class="ln-val" x="${W - 4}" y="${it.y + 4}" text-anchor="end">${pct(it.v)}</text></g>`;
      }
      return s;
    };
    o += lab(wl, wTop + 2, wBot - 2) + lab(sl, sTop + 2, sBot - 2);

    // 取得の状況（ストリップ）
    o += `<text class="sub" x="${L - 6}" y="${stTop + stripH / 2 + 3.5}" text-anchor="end" style="font-size:9.5px">取得</text>`;
    vis.forEach((a, i) => {
      const p = Hd.per[a.id];
      const y = stTop + i * (stripRow + stripGap);
      let s = `<g class="strip-row${hl === a.id ? " hl" : ""}" data-id="${esc(a.id)}">`;
      const T = p.fw.T.length ? p.fw.T : p.fs.T;
      // 観測がある区間（取得なし・エラーは上から重ねる）
      const first = Math.max(t0, H0(Hd, a));
      const last = Math.max(T.length ? T[T.length - 1] : first, ...p.errors.map((e) => e.t));
      if (last > first) s += `<rect class="ok" x="${X(first)}" y="${y}" width="${Math.max(1, X(last) - X(first))}" height="${stripRow}" rx="1.5" style="fill:${a.col}"/>`;
      for (const [f, t] of p.gaps) if (t > t0) s += `<rect class="gp" x="${X(Math.max(f, t0))}" y="${y}" width="${Math.max(1, X(t) - X(Math.max(f, t0)))}" height="${stripRow}"/>`;
      for (const [f, t] of p.errBands) if (t > t0) s += `<rect class="er" x="${X(Math.max(f, t0))}" y="${y}" width="${Math.max(2, X(Math.min(t, t1)) - X(Math.max(f, t0)))}" height="${stripRow}" rx="1"/>`;
      s += `</g>`;
      o += s;
    });

    // x 軸
    o += `<g class="ax">`;
    for (const t of ticks) {
      const d = new Date(t * 1000);
      const mid = d.getHours() === 0 && d.getMinutes() === 0;
      const txt = mid ? (range === "24h" ? md(t) : mdw(t)) : clock(t);
      const x = X(t);
      if (x > L + pw - 78) continue;
      o += `<text x="${x}" y="${stBot + 15}" text-anchor="middle"${mid ? ' style="fill:var(--ink-2)"' : ""}>${txt}</text>`;
    }
    o += `<text x="${L + pw}" y="${stBot + 15}" text-anchor="end" style="fill:var(--ink-2);font-weight:600">いま ${clock(t1)}</text>`;
    o += `</g>`;

    // カーソル層とヒット領域
    o += `<g id="cur"></g><rect class="hit" x="${L}" y="${wTop}" width="${pw}" height="${stBot - wTop}"/>`;

    svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
    svg.classList.toggle("has-hl", !!hl);
    svg.innerHTML = o;
    G = { L, pw, W, Hh, t0, t1, X, Yw, Ys, wTop, wBot, sTop, sBot, stBot, vis };
    document.getElementById("spanlabel").textContent = `${mdw(t0)} ${clock(t0)} – ${mdw(t1)} ${clock(t1)}`;
  }
  function H0(Hd, a) {
    const p = Hd.per[a.id];
    const c = [p.fw.T[0], p.fs.T[0], p.errors.length ? p.errors[0].t : undefined].filter((x) => x != null);
    return c.length ? Math.min(...c) : Infinity;
  }

  // ---- 同期カーソルとツールチップ ---------------------------------------------------
  function onMove(e) {
    if (!G) return;
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (px < G.L || px > G.L + G.pw || py < G.wTop - 4 || py > G.stBot + 4) return onLeave();
    const Hd = HIST[range];
    let t = G.t0 + ((px - G.L) / G.pw) * (G.t1 - G.t0);
    // いちばん近い観測時刻に吸着
    let best = null;
    for (const a of G.vis) {
      const T = Hd.per[a.id].fw.T; const i = idxAtOrBefore(T, t);
      for (const j of [i, i + 1]) if (j >= 0 && j < T.length && (best === null || Math.abs(T[j] - t) < Math.abs(best - t))) best = T[j];
    }
    if (best !== null && Math.abs(best - t) < 1800) t = best;
    const x = G.X(t);
    let html = `<line class="cursor" x1="${x}" x2="${x}" y1="${G.wTop}" y2="${G.stBot}"/>`;
    const rows = [];
    let near = null, nearD = 12;
    for (const a of G.vis) {
      const p = Hd.per[a.id];
      const w = valAt(p.fw, t, a.tol), s = valAt(p.fs, t, a.tol);
      const err = p.errors.find((er) => Math.abs(er.t - t) <= a.tol / 3);
      const inErr = p.errBands.some(([f, tt]) => t >= f && t <= tt);
      if (w != null) { html += `<circle class="cdot" cx="${x}" cy="${G.Yw(w)}" r="4" style="fill:${a.col}"/>`; const d = Math.abs(G.Yw(w) - py); if (d < nearD) { nearD = d; near = a.id; } }
      if (s != null) { html += `<circle class="cdot" cx="${x}" cy="${G.Ys(s)}" r="3.5" style="fill:${a.col}"/>`; const d = Math.abs(G.Ys(s) - py); if (d < nearD) { nearD = d; near = a.id; } }
      rows.push({ a, w, s, note: inErr || err ? (err ? err.status : "エラー") : null });
    }
    // ストリップ上なら行で強調
    if (py >= G.stBot - G.vis.length * 7 && py <= G.stBot) {
      const i = Math.floor((py - (G.stBot - (G.vis.length * 7 - 2))) / 7);
      if (G.vis[i]) near = G.vis[i].id;
    }
    document.getElementById("cur").innerHTML = html;
    setHl(near, true);
    tip.innerHTML = `<div class="tip-h"><span>${mdw(t)} ${clock(t)}</span><span>${ago(t) === "たった今" ? "いま" : ago(t)}</span></div>` +
      `<table><thead><tr><th></th><th>週間</th><th>5h</th></tr></thead><tbody>` +
      rows.map((r) => `<tr class="${r.a.id === hl ? "hl" : ""}"><td><i class="lk" style="background:${r.a.col}"></i>${esc(r.a.label)}</td>` +
        (r.w == null && r.s == null
          ? `<td class="na" colspan="2">${r.note ? esc(r.note === "logged_out" ? "ログイン切れ" : r.note) : "取得なし"}</td>`
          : `<td class="${r.w == null ? "na" : ""}">${pct(r.w)}</td><td class="${r.s == null ? "na" : ""}">${pct(r.s)}</td>`) + `</tr>`).join("") +
      `</tbody></table>`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let tx = px + 16; if (tx + tw > G.W - 4) tx = px - 16 - tw;
    const ty = clamp(py - th / 2, 0, G.Hh - th);
    tip.style.left = tx + "px"; tip.style.top = ty + "px";
  }
  function onLeave() {
    tip.hidden = true;
    const c = document.getElementById("cur"); if (c) c.innerHTML = "";
    setHl(null, true);
  }
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);

  // 強調（再描画せず class だけ切り替える）
  function setHl(id, fromChart) {
    if (id === hl) return;
    hl = id;
    svg.classList.toggle("has-hl", !!hl);
    svg.querySelectorAll("[data-id]").forEach((g) => g.classList.toggle("hl", g.dataset.id === hl));
    railEl.querySelectorAll(".ri").forEach((li) => li.classList.toggle("hl", li.dataset.id === hl));
    document.querySelectorAll(".hg [data-row], .ev[data-row]").forEach((c) => c.classList.toggle("hlrow", c.dataset.row === hl));
    if (fromChart && !tip.hidden) tip.querySelectorAll("tbody tr").forEach((tr, i) => {
      const a = G.vis[i]; tr.classList.toggle("hl", !!a && a.id === hl);
    });
  }

  // ---- ピークのヒートマップ ----------------------------------------------------------
  function heat(el, rowsData, cols, title, sub, colLabels, kind) {
    const nameW = 70;
    let html = `<div class="heat-h"><h2>${title}</h2><span class="sub2">${sub}</span></div>` +
      `<div class="hg" style="grid-template-columns:${nameW}px repeat(${cols}, minmax(30px, 1fr))"><span></span>` +
      colLabels.map((c) => `<span class="ch">${c}</span>`).join("");
    for (const a of ACC) {
      const row = rowsData.find((r) => r.account_id === a.id);
      const ws = row ? row.windows : [];
      const cur = ws[0] && ws[0].resets_at > NOW;
      const cells = [];
      if (kind === "weekly") { if (!cur) cells.push(null); cells.push(...ws); }
      else cells.push(...ws);
      const off = hidden.has(a.id) ? " row-off" : "";
      html += `<span class="rn${off}${hl === a.id ? " hlrow" : ""}" data-row="${esc(a.id)}" style="--sc:${a.col}"><i></i>${esc(a.label)}</span>`;
      for (let i = 0; i < cols; i++) {
        const w = cells[i];
        if (!w) { html += `<span class="cell empty${off}">—</span>`; continue; }
        const p = w.peak_percent;
        const al = 0.03 + Math.pow(p / 100, 1.5) * 0.46;
        const isCur = w.resets_at > NOW;
        const from = kind === "weekly" ? w.resets_at - 7 * 86400 : w.resets_at - 5 * 3600;
        const tt = `${a.label} · ${mdw(from)} ${clock(from)} 〜 ${mdw(w.resets_at)} ${clock(w.resets_at)} · ピーク ${p}%${isCur ? "（進行中）" : ""}`;
        html += `<span class="cell${al > 0.34 ? " inv" : ""}${isCur ? " cur" : ""}${off}" style="--a:${al.toFixed(3)}" title="${esc(tt)}">${Math.round(p)}${p >= UI.danger_percent ? '<i class="dz"></i>' : ""}</span>`;
      }
    }
    el.innerHTML = html + `</div>`;
  }
  function renderHeats() {
    heat(document.getElementById("heatW"), DATA.windows_weekly.rows, 6, "週ごとのピーク", "週間枠の最大 %", ["今週", "1週前", "2週前", "3週前", "4週前", "5週前"], "weekly");
    heat(document.getElementById("heatS"), DATA.windows_session.rows, 8, "5時間枠のピーク", "直近8枠・新しい順", ["最新", "2", "3", "4", "5", "6", "7", "8"], "session");
  }
  document.querySelector(".heats").addEventListener("mouseover", (e) => {
    const r = e.target.closest("[data-row]");
    setHl(r && !hidden.has(r.dataset.row) ? r.dataset.row : null);
  });
  document.querySelector(".heats").addEventListener("mouseleave", () => setHl(null));
  document.querySelector(".heats").addEventListener("click", (e) => { const r = e.target.closest("[data-row]"); if (r) toggle(r.dataset.row); });

  // ---- その他 ------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
  document.getElementById("refresh").onclick = (e) => {
    const b = e.currentTarget; b.classList.add("spin");
    setTimeout(() => { b.classList.remove("spin"); toast("全アカウントの取得を予約しました（デモ）"); }, 900);
  };
  document.getElementById("theme").onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
  };
  document.getElementById("cand").onclick = () => toast("設定画面で acct-e を追加できます（デモ）");

  function update() {
    if (hl && hidden.has(hl)) hl = null;
    renderRail(); renderUpcoming(); fitUpcoming(); renderRange(); renderChart(); renderHeats();
  }
  renderHeader();
  update();
  new ResizeObserver(() => renderChart()).observe(chartEl);

  // スクリーンショット用のフック
  window.__proto = { setHl, toggle, solo, at(x, y) { onMove({ clientX: x, clientY: y }); }, hover(fx, fy) {
    const r = svg.getBoundingClientRect();
    onMove({ clientX: r.left + G.L + G.pw * fx, clientY: r.top + fy * r.height });
  } };
})();
