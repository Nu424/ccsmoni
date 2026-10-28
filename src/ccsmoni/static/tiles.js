// タイル（アカウント1件）の DOM。
// 何を: 名前と状態の帯｜大きな数字（週間・5h・ペース差・メーター）｜週ピークのミニ柱｜ミニチャート｜1行のヒント（ログインの流れを含む）。
// なぜ: タイルはどの状態でも同じ大きさ・同じ段組みにする（ログイン切れでもグラフを残し、ヒントの行に［ログイン］を出す）。
// 方針:
//   - タイルの外枠とグラフ（Plot）は作り直さない。state が来るたびに、帯・数字・週ピーク・ヒントのそれぞれについて
//     「表示に効く値」から作ったキーを前回と比べ、変わった部分だけ作り直す（ポーリングのたびにフォーカスが外れないように）。
//   - 作り直すときも、フォーカスがその中にあれば、同じ役割の要素（data-fk）に戻す。
//   - 時刻の相対表示（○分前・あと○分）は app.js の毎秒の更新に任せる（data-ago / data-in / data-until）。

import { h, setChildren, icon, spinner, fmtAgo, fmtIn, fmtCountdown, fmtDateTime, fmtPct, loginRetaken, copyCmd, toast } from "./ui.js";
import { Plot } from "./chart.js";
import { api } from "./api.js";

const lim = (list, kind) => (list || []).find((l) => l.kind === kind);
const WEEK = 7 * 86400, H5 = 5 * 3600;
const NS = "http://www.w3.org/2000/svg";

// 作り直す前にフォーカスの場所を覚え、作り直したあとに同じ役割の要素へ戻す
function keepFocus(container, rebuild) {
  const ae = document.activeElement;
  const fk = ae && container.contains(ae) && ae.dataset ? ae.dataset.fk : null;
  rebuild();
  if (fk) { const el = container.querySelector(`[data-fk="${CSS.escape(fk)}"]`); el && el.focus({ preventScroll: true }); }
}

// ヒントの押し先: 5h のヒントなら今の 5h 枠、それ以外は今週
// （ヒントは limit の種類を持たないので、上限の見込みは eta_full がいちばん早い limit、使い残しは週間とみなす）
export function hintTarget(a, hint) {
  const limits = a.limits || [];
  let L = null;
  if (hint.kind === "will_hit_limit") {
    const cands = limits.filter((l) => l.pace && l.pace.eta_full != null).sort((p, q) => p.pace.eta_full - q.pace.eta_full);
    L = cands[0] || null;
    if (!L && /5時間/.test(hint.text)) L = lim(limits, "session");
  }
  if (!L) L = lim(limits, "weekly_all");
  if (!L || !L.resets_at) return null;
  const session = L.kind === "session";
  return { kind: session ? "session" : "weekly", start: L.resets_at - (session ? H5 : WEEK), label: session ? "今の 5時間枠" : "今週" };
}

