// 推移画面（トップ。PLAN §6.1、U1・U2・U3）。
// 何を: 現在値のカード、推移グラフ（重ね合わせ／分割）、週ごとのピーク表、未登録アカウントのお知らせ。
// なぜ: 「最近どのアカウントをどれくらい使っているか」をひと目で見せ、ログイン切れはその場で直せるようにする。
// 方針: 画面の状態は dash オブジェクト1つ。変わった部分の render*() だけを呼ぶ。
//       グラフは重いので、データ・種類・期間・テーマが変わったときだけ作り直し、
//       表示／非表示と強調は作り直さずに切り替える。

import { api } from "./api.js";
import { h, setChildren, bar, statusChip, chip, segmented, spinner, toast, copyCmd, fmtPct, fmtAgo, fmtCountdown, fmtDate,
  fmtDateTime, loadPref, savePref, readableColor, cssVar, level, loginRetaken } from "./ui.js";
import { overlayChart, multiplesChart } from "./chart.js";

const KIND_OPTS = [{ value: "weekly_all", label: "週間" }, { value: "session", label: "5h" }];
const RANGE_OPTS = [{ value: "24h", label: "24h" }, { value: "7d", label: "7日" }, { value: "30d", label: "30日" }];
const MODE_OPTS = [{ value: "overlay", label: "重ねる" }, { value: "multi", label: "分ける" }];

