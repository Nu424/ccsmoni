// タイル（アカウント1件）の DOM。
// 何を: 名前と状態の帯｜大きな数字（週間・5h・ペース差・メーター）｜週ピークのミニ柱｜ミニチャート｜1行のヒント（ログインの流れを含む）。
// なぜ: タイルはどの状態でも同じ大きさ・同じ段組みにする（ログイン切れでもグラフを残し、ヒントの行に［ログイン］を出す）。
// 方針: タイルの外枠とグラフ（Plot）は作り直さず、state が来るたびに帯・数字・ヒントの中身だけを入れ替える。

import { h, setChildren, icon, spinner, fmtAgo, fmtIn, fmtCountdown, fmtDateTime, fmtDate, fmtPct, loginRetaken, copyCmd, toast } from "./ui.js";
import { Plot } from "./chart.js";
import { api } from "./api.js";

const lim = (list, kind) => (list || []).find((l) => l.kind === kind);
const WEEK = 7 * 86400, H5 = 5 * 3600;

export function createTile(id, env) {
  const head = h("header.t-head");
  const figs = h("div.t-figs");
  const chartEl = h("div.t-chart.plot");
  const hint = h("footer.t-hint");
  const el = h("article.tile", { dataset: { id } }, [head, figs, chartEl, hint]);
  const plot = new Plot(chartEl, "tile");
  plot.accountId = id;
  const prev = {};
  let popOpen = false;

  function update(a) {
    const now = env.now();
    const ok = a.status === "ok";
    el.classList.toggle("is-bad", !ok && a.status !== "never");
    el.style.setProperty("--c", env.colorOf(a));
    chartEl.querySelector("canvas.ovl").setAttribute("aria-label", `${a.label} の推移`);
    chartEl.querySelector("canvas.ovl").tabIndex = 0;

    // ---- 1段目 ----
    setChildren(head,
      h("span.sw"),
      h("h3", { title: a.id }, a.label),
      a.plan ? h("span.plan", a.plan.toUpperCase()) : null,
      stateBadge(a, now),
      h("button.t-refresh", { type: "button", title: "このアカウントを今すぐ更新", "aria-label": `${a.label} を今すぐ更新`,
        disabled: env.busy().has(a.id) || !a.enabled, onclick: () => env.refreshOne(a.id) }, icon("refresh")),
    );

    // ---- 2段目 ----
    setChildren(figs, fig(a, "weekly_all", now), fig(a, "session", now), peaks(a, now));

    // ---- 4段目 ----
    renderHint(a, now);
  }

  function stateBadge(a, now) {
    if (env.busy().has(a.id)) return h("span.t-state.busy", [icon("refresh"), "取得中"]);
    const since = a.status_since ? h("span", { dataset: { ago: a.status_since } }, fmtAgo(a.status_since, now)) : null;
    if (a.status === "logged_out") return h("span.t-state.crit", { title: since ? `${fmtDateTime(a.status_since)} から` : null }, [icon("crit"), "ログイン切れ"]);
    if (a.status === "timeout") return h("span.t-state.crit", [icon("err"), "タイムアウト"]);
    if (a.status === "parse_error") return h("span.t-state.crit", { title: "出力の形式が変わった可能性があります" }, [icon("err"), "形式不明"]);
    if (a.status !== "ok" && a.status !== "never") return h("span.t-state.crit", [icon("err"), "取得エラー"]);
    if (a.status === "never") return h("span.t-state", [icon("clock"), "未取得"]);
    if (a.stale) return h("span.t-state.warn", { title: "最終取得が取得間隔の3倍より古い" }, [icon("clock"), h("span", { dataset: { ago: a.taken_at } }, fmtAgo(a.taken_at, now)), "の値"]);
    return h("span.t-state", { title: `最終取得 ${fmtDateTime(a.taken_at)}` }, h("span", { dataset: { ago: a.taken_at } }, fmtAgo(a.taken_at, now)));
  }

  function fig(a, kind, now) {
    const ok = a.status === "ok";
    const L = ok ? lim(a.limits, kind) : lim(a.last_ok && a.last_ok.limits, kind);
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
      extra.push(h("span.pc", { class: d > 5 ? "over" : "", title: `均等に使った場合の位置 ${Math.round(L.pace.expected_percent)}% に対して ${fmtPct(p)}` },
        [h("span.pw", "ペース "), h("b", `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}`)]));
    } else if (!ok && a.last_ok) extra.push(h("span.pc", [h("span", { dataset: { ago: a.last_ok.taken_at } }, fmtAgo(a.last_ok.taken_at, now)), "の値"]));
    const model = kind === "weekly_all" && ok ? (a.limits || []).find((l) => l.kind.startsWith("weekly_model:")) : null;
    if (model && !sv) extra.push(h("span.pc", { title: `${model.label}` }, [model.kind.split(":")[1].replace(/^./, (c) => c.toUpperCase()), " ", h("b", fmtPct(model.percent))]));
    const key = `${kind}`;
    const changed = prev[key] != null && prev[key] !== p;
    prev[key] = p;
    const vEl = h("span.v", { class: changed ? "bump" : "" }, [String(Math.round(p)), h("small", "%")]);
    const tick = ok && L.pace && L.resets_at > now ? h("b", { style: { left: `${Math.min(100, L.pace.expected_percent)}%` } }) : null;
    // 押すと、その枠（今週・今の 5h）の始まりから今までに拡大する
    const winLen = kind === "session" ? H5 : WEEK;
    const zoomable = !!L.resets_at && L.resets_at > now - winLen;
    return h("div.fig", {
      class: `${ok ? "" : "stale"} ${zoomable ? "zoomable" : ""}`,
      role: zoomable ? "button" : null, tabindex: zoomable ? "0" : null,
      title: zoomable ? `押すと${kind === "session" ? "今の 5時間枠" : "今週"}の推移に拡大` : null,
      onclick: zoomable ? () => env.zoomTo(L.resets_at - winLen, Math.min(now, L.resets_at), a.id) : null,
      onkeydown: zoomable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } : null,
    }, [
      h("div.fig-l", [h("span.k", name), rs]),
      h("div.fig-v", [vEl, ...extra]),
      h("div.meter", [h("i", { class: sv, style: { width: `${Math.max(p > 0 ? 1.5 : 0, Math.min(100, p))}%` } }), tick]),
    ]);
  }

  function peaks(a, now) {
    const ws = (a.weekly_peaks || []).slice(-6);
    const W = 92, H = 28, n = 6, cw = 10, gap = (W - n * cw) / (n - 1);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const rect = (attrs) => { const r = document.createElementNS(NS, "rect"); for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v); svg.append(r); return r; };
    for (let i = 0; i < n; i++) {
      const w = ws[i - (n - ws.length)];
      const x = i * (cw + gap);
      rect({ class: "trk", x, y: 0, width: cw, height: H, rx: 2 });
      if (!w) continue;
      const cur = !!w.current;
      const hh = Math.max(1.5, (w.peak_percent / 100) * H);
      rect({ class: `pk ${cur ? "cur" : env.sev(w.peak_percent)}`, x: x + (cur ? 0.6 : 0), y: H - hh + (cur ? 0.6 : 0), width: cw - (cur ? 1.2 : 0), height: Math.max(0.5, hh - (cur ? 1.2 : 0)), rx: 2 });
      const hit = rect({ class: "hit", x: x - gap / 2, y: -4, width: cw + gap, height: H + 8 });
      hit.dataset.pk = `${w.resets_at - WEEK},${w.resets_at},${w.peak_percent},${cur ? 1 : 0}`;
      hit.dataset.acct = a.id;
    }
    const prevW = ws.filter((w) => !w.current).pop();
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
    if (a.status === "never") { hint.classList.add("none"); return setChildren(hint, icon("clock"), h("span", "まだ取得していません。少し待つか、今すぐ更新してください")); }
    if (a.status !== "ok") {
      hint.classList.add("crit");
      return setChildren(hint, icon("err"), h("span", { title: a.message || "" }, [a.message || "取得に失敗しました",
        a.status_since ? [" · ", h("span", { dataset: { ago: a.status_since } }, fmtAgo(a.status_since, now)), "から"] : null]));
    }
    const hs = a.hints || [];
    if (!hs.length) {
      hint.classList.add("none");
      return setChildren(hint, icon("ok"), h("span", ["ペースどおり", a.next_run_at ? [" · 次の取得 ", h("span", { dataset: { in: a.next_run_at } }, fmtIn(a.next_run_at, now))] : null]));
    }
    const k = hs[0].kind === "use_it_or_lose_it" ? "tip" : "warn";
    hint.classList.add(k, "zoomable");
    const wk = lim(a.limits, "weekly_all");
    const more = hs.length > 1 ? h("span.more", { title: hs.slice(1).map((x) => x.text).join("\n") }, `ほか ${hs.length - 1} 件`) : null;
    const btn = h("button.hint-btn", {
      type: "button", title: `${hs.map((x) => x.text).join("\n")}\n（押すと今週の推移に拡大）`,
      onclick: () => { if (wk && wk.resets_at) env.zoomTo(wk.resets_at - WEEK, now, a.id); },
    }, [icon(k === "tip" ? "tip" : "warn"), h("span", hs[0].text), icon("zoom", "i zi")]);
    setChildren(hint, btn, more);
  }

  function renderLogin(a, lg, retaking, now) {
    hint.classList.add("login");
    const waitingLocal = env.loginBusy.has(a.id) && !(lg && lg.state === "waiting");
    const loginBtn = (label) => h("button.btn.sm", { type: "button", onclick: async () => {
      env.loginBusy.add(a.id);
      update(a);
      try { await api.login(a.id); env.refreshState(); }
      catch (err) { toast(err.message || "ログインを始められませんでした", "danger"); }
      setTimeout(() => { env.loginBusy.delete(a.id); }, 3000);
    } }, label);
    const manualBtn = h("button.man-btn", { type: "button", "aria-expanded": String(popOpen), title: "手動でログインする方法",
      onclick: (e) => { e.stopPropagation(); popOpen = !popOpen; renderHint(a, env.now()); } }, "手動");
    const pop = popOpen ? h("div.pop", { role: "dialog", "aria-label": "手動でログインする方法", onclick: (e) => e.stopPropagation() }, [
      h("p", a.launch_command ? "手動でするなら、起動してから /login:" : "このアカウントの設定フォルダで claude を起動して /login:"),
      h("div.pop-row", [a.launch_command ? copyCmd(a.launch_command) : h("code", "claude"), h("span", "→"), h("code", "/login")]),
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

  return { el, plot, update, closePop() { if (popOpen) { popOpen = false; return true; } return false; } };
}