export function createTile(id, env) {
  const head = h("header.t-head");
  const figs = h("div.t-figs");
  const chartEl = h("div.t-chart.plot");
  const hint = h("footer.t-hint");
  const el = h("article.tile", { dataset: { id } }, [head, figs, chartEl, hint]);
  const plot = new Plot(chartEl, "tile");
  plot.accountId = id;
  const ovl = chartEl.querySelector("canvas.ovl");
  ovl.tabIndex = 0;
  const prev = {};
  const keys = { head: "", figs: "", hint: "" };
  let popOpen = false;   // 手動ログインの説明
  let moreOpen = false;  // 「ほか n 件」のヒント
  let last = null;

  function update(a, { force = false } = {}) {
    last = a;
    const now = env.now();
    const ok = a.status === "ok";
    el.classList.toggle("is-bad", !ok && a.status !== "never");
    el.style.setProperty("--c", env.colorOf(a));
    el.classList.toggle("dup", !!a._dup);
    ovl.setAttribute("aria-label", `${a.label} の推移`);

    // ---- 1段目 ----
    const busy = env.busy().has(a.id);
    const hk = JSON.stringify([a.label, a.provider, a.plan, a.status, busy, a.stale, a.status_since, a.taken_at, a.enabled, !!a._dup]);
    if (force || hk !== keys.head) {
      keys.head = hk;
      keepFocus(head, () => setChildren(head,
        h("span.sw", { title: a._dup ? "ほかのアカウントと同じ色です（重ねる表示では破線）" : null }),
        h("h3", { title: a.id }, a.label),
        a.provider === "codex" ? h("span.plan.prov", { title: "Codex のアカウント" }, "Codex") : null,
        a.plan ? h("span.plan", a.plan.toUpperCase()) : null,
        stateBadge(a, now, busy),
        h("button.t-refresh", { type: "button", title: "このアカウントを今すぐ更新", "aria-label": `${a.label} を今すぐ更新`, dataset: { fk: "refresh" },
          disabled: busy || !a.enabled, onclick: () => env.refreshOne(a.id) }, icon("refresh")),
      ));
    }

    // ---- 2段目 ----
    const fk = JSON.stringify([figKey(a, "weekly_all", now), figKey(a, "session", now), peaksKey(a, now), env.sevKey()]);
    if (force || fk !== keys.figs) {
      keys.figs = fk;
      keepFocus(figs, () => setChildren(figs, fig(a, "weekly_all", now), fig(a, "session", now), peaks(a, now)));
    }
    syncTicks(a, now);

    // ---- 4段目 ----
    const lg = a.login;
    const ik = JSON.stringify([a.status, a.message, a.status_since, a.next_run_at, a.hints, lg, env.loginBusy.has(a.id), popOpen, moreOpen,
      a.taken_at, a.last_ok && a.last_ok.taken_at, a.launch_command, (a.limits || []).map((l) => [l.kind, l.resets_at, l.pace && l.pace.eta_full])]);
    if (force || ik !== keys.hint) {
      keys.hint = ik;
      keepFocus(hint, () => renderHint(a, now));
    }
  }

  function stateBadge(a, now, busy) {
    if (busy) return h("span.t-state.busy", [icon("refresh"), "取得中"]);
    const since = a.status_since ? h("span", { dataset: { ago: a.status_since } }, fmtAgo(a.status_since, now)) : null;
    if (a.status === "logged_out") return h("span.t-state.crit", { title: since ? `${fmtDateTime(a.status_since)} から` : null }, [icon("crit"), "ログイン切れ"]);
    if (a.status === "timeout") return h("span.t-state.crit", [icon("err"), "タイムアウト"]);
    if (a.status === "parse_error") return h("span.t-state.crit", { title: "出力の形式が変わった可能性があります" }, [icon("err"), "形式不明"]);
    if (a.status !== "ok" && a.status !== "never") return h("span.t-state.crit", [icon("err"), "取得エラー"]);
    if (a.status === "never") return h("span.t-state", [icon("clock"), "未取得"]);
    if (a.stale) return h("span.t-state.warn", { title: "最終取得が取得間隔の3倍より古い" }, [icon("clock"), h("span", { dataset: { ago: a.taken_at } }, fmtAgo(a.taken_at, now)), "の値"]);
    return h("span.t-state", { title: `最終取得 ${fmtDateTime(a.taken_at)}` }, h("span", { dataset: { ago: a.taken_at } }, fmtAgo(a.taken_at, now)));
  }

  // メーターの目盛り（均等に使った場合の位置）とペースの説明を、作り直さずに更新する
  function syncTicks(a, now) {
    for (const kind of ["weekly_all", "session"]) {
      const L = figLimit(a, kind);
      const f = figs.querySelector(`[data-fk="fig-${kind}"]`);
      if (!L || !f || !L.pace) continue;
      const tick = f.querySelector(".meter b");
      if (tick) tick.style.left = `${Math.min(100, L.pace.expected_percent)}%`;
      const pc = f.querySelector(".pc[data-pace]");
      if (pc) pc.title = `ペース: 均等に使った場合の位置 ${Math.round(L.pace.expected_percent)}% に対して ${fmtPct(L.percent)}`;
    }
  }
  function figLimit(a, kind) {
    return a.status === "ok" ? lim(a.limits, kind) : lim(a.last_ok && a.last_ok.limits, kind);
  }
  // 数字の欄の表示に効く値（時刻で変わるのは「拡大できるか」「目盛りを出すか」だけなので、その真偽を入れる）
  function figKey(a, kind, now) {
    const L = figLimit(a, kind);
    if (!L) return [a.status === "never"];
    const winLen = kind === "session" ? H5 : WEEK;
    const model = kind === "weekly_all" && a.status === "ok" ? (a.limits || []).find((l) => l.kind.startsWith("weekly_model:")) : null;
    // 目安の位置（expected_percent）は時間とともに少しずつ動くので、キーには表示する差（丸めた値）だけを入れ、
    // メーターの目盛りの位置は syncTicks() でその場で動かす
    return [a.status, L.percent, L.resets_at, L.pace && Math.round(L.percent - L.pace.expected_percent), a.last_ok && a.last_ok.taken_at,
      !!L.resets_at && L.resets_at > now - winLen, !!L.resets_at && L.resets_at > now, model && [model.kind, model.label, model.percent]];
  }

  function fig(a, kind, now) {
    const ok = a.status === "ok";
    const L = figLimit(a, kind);
    const name = kind === "session" ? "5h" : "週間";
    if (!L) {
      return h("div.fig.stale", [h("div.fig-l", [h("span.k", name), h("span", a.status === "never" ? "未取得" : "—")]),
        h("div.fig-v", h("span.v", "—")), h("div.meter")]);
    }
    const p = L.percent;
    let rs;
    if (!L.resets_at) rs = h("span.rs", "未開始");
    else {
      const cd = fmtCountdown(L.resets_at, now);
      rs = h("span.rs.num", { dataset: { until: L.resets_at }, title: `リセット ${fmtDateTime(L.resets_at)}` }, cd || "リセット済み（推定）");
    }
    const sv = ok ? env.sev(p) : "";
    const extra = [];
    if (sv) extra.push(h("span.sev", { class: sv }, [icon(sv === "crit" ? "crit" : "warn"), sv === "crit" ? "上限間近" : "注意"]));
    else if (ok && L.pace) {
      const d = Math.round(p - L.pace.expected_percent);
      // 狭いタイルでは「ペース」の文字を、メーターの目盛りと同じ形の記号に置き換える（CSS で切り替え）
      extra.push(h("span.pc", { class: d > 5 ? "over" : "", dataset: { pace: "1" }, title: `ペース: 均等に使った場合の位置 ${Math.round(L.pace.expected_percent)}% に対して ${fmtPct(p)}` },
        [h("span.pw", "ペース "), paceIcon(), h("b", `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}`)]));
    } else if (!ok && a.last_ok) extra.push(h("span.pc", [h("span", { dataset: { ago: a.last_ok.taken_at } }, fmtAgo(a.last_ok.taken_at, now)), "の値"]));
    const model = kind === "weekly_all" && ok ? (a.limits || []).find((l) => l.kind.startsWith("weekly_model:")) : null;
    if (model && !sv) extra.push(h("span.pc", { title: `${model.label}` }, [model.kind.split(":")[1].replace(/^./, (c) => c.toUpperCase()), " ", h("b", fmtPct(model.percent))]));
    const changed = prev[kind] != null && prev[kind] !== p;
    prev[kind] = p;
    const vEl = h("span.v", { class: changed ? "bump" : "" }, [String(Math.round(p)), h("small", "%")]);
    const tick = ok && L.pace && L.resets_at > now ? h("b", { style: { left: `${Math.min(100, L.pace.expected_percent)}%` } }) : null;
    // 押すと、その枠（今週・今の 5h）の始まりから今までに拡大する
    const winLen = kind === "session" ? H5 : WEEK;
    const zoomable = !!L.resets_at && L.resets_at > now - winLen;
    return h("div.fig", {
      class: `${ok ? "" : "stale"} ${zoomable ? "zoomable" : ""}`,
      role: zoomable ? "button" : null, tabindex: zoomable ? "0" : null, dataset: { fk: `fig-${kind}` },
      title: zoomable ? `押すと${kind === "session" ? "今の 5時間枠" : "今週"}の推移に拡大` : null,
      onclick: zoomable ? () => env.zoomTo(L.resets_at - winLen, Math.min(env.now(), L.resets_at), a.id) : null,
      onkeydown: zoomable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } : null,
    }, [
      h("div.fig-l", [h("span.k", name), rs]),
      h("div.fig-v", [vEl, ...extra]),
      h("div.meter", [h("i", { class: sv, style: { width: `${Math.max(p > 0 ? 1.5 : 0, Math.min(100, p))}%` } }), tick]),
    ]);
  }
  function paceIcon() {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 12 12"); s.setAttribute("class", "pwi"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = '<rect x="0.5" y="4.5" width="11" height="3" rx="1.5" fill="var(--track)"/><rect x="0.5" y="4.5" width="5" height="3" rx="1.5" fill="var(--ink-3)"/><rect x="6.6" y="1.5" width="1.6" height="9" rx=".8" fill="var(--ink)"/>';
    return s;
  }

  // 週ピーク: 進行中かどうかは resets_at と今で決める（ログイン切れのあいだ current が更新されないことがあるため）
  const peakList = (a) => (a.weekly_peaks || []).slice(-6);
  function peaksKey(a, now) {
    return peakList(a).map((w) => [w.resets_at, w.peak_percent, w.resets_at > now]);
  }
  function peaks(a, now) {
    const ws = peakList(a);
    const W = 92, H = 28, n = 6, cw = 10, gap = (W - n * cw) / (n - 1);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const rect = (attrs) => { const r = document.createElementNS(NS, "rect"); for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v); svg.append(r); return r; };
    for (let i = 0; i < n; i++) {
      const w = ws[i - (n - ws.length)];
      const x = i * (cw + gap);
      rect({ class: "trk", x, y: 0, width: cw, height: H, rx: 2 });
      if (!w) continue;
      const cur = w.resets_at > now;
      const hh = Math.max(1.5, (w.peak_percent / 100) * H);
      rect({ class: `pk ${cur ? "cur" : env.sev(w.peak_percent)}`, x: x + (cur ? 0.6 : 0), y: H - hh + (cur ? 0.6 : 0), width: cw - (cur ? 1.2 : 0), height: Math.max(0.5, hh - (cur ? 1.2 : 0)), rx: 2 });
      const hit = rect({ class: "hit", x: x - gap / 2, y: -4, width: cw + gap, height: H + 8 });
      hit.dataset.pk = `${w.resets_at - WEEK},${w.resets_at},${w.peak_percent},${cur ? 1 : 0}`;
      hit.dataset.acct = a.id;
    }
    const prevW = ws.filter((w) => !(w.resets_at > now)).pop();
    return h("div.peaks", [h("div.lbl", [h("span", "週ピーク"), prevW ? h("span", ["前週 ", h("b", fmtPct(prevW.peak_percent))]) : null]), svg]);
  }

  // ---- ヒントの行（ログインの流れはここに収める。タイルの大きさは変えない） ----
  function renderHint(a, now) {
    hint.className = "t-hint";
    const lg = a.login;
    const retaking = !!lg && lg.state === "done" && !loginRetaken(a);
    const loginRow = a.status === "logged_out" || (lg && !(lg.state === "done" && !retaking && a.status !== "logged_out"));
    if (loginRow) return renderLogin(a, lg, retaking, now);
    popOpen = false;
    if (a.status === "never") { moreOpen = false; hint.classList.add("none"); return setChildren(hint, icon("clock"), h("span", "まだ取得していません。少し待つか、今すぐ更新してください")); }
    if (a.status !== "ok") {
      moreOpen = false;
      hint.classList.add("crit");
      return setChildren(hint, icon("err"), h("span", { title: a.message || "" }, [a.message || "取得に失敗しました",
        a.status_since ? [" · ", h("span", { dataset: { ago: a.status_since } }, fmtAgo(a.status_since, now)), "から"] : null]));
    }
    const hs = a.hints || [];
    if (!hs.length) {
      moreOpen = false;
      hint.classList.add("none");
      return setChildren(hint, icon("ok"), h("span", ["ペースどおり", a.next_run_at ? [" · 次の取得 ", h("span", { dataset: { in: a.next_run_at } }, fmtIn(a.next_run_at, now))] : null]));
    }
    const k = hs[0].kind === "use_it_or_lose_it" ? "tip" : "warn";
    hint.classList.add(k, "zoomable");
    const zoomBtn = (x, cls, fkey) => {
      const tg = hintTarget(a, x);
      return h(cls, {
        type: "button", dataset: { fk: fkey }, title: `${x.text}${tg ? `\n（押すと${tg.label}の推移に拡大）` : ""}`,
        onclick: (e) => { e.stopPropagation(); if (tg) { moreOpen = false; env.zoomTo(tg.start, env.now(), a.id); update(last); } },
      }, [icon(x.kind === "use_it_or_lose_it" ? "tip" : "warn"), h("span", x.text), tg ? icon("zoom", "i zi") : null]);
    };
    if (hs.length < 2) moreOpen = false;
    // 「ほか n 件」: 押すと（タッチでも）残りのヒントを開く。それぞれ押すと、その枠に拡大する
    const more = hs.length > 1 ? h("button.more", { type: "button", "aria-expanded": String(moreOpen), dataset: { fk: "more" },
      title: hs.slice(1).map((x) => x.text).join("\n"),
      onclick: (e) => { e.stopPropagation(); moreOpen = !moreOpen; update(last); } }, `ほか ${hs.length - 1} 件`) : null;
    const pop = moreOpen ? h("div.pop.pop-hints", { role: "dialog", "aria-label": "ほかのヒント", onclick: (e) => e.stopPropagation() },
      hs.slice(1).map((x, i) => zoomBtn(x, "button.hint-btn", `more-${i}`))) : null;
    setChildren(hint, zoomBtn(hs[0], "button.hint-btn", "hint"), more, pop);
  }

  function renderLogin(a, lg, retaking, now) {
    moreOpen = false;
    hint.classList.add("login");
    const waitingLocal = env.loginBusy.has(a.id) && !(lg && lg.state === "waiting");
    const loginBtn = (label) => h("button.btn.sm", { type: "button", dataset: { fk: "login" }, onclick: async () => {
      env.loginBusy.add(a.id);
      update(a);
      try { await api.login(a.id); env.refreshState(); }
      catch (err) { toast(err.message || "ログインを始められませんでした", "danger"); }
      setTimeout(() => { env.loginBusy.delete(a.id); }, 3000);
    } }, label);
    const manualBtn = h("button.man-btn", { type: "button", "aria-expanded": String(popOpen), title: "手動でログインする方法", dataset: { fk: "manual" },
      onclick: (e) => { e.stopPropagation(); popOpen = !popOpen; update(last); } }, "手動");
    const pop = popOpen ? h("div.pop", { role: "dialog", "aria-label": "手動でログインする方法", onclick: (e) => e.stopPropagation() }, [
      ...(a.provider === "codex" ? [
        h("p", "手動でするなら、このアカウントの設定フォルダを CODEX_HOME にして:"),
        h("div.pop-row", [a.launch_command ? copyCmd(a.launch_command) : h("code", "codex login")]),
      ] : [
        h("p", a.launch_command ? "手動でするなら、起動してから /login:" : "このアカウントの設定フォルダで claude を起動して /login:"),
        h("div.pop-row", [a.launch_command ? copyCmd(a.launch_command) : h("code", "claude"), h("span", "→"), h("code", "/login")]),
      ]),
    ]) : null;
    let kids;
    if (retaking) { hint.classList.add("okk"); kids = [spinner(), h("span", "ログインしました。取り直しています…")]; }
    else if (lg && lg.state === "mismatch") {
      hint.classList.replace("login", "warn");
      kids = [icon("warn"), h("span", { title: "使用率が別のアカウントのものになっていないか確かめてください" }, [h("b", "別のアカウントでログインした可能性"), " · 値を確かめてください"])];
    } else if (waitingLocal) kids = [spinner(), h("span", "PC 側でログイン画面を開いています…")];
    else if (lg && lg.state === "waiting") {
      kids = [spinner(), h("span", { title: lg.message || "" }, [h("b", "PC 側でログインしてください…"), " ", h("span.muted", { dataset: { ago: lg.started_at } }, fmtAgo(lg.started_at, now))]), h("span.grow"), manualBtn];
    } else if (lg && (lg.state === "failed" || lg.state === "timeout")) {
      hint.classList.add("crit");
      kids = [icon("crit"), h("span", { title: lg.message || "" }, lg.state === "timeout" ? "時間内にログインが終わりませんでした" : (lg.message || "ログインに失敗しました")), h("span.grow"), manualBtn, loginBtn("もう一度")];
    } else {
      hint.classList.add("crit");
      const from = a.status_since || (a.last_ok && a.last_ok.taken_at);
      kids = [icon("crit"), h("span", [h("b", "ログイン切れ"), from ? [" · ", h("span", { dataset: { ago: from } }, fmtAgo(from, now)), "から"] : null]),
        h("span.grow"), manualBtn, loginBtn("ログイン")];
    }
    setChildren(hint, ...kids, pop);
  }

  return {
    el, plot, update,
    // 開いているポップオーバー（手動ログイン・ほかのヒント）を閉じる。閉じたら true
    closePop() {
      if (!popOpen && !moreOpen) return false;
      popOpen = false; moreOpen = false;
      if (last) update(last);
      return true;
    },
    destroy() { plot.destroy(); },
  };
}