export function createDashboard(ctx) {
  const dash = {
    kind: loadPref("chart.kind", "weekly_all"),
    range: loadPref("chart.range", "7d"),
    mode: loadPref("chart.mode", "overlay"),
    hidden: new Set(loadPref("chart.hidden", [])),
    focus: null,
    focusUnhid: null,     // カードを押して強調するために、一時的に表示に戻したアカウント（強調を解いたら非表示に戻す）
    archShown: new Set(), // 表示中のアーカイブ（設定から外したアカウントの履歴）。既定は非表示で、保存もしない
    history: null, historyKey: null, historyLoading: false, historyError: null,
    windows: null,
    showDisabled: false,
    dismissed: new Set(loadPref("candidates.dismissed", [])),
    loginBusy: new Set(), // ［ログイン］を押して、サーバーの login が見えるまで
  };
  let server = null;
  let root, cardsEl, noticeEl, chartHost, legendEl, ctrlEl, peaksEl, chartNote, chartInfo;
  let chart = null;
  let lastRunSeen = null;
  let historySeq = 0;     // 古い応答で新しい期間の表示を上書きしないための番号
  let legendSig = null;   // 凡例の DOM を作ったときの中身（変わったときだけ作り直す）
  let legendTail = null;
  let chartSig = null;    // グラフを作ったときに並べたアカウント（変わったら作り直す）
  const plotSig = () => JSON.stringify(plotAccounts(true).map((a) => [a.id, a.color, !!a.archived]));

  // ---- 骨組み ----------------------------------------------------------------
  function mount(el) {
    noticeEl = h("div.notice-slot");
    cardsEl = h("section.cards", { "aria-label": "アカウントの現在値" });
    ctrlEl = h("div.panel-ctrl");
    legendEl = h("div.legend", { role: "group", "aria-label": "表示するアカウント" });
    chartHost = h("div.chart-host");
    chartInfo = h("p.chart-info", { hidden: true });
    chartNote = h("div.chart-note");
    peaksEl = h("section.panel.peaks", { "aria-label": "週ごとのピーク" });
    root = h("div.dash", [
      noticeEl,
      cardsEl,
      h("section.panel.chart-panel", [
        h("div.panel-head", [h("h2", "推移"), ctrlEl]),
        legendEl,
        chartInfo,
        chartHost,
        chartNote,
      ]),
      peaksEl,
    ]);
    el.append(root);
    renderControls();
    window.addEventListener("ccsmoni:theme", onTheme);
    loadHistory();
    loadWindows();
  }
  function unmount() {
    window.removeEventListener("ccsmoni:theme", onTheme);
    chart && chart.destroy();
    chart = null;
  }
  function onTheme() { renderChart(); renderCards(); renderPeaks(); }

  function onState(s) {
    server = s;
    renderCards();
    renderNotice();
    renderLegend();
    // 新しい取得結果が入ったら、グラフと表も取り直す（取得中は待つ）
    const lr = s.collector.last_run_at;
    if (lastRunSeen != null && lr !== lastRunSeen && !s.collector.busy.length) {
      loadHistory(true);
      loadWindows();
    }
    if (!s.collector.busy.length) lastRunSeen = lr;
    // 並ぶアカウント（追加・削除でアーカイブに移った等）が変わったら、グラフも作り直す
    if (!dash.history || (chartSig != null && chartSig !== plotSig())) renderChart();
    if (dash.windows) renderPeaks();
  }

  // ---- データの読み込み -----------------------------------------------------------
  // quiet: 新しい取得結果が入ったときの裏での取り直し（同じ期間）。失敗しても今のグラフは正しいので残す。
  // 期間を切り替えたとき（quiet でない）に失敗したら、古い期間のグラフは消して「取得できませんでした」を出す
  // （残すと、新しい期間のラベルのまま古いグラフが見えてしまう）。
  async function loadHistory(quiet = false) {
    const key = dash.range;
    const seq = ++historySeq;
    if (!quiet) { dash.historyLoading = true; renderChartLoading(); }
    try {
      const data = await api.history(key, ["weekly_all", "session"]);
      if (seq !== historySeq || key !== dash.range) return; // 途中で期間が変わった・新しい取得が始まった
      dash.history = data;
      dash.historyKey = key;
      dash.historyError = null;
    } catch (e) {
      if (seq !== historySeq || key !== dash.range) return;
      if (quiet && dash.history && dash.historyKey === key) return;
      dash.history = null;
      dash.historyKey = null;
      dash.historyError = e.message || "サーバーに接続できません";
    }
    dash.historyLoading = false;
    renderChart();
  }
  async function loadWindows() {
    try {
      dash.windows = await api.windows("weekly_all", 8);
      renderPeaks();
    } catch { /* 表は補助なので、失敗しても黙って前のままにする */ }
  }

  // ---- 現在値のカード ----------------------------------------------------------------
  function renderCards() {
    if (!server || !cardsEl) return;
    const now = ctx.now();
    const busy = new Set(server.collector.busy);
    const enabled = server.accounts.filter((a) => a.enabled);
    const disabled = server.accounts.filter((a) => !a.enabled);
    const list = [...enabled.map((a) => card(a, now, busy))];
    if (!server.accounts.length) {
      list.push(h("div.empty-card", [h("b", "アカウントがまだありません。"), " ", h("a", { href: "#/settings" }, "設定で追加する")]));
    }
    if (disabled.length) {
      list.push(h("button.disabled-toggle", {
        type: "button", "aria-expanded": String(dash.showDisabled),
        onclick: () => { dash.showDisabled = !dash.showDisabled; renderCards(); },
      }, dash.showDisabled ? `無効なアカウントを隠す` : `無効なアカウント ${disabled.length}件`));
      if (dash.showDisabled) list.push(...disabled.map((a) => card(a, now, busy)));
    }
    setChildren(cardsEl, ...list);
  }

  function card(a, now, busy) {
    const ui = server.ui;
    const color = readableColor(a.color, cssVar("--surface") || "#fff");
    const ok = a.status === "ok";
    const shown = ok ? a.limits : a.last_ok ? a.last_ok.limits : [];
    const lim = (k) => shown.find((l) => l.kind === k);
    const isFocus = dash.focus === a.id;
    const staleShown = a.enabled && a.stale && a.status !== "never";

    const head = h("div.card-head", [
      h("span.sw", { style: { background: color } }),
      h("span.card-name", a.label),
      a.plan ? h("span.badge", a.plan.toUpperCase()) : null,
      h("span.grow"),
      busy.has(a.id) ? h("span.card-busy", { title: "取得中" }, spinner()) : null,
      // 無効なアカウントは取りに行っていないので、古くて当然（「データが古い」は出さない）
      staleShown ? statusChip("stale") : null,
      a.status !== "ok" || !staleShown ? statusChip(a.status) : null,
    ]);

    const rows = [];
    for (const [k, name] of [["session", "5h"], ["weekly_all", "週間"]]) {
      const l = lim(k);
      if (!l) {
        if (ok) rows.push(meterRow(name, null, null, null, ui, false, k === "session" ? "枠はまだ始まっていません" : "—"));
        continue;
      }
      rows.push(meterRow(name, l.percent, l.pace && l.pace.expected_percent, l.resets_at, ui, !ok,
        null, !l.resets_at && !l.percent ? "未開始" : ""));
    }

    const body = [];
    if (a.status === "never") body.push(h("p.card-msg", "まだ取得していません。少し待つか、今すぐ更新してください。"));
    else if (!ok) {
      if (a.last_ok) body.push(h("p.card-sub", ["前回わかった値（", h("span", { dataset: { ago: a.last_ok.taken_at } }, fmtAgo(a.last_ok.taken_at, now)), "）"]));
      else body.push(h("p.card-msg", "まだ値がわかっていません。"));
    }
    body.push(...rows);
    if (!ok && a.message && a.status !== "logged_out") body.push(h("p.card-msg.tone-text-warn", a.message));
    if (a.status === "parse_error") body.push(h("p.card-msg", "出力の形式が変わった可能性があります。"));

    const loginEl = loginBlock(a);
    const hint = a.hints && a.hints[0];

    const el = h("article.card", {
      class: [ok ? "" : "is-bad", !a.enabled ? "is-disabled" : "", isFocus ? "is-focus" : "", dash.focus && !isFocus ? "is-dim" : ""].join(" "),
      style: { "--acct": color },
      tabindex: "0",
      role: "button",
      "aria-pressed": String(isFocus),
      "aria-label": `${a.label}。押すとグラフで強調します`,
      onclick: () => toggleFocus(a.id),
      onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); toggleFocus(a.id); } },
    }, [
      head,
      h("div.card-body", body),
      loginEl,
      hint ? h("p.hint", { class: `hint-${hint.kind}`, title: a.hints.map((x) => x.text).join("\n") }, [hintIcon(hint.kind), h("span", hint.text)]) : null,
    ]);
    return el;
  }

  // 「5h ▓▓▓░░ 47%  あと 1:12」の1行
  function meterRow(name, pct, expected, resetsAt, ui, faded, emptyText, resetText = "") {
    const lv = level(pct, ui);
    return h("div.meter", { class: faded ? "is-faded" : "" }, [
      h("span.meter-name", name),
      pct == null ? h("span.meter-empty", emptyText || "—") : bar(pct, { ui, expected, faded }),
      h("span.meter-pct.num", { class: `lv-text-${lv}` }, pct == null ? "" : fmtPct(pct)),
      // 過ぎていたら is-past（毎秒の tick() と同じ判定を、最初の描画でもしておく。折り返しの CSS が効くように）
      h("span.meter-reset.num", resetsAt ? { dataset: { until: resetsAt }, title: `リセット ${fmtDateTime(resetsAt)}`,
        class: fmtCountdown(resetsAt, ctx.now()) ? "" : "is-past" } : {},
        resetsAt ? (fmtCountdown(resetsAt, ctx.now()) || "リセット済み（推定）") : resetText),
    ]);
  }

  function hintIcon(kind) {
    return h("span.hint-ic", { "aria-hidden": "true" }, kind === "will_hit_limit" ? "▲" : kind === "use_it_or_lose_it" ? "◆" : "•");
  }

  // ログインの流れ（PLAN §5.2）。ログイン切れのとき、またはログインを進めている途中に出す。
  // 完了（done）のあとは、取り直した結果が state に入るまで「取り直しています…」を出す。
  // そのあいだ status はまだ logged_out のままなので、ここで［ログイン］を出すと、終わったのにまた押させてしまう。
  function loginBlock(a) {
    const lg = a.login;
    const waitingLocal = dash.loginBusy.has(a.id) && !(lg && lg.state === "waiting");
    const retaking = !!lg && lg.state === "done" && !loginRetaken(a);
    if (a.status !== "logged_out" && !lg) return null;
    // 取り直しが済んで、ログイン切れでなくなった（または別の理由のエラーになった）なら、ここはもう出さない
    if (lg && lg.state === "done" && !retaking && a.status !== "logged_out") return null;
    const stop = (e) => e.stopPropagation();
    const manual = a.launch_command
      ? h("div.login-manual", [h("span", "手動でするなら、起動してから /login:"), copyCmd(a.launch_command), h("span", "→"), h("code.inline", "/login")])
      : h("div.login-manual", [h("span", "手動なら、このアカウントの設定フォルダで claude を起動して"), h("code.inline", "/login")]);
    const loginBtn = (label) => h("button.btn.btn-primary.btn-sm", {
      type: "button",
      onclick: async (e) => {
        e.stopPropagation();
        dash.loginBusy.add(a.id);
        renderCards();
        try {
          await api.login(a.id);
          ctx.refreshState();
        } catch (err) {
          toast(err.message || "ログインを始められませんでした", "danger");
        }
        setTimeout(() => { dash.loginBusy.delete(a.id); }, 3000);
      },
    }, label);

    let main;
    let showManual = a.status === "logged_out";
    if (retaking) {
      main = h("div.login-state.tone-text-ok", [spinner(), h("span", "ログインしました。取り直しています…")]);
      showManual = false;
    } else if (lg && lg.state === "mismatch") {
      // ログイン自体は済んでいる。押し直させず、確かめてもらうだけにする
      main = h("div.login-state.tone-box-warn", [h("span", [h("b", "前回と別のアカウントでログインした可能性があります。"), h("br"),
        h("span.muted", "使用率が別のアカウントのものになっていないか確かめてください。")])]);
      showManual = false;
    } else if (waitingLocal) {
      main = h("div.login-state", [spinner(), h("span", "PC 側でログイン画面を開いています…")]);
    } else if (!lg || lg.state === "done") {
      // done で取り直しも済んだのに、まだログイン切れ（別の設定フォルダでログインした等）なら、もう一度押せるようにする
      main = h("div.login-state", [loginBtn("ログイン"), h("span.muted", "PC にログイン画面を開きます")]);
    } else if (lg.state === "waiting") {
      main = h("div.login-state", [spinner(), h("span", [h("b", "PC 側でログインしてください…"),
        h("br"), h("span.muted", [lg.message || "", lg.message ? "・" : "", "開始 ", h("span", { dataset: { ago: lg.started_at } }, fmtAgo(lg.started_at, ctx.now()))])])]);
    } else {
      main = h("div.login-state.tone-box-danger", [h("span", lg.state === "timeout" ? "時間内にログインが終わりませんでした。" : (lg.message || "ログインに失敗しました。")), loginBtn("もう一度")]);
    }
    return h("div.login", { onclick: stop }, [main, showManual ? manual : null]);
  }

  // カードを押す → 強調。もう一度押す → 元に戻す。
  // 凡例で非表示にしていたら、強調しているあいだだけ表示に戻す（押したのに見えないのを防ぐ）。
  // 強調を解いたら（別のカードに移ったときも）、元の非表示に戻す。
  function toggleFocus(id) {
    dash.focus = dash.focus === id ? null : id;
    if (dash.focusUnhid && dash.focusUnhid !== dash.focus) {
      dash.hidden.add(dash.focusUnhid);
      dash.focusUnhid = null;
    }
    if (dash.focus && dash.hidden.has(dash.focus)) {
      dash.hidden.delete(dash.focus);
      dash.focusUnhid = dash.focus;
    }
    persistHidden();
    chart && chart.setHidden && chart.setHidden(effectiveHidden());
    renderCards();
    renderLegend();
    if (dash.mode === "multi") renderChart();
    else chart && chart.setFocus && chart.setFocus(dash.focus);
    if (dash.focus && window.innerWidth < 900) chartHost.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---- 未登録アカウントのお知らせ ----------------------------------------------------------
  function renderNotice() {
    const cands = (server.candidates || []).filter((c) => !dash.dismissed.has(c.config_dir));
    if (!cands.length) { noticeEl.replaceChildren(); return; }
    setChildren(noticeEl, h("div.notice", [
      h("span.notice-dot", { "aria-hidden": "true" }),
      h("span", [`新しいアカウントが見つかりました（${cands.map((c) => c.suggested_id).join("、")}）`]),
      h("a.btn.btn-ghost.btn-sm", { href: "#/settings" }, "設定で追加 →"),
      h("button.icon-btn.sm", { type: "button", "aria-label": "閉じる", title: "閉じる", onclick: () => {
        cands.forEach((c) => dash.dismissed.add(c.config_dir));
        savePref("candidates.dismissed", [...dash.dismissed]);
        renderNotice();
      } }, "×"),
    ]));
  }

  // ---- グラフの操作部 ------------------------------------------------------------------
  function renderControls() {
    setChildren(ctrlEl,
      segmented(KIND_OPTS, dash.mode === "multi" ? null : dash.kind, (v) => {
        dash.kind = v; savePref("chart.kind", v);
        if (dash.mode === "multi") { dash.mode = "overlay"; savePref("chart.mode", "overlay"); }
        renderControls(); renderLegend(); renderChart();
      }, "枠の種類"),
      segmented(RANGE_OPTS, dash.range, (v) => {
        dash.range = v; savePref("chart.range", v); renderControls(); loadHistory();
      }, "期間"),
      segmented(MODE_OPTS, dash.mode, (v) => {
        dash.mode = v; savePref("chart.mode", v); renderControls(); renderLegend(); renderChart();
      }, "表示のしかた"),
    );
  }

  // 推移画面（凡例・グラフ・ピーク表）に出すアカウント。有効なものだけ。
  // 無効にしたアカウントは「いまは見ない」という意思表示なので、履歴が残っていても出さない
  // （カードの帯の「無効なアカウント n件」から現在値は見られる）。
  function chartAccounts() {
    if (!server) return [];
    return server.accounts.filter((a) => a.enabled);
  }
  // アーカイブ: 履歴はあるが設定に無いアカウント（設定から削除したもの）。凡例の末尾に薄く出し、押すと表示する。
  // 古いサーバーは archived を返さないので、無ければ空として扱う。
  function archivedAccounts() {
    if (!server || !Array.isArray(server.archived)) return [];
    const known = new Set(server.accounts.map((a) => a.id));
    return server.archived.filter((a) => a && a.id && !known.has(a.id))
      .map((a) => ({ id: a.id, label: a.label || a.id, color: a.color || "#888888", archived: true }));
  }
  // グラフ・表に出すアカウント。all=true なら非表示のアーカイブも含める（重ねる表示は作り直さずに出し入れするため）
  function plotAccounts(all = false) {
    const arch = archivedAccounts().filter((a) => all || dash.archShown.has(a.id));
    return [...chartAccounts().map((a) => ({ id: a.id, label: a.label, color: a.color })), ...arch];
  }
  // 線を出さないもの = 凡例で消したもの + 表示にしていないアーカイブ
  function effectiveHidden() {
    const out = new Set(dash.hidden);
    for (const a of archivedAccounts()) if (!dash.archShown.has(a.id)) out.add(a.id);
    return out;
  }

  // 凡例: 押す → 表示／非表示。ダブルクリック（スマホは長押し）→ それだけ表示。もう一度で全部表示。
  // 1回目の click で DOM を作り直すと、2回目の click と dblclick が消えた要素に届かなくなるので、
  // 作り直すのは並ぶアカウント（名前・色）が変わったときだけにして、ふだんは class だけ書き換える。
  function renderLegend() {
    if (!legendEl || !server) return;
    if (dash.mode === "multi") { legendEl.replaceChildren(); legendEl.hidden = true; legendSig = null; return; }
    legendEl.hidden = false;
    const accts = chartAccounts();
    const arch = archivedAccounts();
    const bg = cssVar("--surface") || "#fff";
    const sig = JSON.stringify([bg, accts.map((a) => [a.id, a.label, a.color]), arch.map((a) => [a.id, a.label, a.color])]);
    if (sig !== legendSig) {
      legendSig = sig;
      legendTail = h("span.legend-tail");
      setChildren(legendEl,
        ...accts.map((a) => legendItem(a, bg)),
        arch.length ? h("span.legend-sep", { title: "設定から外したアカウントの履歴です" }, "アーカイブ") : null,
        ...arch.map((a) => archivedItem(a, bg)),
        legendTail,
      );
    }
    updateLegend();
  }
  // クリックは 250ms 待ってから切り替え、そのあいだに dblclick が来たら取り消して「それだけ表示」にする。
  // タッチは長押し（520ms）が「それだけ表示」。タッチとキーボードの click は待たずに切り替える。
  function legendItem(a, bg) {
    let clickTimer = null, pressTimer = null, longPressed = false, touch = false;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    return h("button.legend-item", {
      type: "button",
      dataset: { id: a.id },
      title: "押すと表示／非表示。ダブルクリック（長押し）でこれだけ表示",
      onclick: (e) => {
        if (longPressed) { longPressed = false; return; } // 長押しのあとに来る click は無視する
        if (touch || e.detail === 0) { toggleVisible(a.id); return; }
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickTimer = null; toggleVisible(a.id); }, 250);
      },
      ondblclick: () => {
        if (touch) return;
        clearTimeout(clickTimer);
        clickTimer = null;
        solo(a.id);
      },
      onpointerdown: (e) => {
        touch = e.pointerType === "touch";
        longPressed = false;
        cancelPress();
        if (!touch) return;
        pressTimer = setTimeout(() => { pressTimer = null; longPressed = true; solo(a.id); navigator.vibrate && navigator.vibrate(15); }, 520);
      },
      onpointerup: cancelPress,
      onpointerleave: cancelPress,
      onpointercancel: cancelPress,
      oncontextmenu: (e) => { if (longPressed || pressTimer) e.preventDefault(); },
    }, [h("span.sw", { style: { background: readableColor(a.color, bg) } }), h("span", a.label)]);
  }
  function archivedItem(a, bg) {
    return h("button.legend-item.is-archived", {
      type: "button",
      dataset: { id: a.id, archived: "1" },
      title: "設定から外したアカウントの履歴。押すと表示／非表示",
      onclick: () => {
        if (dash.archShown.has(a.id)) dash.archShown.delete(a.id); else dash.archShown.add(a.id);
        // 表示する範囲（x 軸の左端など）が変わりうるので、グラフは作り直す
        renderChart();
        renderPeaks();
      },
    }, [h("span.sw", { style: { background: readableColor(a.color, bg) } }), h("span", a.label)]);
  }
  // 凡例の見た目（押されているか・強調・「全部表示」）だけを今の状態に合わせる
  function updateLegend() {
    if (!legendEl || legendEl.hidden) return;
    const accts = chartAccounts();
    for (const el of legendEl.querySelectorAll(".legend-item")) {
      const id = el.dataset.id;
      const visible = el.dataset.archived ? dash.archShown.has(id) : !dash.hidden.has(id);
      el.classList.toggle("is-off", !visible);
      el.classList.toggle("is-focus", dash.focus === id);
      el.setAttribute("aria-pressed", String(visible));
    }
    const someHidden = accts.some((a) => dash.hidden.has(a.id));
    if (legendTail) {
      setChildren(legendTail, someHidden
        ? h("button.legend-reset", { type: "button", onclick: () => showAll() }, "全部表示")
        : h("span.legend-help.hide-sm", "押すと表示／非表示・ダブルクリックでそれだけ表示"));
    }
    const allHidden = accts.length && accts.every((a) => dash.hidden.has(a.id)) &&
      !archivedAccounts().some((a) => dash.archShown.has(a.id));
    chartHost.classList.toggle("all-hidden", !!allHidden);
  }
  function toggleVisible(id) {
    const visible = !dash.hidden.has(id);
    if (visible) dash.hidden.add(id); else dash.hidden.delete(id);
    // 自分で表示／非表示を決めたので、強調を解いたときに戻す対象からは外す
    if (dash.focusUnhid === id) dash.focusUnhid = null;
    if (visible && dash.focus === id) { dash.focus = null; chart && chart.setFocus && chart.setFocus(null); renderCards(); }
    applyHidden();
  }
  function solo(id) {
    const others = chartAccounts().filter((a) => a.id !== id);
    const isSolo = !dash.hidden.has(id) && others.every((a) => dash.hidden.has(a.id));
    dash.hidden = isSolo ? new Set() : new Set(others.map((a) => a.id));
    dash.focusUnhid = null;
    applyHidden();
  }
  function showAll() {
    dash.hidden.clear();
    dash.focusUnhid = null;
    applyHidden();
  }
  function applyHidden() {
    persistHidden();
    chart && chart.setHidden && chart.setHidden(effectiveHidden());
    updateLegend();
  }
  // 強調のために一時的に表示に戻したものは、非表示のまま保存する（再読み込みしても元の状態に戻るように）
  function persistHidden() {
    const out = new Set(dash.hidden);
    if (dash.focusUnhid) out.add(dash.focusUnhid);
    savePref("chart.hidden", [...out]);
  }

  // ---- グラフ本体 --------------------------------------------------------------------
  // 期間を切り替えて取りに行っているあいだ: グラフがあれば薄くして「読み込み中」を重ね、無ければ読み込み中だけを出す。
  // 「記録開始: …」の注記は前の期間のものなので隠す。
  function renderChartLoading() {
    setChildren(chartInfo); chartInfo.hidden = true;
    if (!chart) { setChildren(chartHost, h("div.chart-empty", [spinner(), " 読み込み中…"])); setChildren(chartNote); return; }
    chartHost.classList.add("is-loading");
    if (!chartHost.querySelector(".chart-loading")) chartHost.append(h("div.chart-loading", [spinner(), " 読み込み中…"]));
  }
  function renderChart() {
    if (!chartHost) return;
    chartHost.classList.remove("is-loading");
    chart && chart.destroy();
    chart = null;
    chartHost.replaceChildren();
    if (!dash.history || !server) {
      setChildren(chartInfo); chartInfo.hidden = true;
      setChildren(chartNote);
      if (dash.historyError && !dash.historyLoading) {
        chartHost.append(h("div.chart-empty.is-error", [h("span", ["取得できませんでした（", dash.historyError, "）"]),
          h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => loadHistory() }, "再試行")]));
      } else {
        chartHost.append(h("div.chart-empty", [spinner(), " 読み込み中…"]));
      }
      renderLegend();
      return;
    }
    // 重ねる表示は、非表示のアーカイブも作っておいて setHidden で出し入れする。x 軸の範囲は表示するものだけで決める
    const accounts = dash.mode === "multi" ? plotAccounts() : plotAccounts(true);
    chartSig = plotSig();
    const ext = dataExtent(plotAccounts());
    renderChartInfo(ext);
    if (ext.sparse) {
      // 数点しかないと線にならず、空のグラフに見えるだけなので、グラフは作らずに理由を出す
      chartHost.append(h("div.chart-empty", { class: "is-sparse" }, [
        h("b", "データがたまると推移が描かれます"),
        h("span", `記録開始: ${fmtDateTime(ext.first)}。${countLabel(ext.perAccount)}`),
      ]));
    } else if (dash.mode === "multi") {
      chart = multiplesChart({ el: chartHost, history: dash.history, accounts, focus: dash.focus, xMin: ext.xMin });
    } else {
      chart = overlayChart({ el: chartHost, history: dash.history, kind: dash.kind, accounts, hidden: effectiveHidden(),
        focus: dash.focus, xMin: ext.xMin });
      if (!chart.hasData) chartHost.append(h("div.chart-empty.on-top", "この期間のデータはまだありません"));
      chartHost.append(h("div.chart-allhidden", ["すべて非表示になっています ",
        h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => showAll() }, "全部表示")]));
    }
    renderLegend();
    // グラフを描かないときは、印の説明も出さない
    setChildren(chartNote, ext.sparse ? null : [
      dash.mode === "multi" ? h("span.note-item", [h("i.mk-line"), "週間"]) : null,
      dash.mode === "multi" ? h("span.note-item", [h("i.mk-area"), "5h"]) : null,
      h("span.note-item", [h("i.mk-reset"), "リセット"]),
      h("span.note-item", [h("i.mk-gap"), "取得できなかった区間"]),
      h("span.note-item", [h("i.mk-err"), h("i.mk-errband"), "取得できず（ログイン切れなど。続いたものは点線）"]),
    ]);
  }

  // ---- データが選んだ期間より短いとき ----------------------------------------------------------
  // 記録を始めたばかりだと、7日の範囲の右端に点が少しあるだけで、グラフがほぼ空に見える。
  // そこで x 軸の左端を「最初のデータの少し前」に詰め、グラフの上に「記録開始: … から」と注記する
  // （期間を切り替えても形が変わらない理由が、注記でわかるように）。数点しかないときはグラフを描かない。
  // 「まだ描けない」とみなす目安: アカウントごとの値がこれ未満、または記録が始まってからこれだけたっていない
  // （10 分おきの取得なら 30 分 ≒ 4 点。それより短いと、線というより点の集まりにしかならない）
  const SPARSE_POINTS = 3;
  const SPARSE_SPAN = 30 * 60;
  function dataExtent(accounts) {
    const hist = dash.history;
    const ids = new Set(accounts.map((a) => a.id));
    let first = Infinity;
    const perAcct = new Map();
    for (const s of hist.series) {
      if (!ids.has(s.account_id)) continue;
      const set = perAcct.get(s.account_id) || new Set();
      perAcct.set(s.account_id, set);
      for (const g of s.segments) for (const [t] of g.points) { set.add(t); if (t < first) first = t; }
    }
    for (const e of hist.errors) if (ids.has(e.account_id) && e.t < first) first = e.t;
    const perAccount = Math.max(0, ...[...perAcct.values()].map((x) => x.size));
    if (!Number.isFinite(first)) return { first: null, xMin: hist.since, trimmed: false, sparse: false, perAccount };
    const span = hist.until - hist.since;
    // 範囲の始まりから 2% 以上あとにしかデータが無いときだけ詰める（ほぼそろっているなら、選んだ期間のまま）
    const trimmed = first > hist.since + span * 0.02;
    const pad = Math.max(600, (hist.until - first) * 0.04);
    return { first, trimmed, perAccount, xMin: trimmed ? Math.max(hist.since, first - pad) : hist.since,
      sparse: perAccount < SPARSE_POINTS || hist.until - first < SPARSE_SPAN };
  }
  function countLabel(n) {
    return n ? `いま ${n} 回分の記録があります。` : "まだ値を取得できていません。";
  }
  function renderChartInfo(ext) {
    if (!ext.trimmed || ext.sparse) { setChildren(chartInfo); chartInfo.hidden = true; return; }
    chartInfo.hidden = false;
    const label = (RANGE_OPTS.find((o) => o.value === dash.range) || {}).label || dash.range;
    setChildren(chartInfo, h("span.chart-info-k", `記録開始: ${fmtDateTime(ext.first)} から`),
      h("span.muted", `（${label}分たまるまでは、記録のある範囲だけを表示しています）`));
  }

  // ---- 週ごとのピーク表 ------------------------------------------------------------------
  // 列は「今週・1週前…」。アカウントごとにリセットの曜日が違うので、各アカウントの n 番目の枠を同じ列に並べる。
  function renderPeaks() {
    if (!peaksEl || !dash.windows || !server) return;
    const now = ctx.now();
    // グラフと同じく、有効なアカウントと、凡例で表示にしたアーカイブだけ
    const shown = plotAccounts();
    const order = shown.map((a) => a.id);
    const rows = [...dash.windows.rows].filter((r) => r.windows.length && order.includes(r.account_id))
      .sort((x, y) => order.indexOf(x.account_id) - order.indexOf(y.account_id));
    const cols = Math.min(8, Math.max(0, ...rows.map((r) => r.windows.length)));
    const bg = cssVar("--surface") || "#fff";
    const head = h("tr", [h("th.peak-name", { scope: "col" }, "アカウント"),
      ...Array.from({ length: cols }, (_, i) => h("th", { scope: "col", class: `c${i}` }, i === 0 ? "今週" : `${i}週前`))]);
    const body = rows.map((r) => {
      const a = shown.find((x) => x.id === r.account_id) || { label: r.account_id, color: "#888888" };
      return h("tr", { class: a.archived ? "is-archived" : "" }, [
        h("th.peak-name", { scope: "row" }, h("span.peak-name-in", [h("span.sw", { style: { background: readableColor(a.color, bg) } }), h("span", a.label)])),
        ...Array.from({ length: cols }, (_, i) => {
          const w = r.windows[i];
          if (!w) return h("td", { class: `c${i}` }, h("span.peak-cell.is-none", "—"));
          const live = w.resets_at > now;
          const p = Math.max(0, Math.min(100, w.peak_percent));
          const lv = level(p, server.ui);
          return h("td", { class: `c${i}` }, h("span.peak-cell", {
            class: `${live ? "is-live" : ""} lv-${lv} ${p >= 55 ? "is-hot" : ""}`,
            style: { "--p": `${Math.round(p * 0.9 + 4)}%` },
            title: `${fmtDate(w.resets_at - 7 * 86400)}〜${fmtDate(w.resets_at)}${live ? "（進行中）" : ""}: 最大 ${fmtPct(p)}`,
          }, fmtPct(p)));
        }),
      ]);
    });
    setChildren(peaksEl,
      h("div.panel-head", [h("h2", "週ごとのピーク"), h("span.panel-sub", "各週の最大使用率（週間枠）")]),
      // 列の数を CSS に渡して、表の幅を「列数 × セルの上限幅」までに抑える（列が少ないときにセルが横いっぱいに伸びないように）
      rows.length ? h("div.peak-wrap", h("table.peak", { style: { "--cols": String(cols), "--cols-sm": String(Math.min(cols, 5)) } },
        [h("thead", head), h("tbody", body)]))
        : h("p.muted", "まだ1週間分のデータがありません。"),
    );
  }

  return { mount, unmount, onState };
}
