// 設定画面（PLAN §6.2、U4）。
// 何を: GET /api/config を読み込んでフォームで編集し、PUT で保存する（読み込んだときの hash を付けた楽観ロック）。
// なぜ: TOML が唯一の正（PLAN §7.1）。画面はその編集画面なので、保存の状態（保存済み・未保存・競合）を常に見せる。
// 方針:
//   - 編集中の内容は st.form（設定の深いコピー）に持ち、保存済みの内容（st.baseline の文字列）と比べて「未保存」を判断する。
//   - 文字入力では作り直さない（カーソルが飛ばないように）。開閉・並べ替え・追加・削除・結果表示のときだけ render() する。
//   - 行には画面内だけの _key を付ける。新規の id は書き換えられるので、id を行の目印にしない。

import { api } from "./api.js";
import { h, setChildren, spinner, toast, statusChip, bar, fmtPct, readableColor, cssVar, copyCmd } from "./ui.js";

let keySeq = 0;
const newKey = () => `k${++keySeq}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const PALETTE = ["#4f8cff", "#e8833a", "#2bb673", "#a86ad9", "#e05a8a", "#1fb5c2", "#c9a227", "#7a8699"];

// 保存用に、画面だけの印（_key）を外す
function strip(form) {
  const c = clone(form);
  for (const a of c.accounts) delete a._key;
  return c;
}

export function createSettings(ctx) {
  const st = {
    loading: false, loadError: null,
    hash: null, path: null, fileError: null, candidates: [],
    form: null, baseline: null,
    open: null,               // 開いている行の _key（1行だけ開く。もう一度押すと閉じる）
    newKeys: new Set(),       // この画面で追加した行（id を編集できる）
    errors: new Map(),        // フィールドのパス → メッセージ（422 の応答）
    generalErrors: [],
    saving: false, conflict: false, restartRequired: false, saveError: null, justSaved: false,
    tests: new Map(),         // _key → { loading, result, error }
    confirmDelete: null,      // 削除の確認を出している行の _key
    dragKey: null,
  };
  let root = null, statusEl = null, saveBtn = null, revertBtn = null;

  const isDirty = () => !!(st.form && st.baseline !== JSON.stringify(strip(st.form)));

  // ---- 読み込み ------------------------------------------------------------------
  async function load() {
    st.loading = true;
    render();
    try {
      const r = await api.getConfig();
      st.hash = r.hash;
      st.path = r.path;
      st.fileError = r.error;
      st.candidates = r.candidates || [];
      st.form = clone(r.config);
      for (const a of st.form.accounts) a._key = newKey();
      st.baseline = JSON.stringify(strip(st.form));
      st.newKeys.clear();
      st.errors.clear();
      st.generalErrors = [];
      st.conflict = false;
      st.saveError = null;
      st.open = null;
      st.loadError = null;
    } catch (e) {
      st.loadError = e.message;
    }
    st.loading = false;
    render();
  }

  // ---- 保存 ------------------------------------------------------------------------
  async function save() {
    if (!isDirty() || st.saving) return;
    st.saving = true;
    st.saveError = null;
    updateStatus();
    const keys = st.form.accounts.map((a) => a._key); // 422 の accounts.N を行に戻すため
    try {
      const body = strip(st.form);
      const r = await api.putConfig(body, st.hash);
      st.hash = r.hash;
      st.baseline = JSON.stringify(body);
      st.newKeys.clear();
      st.errors.clear();
      st.generalErrors = [];
      st.restartRequired = st.restartRequired || !!r.restart_required;
      st.justSaved = true;
      toast("保存しました。すぐに反映されます", "ok");
      ctx.refreshState();
      render();
    } catch (e) {
      if (e.status === 409) {
        st.conflict = true;
      } else if (e.status === 422 && e.body && e.body.fields) {
        st.errors.clear();
        st.generalErrors = [];
        for (const [field, msg] of e.body.fields) {
          const m = /^accounts\.(\d+)\.?(.*)$/.exec(field);
          if (m && keys[+m[1]]) {
            st.errors.set(`acct:${keys[+m[1]]}:${m[2] || "_row"}`, msg);
          } else if (fieldExists(field)) st.errors.set(field, msg);
          else st.generalErrors.push(`${labelFor(field)}: ${msg}`);
        }
        // エラーのある行を開いて、最初のエラーまでスクロールする
        const firstRow = [...st.errors.keys()].find((k) => k.startsWith("acct:"));
        if (firstRow) st.open = firstRow.split(":")[1];
        st.saveError = e.message;
      } else {
        st.saveError = e.message || "保存できませんでした";
      }
      render();
      requestAnimationFrame(() => {
        const el = root && root.querySelector(".field.has-error, .save-errors");
        el && el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    st.saving = false;
    updateStatus();
  }

  const GLOBAL_FIELDS = {
    "collector.default_interval_minutes": "既定の取得間隔", "collector.timeout_seconds": "タイムアウト",
    "collector.concurrency": "同時実行数", "ui.warn_percent": "警告", "ui.danger_percent": "危険",
    "server.port": "ポート", "server.host": "ホスト", "collector.discover_roots": "探す場所",
    "collector.claude_path": "claude の場所", "ui": "色のしきい値", "accounts": "アカウント",
  };
  const fieldExists = (f) => f in GLOBAL_FIELDS && f !== "accounts";
  const labelFor = (f) => GLOBAL_FIELDS[f] || f;

  // ---- 画面の骨組み -------------------------------------------------------------------
  function mount(el) {
    root = h("div.settings");
    el.append(root);
    document.addEventListener("keydown", onKey);
    if (!st.form || !isDirty()) load(); else render();
  }
  function unmount() {
    document.removeEventListener("keydown", onKey);
    root = null;
  }
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  }
  function onState() { /* 設定画面はサーバーの状態の更新では作り直さない（編集中のため） */ }

  function render() {
    if (!root) return;
    if (st.loading && !st.form) { setChildren(root, h("div.chart-empty", [spinner(), " 読み込み中…"])); return; }
    if (st.loadError && !st.form) {
      setChildren(root, h("div.panel", [h("p", ["設定を読み込めませんでした（", st.loadError, "）"]),
        h("button.btn", { type: "button", onclick: load }, "再試行")]));
      return;
    }
    const f = st.form;
    setChildren(root, ...[
      st.fileError ? h("div.banner.tone-warn", ["設定ファイルに誤りがあります: ", st.fileError]) : null,
      st.restartRequired ? h("div.banner.tone-info", "ホスト・ポートの変更は、ccsmoni を再起動すると反映されます。") : null,
      accountsPanel(f),
      candidatesPanel(),
      globalPanel(f),
      st.path ? h("p.file-path", ["設定ファイル: ", h("code", st.path)]) : null,
      saveBar(),
    ].filter(Boolean));
    updateStatus();
  }

  // ---- 保存バー（画面の下に固定） --------------------------------------------------------
  function saveBar() {
    statusEl = h("div.save-status", { "aria-live": "polite" });
    revertBtn = h("button.btn.btn-ghost", { type: "button", onclick: () => {
      if (confirm("編集中の変更を破棄して、保存済みの内容に戻しますか？")) load();
    } }, "元に戻す");
    saveBtn = h("button.btn.btn-primary", { type: "button", onclick: save, title: "Ctrl+S でも保存できます" }, "保存");
    return h("div.save-bar", [
      st.generalErrors.length ? h("div.save-errors", st.generalErrors.map((m) => h("div", m))) : null,
      h("div.save-inner", [statusEl, h("span.grow"), revertBtn, saveBtn]),
    ]);
  }
  function updateStatus() {
    if (!statusEl) return;
    const dirty = isDirty();
    if (dirty) st.justSaved = false;
    let content;
    if (st.conflict) {
      content = [h("span.dot.tone-danger"), h("span", "外部で設定ファイルが変更されました"),
        h("button.btn.btn-sm", { type: "button", onclick: () => {
          if (!isDirty() || confirm("読み込み直すと、この画面の変更は破棄されます。よろしいですか？")) load();
        } }, "読み込み直す")];
    } else if (st.saving) {
      content = [spinner(), h("span", "保存しています…")];
    } else if (st.saveError) {
      content = [h("span.dot.tone-danger"), h("span", st.saveError)];
    } else if (dirty) {
      content = [h("span.dot.tone-warn"), h("span", "未保存の変更があります")];
    } else {
      content = [h("span.dot.tone-ok"), h("span", st.justSaved ? "保存しました" : "保存済み")];
    }
    setChildren(statusEl, ...content);
    saveBtn.disabled = !dirty || st.saving;
    revertBtn.hidden = !dirty;
    root && root.classList.toggle("is-dirty", dirty);
  }
  // 入力のたびに呼ぶ: 保存状態とエラー表示だけ更新する
  function changed(errKey) {
    st.saveError = null;
    if (errKey && st.errors.has(errKey)) {
      st.errors.delete(errKey);
      const el = root.querySelector(`[data-err="${CSS.escape(errKey)}"]`);
      if (el) { el.closest(".field")?.classList.remove("has-error"); el.remove(); }
    }
    updateStatus();
  }

  // ---- 入力欄の部品 ------------------------------------------------------------------
  // errKey: 422 のエラーを横に出すための目印
  function field(label, input, { help = null, errKey = null, wide = false, div = false } = {}) {
    const err = errKey && st.errors.get(errKey);
    return h(div ? "div.field" : "label.field", { class: `${err ? "has-error" : ""} ${wide ? "is-wide" : ""}` }, [
      h("span.field-label", label),
      input,
      err ? h("span.field-error", { dataset: { err: errKey } }, err) : null,
      help ? h("span.field-help", help) : null,
    ]);
  }
  function textInput(obj, key, { placeholder = "", nullable = false, errKey, onInput, mono = false } = {}) {
    return h("input", {
      type: "text", value: obj[key] ?? "", placeholder, class: mono ? "mono" : "", spellcheck: "false",
      oninput: (e) => {
        const v = e.target.value;
        obj[key] = nullable && v.trim() === "" ? null : v;
        onInput && onInput(v);
        changed(errKey);
      },
    });
  }
  function numInput(obj, key, { placeholder = "", nullable = false, errKey, min, max, unit, onInput } = {}) {
    const input = h("input", {
      type: "number", inputmode: "numeric", value: obj[key] ?? "", placeholder, min, max,
      oninput: (e) => {
        const v = e.target.value.trim();
        obj[key] = v === "" ? (nullable ? null : null) : Number(v);
        onInput && onInput();
        changed(errKey);
      },
    });
    return unit ? h("span.with-unit", [input, h("span.unit", unit)]) : input;
  }
  function switchToggle(on, onChange, label) {
    return h("button.switch", { type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, title: label,
      onclick: (e) => { e.stopPropagation(); onChange(!on); } }, h("span.knob"));
  }

  // ---- アカウント一覧 ------------------------------------------------------------------
  function accountsPanel(f) {
    const list = h("ol.acct-list", f.accounts.map((a, i) => accountRow(a, i, f)));
    return h("section.panel", [
      h("div.panel-head", [h("h2", "アカウント"), h("span.panel-sub", "ドラッグで並べ替え・行を押して編集"), h("span.grow"),
        h("button.btn.btn-sm", { type: "button", onclick: () => addAccount() }, "＋ 新規")]),
      f.accounts.length ? list : h("p.muted", "まだありません。下の候補から追加するか、［＋ 新規］で作ってください。"),
      st.errors.get("accounts") ? h("p.field-error", st.errors.get("accounts")) : null,
    ]);
  }

  function accountRow(a, i, f) {
    const k = a._key;
    const open = st.open === k;
    const isNew = st.newKeys.has(k);
    const bg = cssVar("--surface") || "#fff";
    const color = a.color && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : null;
    const nameEl = h("span.acct-name", a.label || "（名前なし）");
    const rowErr = [...st.errors.keys()].some((x) => x.startsWith(`acct:${k}:`));

    const head = h("div.acct-head", {
      role: "button", tabindex: "0", "aria-expanded": String(open),
      onclick: () => { st.open = open ? null : k; st.confirmDelete = null; render(); },
      onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); e.currentTarget.click(); } },
    }, [
      h("span.drag-handle", { title: "ドラッグで並べ替え", "aria-hidden": "true",
        onmousedown: (e) => { e.currentTarget.closest(".acct-row").draggable = true; },
        onclick: (e) => e.stopPropagation() }, "⋮⋮"),
      h("span.sw", { style: { background: color ? readableColor(color, bg) : "transparent" }, class: color ? "" : "is-auto" }),
      h("span.acct-title", [nameEl, h("span.acct-id.mono", a.id || "（id 未入力）")]),
      rowErr ? h("span.chip.tone-danger", "要修正") : null,
      isNew ? h("span.chip.tone-info", "新規") : null,
      h("span.grow"),
      h("span.order-btns", [
        h("button.icon-btn.sm", { type: "button", "aria-label": "上へ", title: "上へ", disabled: i === 0,
          onclick: (e) => { e.stopPropagation(); move(i, i - 1); } }, "↑"),
        h("button.icon-btn.sm", { type: "button", "aria-label": "下へ", title: "下へ", disabled: i === f.accounts.length - 1,
          onclick: (e) => { e.stopPropagation(); move(i, i + 1); } }, "↓"),
      ]),
      switchToggle(a.enabled !== false, (v) => { a.enabled = v; render(); }, a.enabled !== false ? "有効（押すと無効に）" : "無効（押すと有効に）"),
      h("span.chev", { "aria-hidden": "true" }, open ? "▴" : "▾"),
    ]);

    const row = h("li.acct-row", {
      class: `${open ? "is-open" : ""} ${a.enabled === false ? "is-disabled" : ""}`,
      dataset: { key: k },
      ondragstart: (e) => { st.dragKey = k; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); row.classList.add("is-dragging"); },
      ondragend: () => { row.draggable = false; st.dragKey = null; row.classList.remove("is-dragging"); clearDrop(); },
      ondragover: (e) => {
        if (!st.dragKey || st.dragKey === k) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        clearDrop();
        row.classList.add(after ? "drop-after" : "drop-before");
      },
      ondrop: (e) => {
        e.preventDefault();
        const from = f.accounts.findIndex((x) => x._key === st.dragKey);
        const r = row.getBoundingClientRect();
        let to = f.accounts.findIndex((x) => x._key === k) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
        if (from < to) to--;
        clearDrop();
        if (from >= 0 && from !== to) move(from, to);
      },
    }, [head, open ? editor(a, i, f) : null]);
    return row;
  }
  function clearDrop() {
    root && root.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  }
  function move(from, to) {
    const arr = st.form.accounts;
    if (to < 0 || to >= arr.length) return;
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
    // 行の位置が変わると 422 の accounts.N がずれるので、表示中のエラーはそのまま（_key で持っている）
    render();
  }

  // 行を開いたときの編集フォーム
  function editor(a, i, f) {
    const k = a._key;
    const isNew = st.newKeys.has(k);
    const ek = (name) => `acct:${k}:${name}`;
    const head = () => root.querySelector(`.acct-row[data-key="${k}"]`);
    const colorText = textInput(a, "color", { placeholder: "自動", nullable: true, errKey: ek("color"), mono: true,
      onInput: (v) => { if (/^#[0-9a-f]{6}$/i.test(v)) { picker.value = v; paintSwatch(v); } } });
    const picker = h("input.color-picker", { type: "color", value: a.color && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : PALETTE[i % PALETTE.length],
      "aria-label": "色を選ぶ",
      oninput: (e) => { a.color = e.target.value; colorText.value = a.color; paintSwatch(a.color); changed(ek("color")); } });
    const paintSwatch = (c) => {
      const sw = head() && head().querySelector(".acct-head .sw");
      if (sw) { sw.style.background = readableColor(c, cssVar("--surface") || "#fff"); sw.classList.remove("is-auto"); }
    };
    const test = st.tests.get(k);

    const idField = isNew
      ? field("id", textInput(a, "id", { errKey: ek("id"), mono: true, placeholder: "acct-x",
          onInput: (v) => { const el = head()?.querySelector(".acct-id"); if (el) el.textContent = v || "（id 未入力）"; } }),
        { errKey: ek("id"), help: "履歴を記録するときの名前です。英数字・ - ・ _ で。保存したあとは変えられません。" })
      : h("div.field", [h("span.field-label", "id"), h("code.readonly", a.id), h("span.field-help", "履歴のキーなので変えられません。")]);

    return h("div.acct-editor", { onclick: (e) => e.stopPropagation() }, [
      h("div.form-grid", [
        field("表示名", textInput(a, "label", { errKey: ek("label"), placeholder: "例: 個人",
          onInput: (v) => { const el = head()?.querySelector(".acct-name"); if (el) el.textContent = v || "（名前なし）"; } }),
          { errKey: ek("label") }),
        idField,
        field("設定フォルダ（CLAUDE_CONFIG_DIR）", textInput(a, "config_dir", { errKey: ek("config_dir"), mono: true, placeholder: "~/claude-configs/acct-a" }),
          { errKey: ek("config_dir"), wide: true, help: "~ や %USERPROFILE% も使えます。" }),
        field("起動コマンド", textInput(a, "launch_command", { nullable: true, errKey: ek("launch_command"), mono: true, placeholder: "例: claude-acct-a" }),
          { errKey: ek("launch_command"), help: "ログインの案内とコピー用です。ccsmoni が実行することはありません。" }),
        field("色", h("span.color-row", [picker, colorText,
          h("span.palette", PALETTE.map((c) => h("button.pal", { type: "button", style: { background: c }, title: c, "aria-label": `色 ${c}`,
            onclick: (e) => { e.preventDefault(); a.color = c; colorText.value = c; picker.value = c; paintSwatch(c); changed(ek("color")); } })))]),
          { errKey: ek("color"), div: true, help: "空欄なら自動で決めます。" }),
        field("取得間隔", numInput(a, "interval_minutes", { nullable: true, errKey: ek("interval_minutes"), min: 1, max: 1440, unit: "分",
          placeholder: `既定（${f.collector.default_interval_minutes ?? 10}）` }),
          { errKey: ek("interval_minutes"), help: "空欄なら全体の既定値を使います。" }),
      ]),
      h("div.editor-actions", [
        h("button.btn", { type: "button", disabled: !a.config_dir || (test && test.loading), onclick: () => runTest(a) },
          test && test.loading ? [spinner(), " テスト中…"] : "接続テスト"),
        testResult(test),
        h("span.grow"),
        st.confirmDelete === k
          ? h("span.confirm-del", [h("span", [h("b", `「${a.label || a.id}」を削除しますか？`), " 履歴は残ります。"]),
              h("button.btn.btn-danger.btn-sm", { type: "button", onclick: () => removeAccount(k) }, "削除する"),
              h("button.btn.btn-ghost.btn-sm", { type: "button", onclick: () => { st.confirmDelete = null; render(); } }, "やめる")])
          : h("button.btn.btn-ghost.btn-danger-text", { type: "button", onclick: () => { st.confirmDelete = k; render(); } }, "削除"),
      ]),
    ]);
  }

  async function runTest(a) {
    const k = a._key;
    st.tests.set(k, { loading: true });
    render();
    try {
      const r = await api.testAccount(a.config_dir);
      st.tests.set(k, { result: r });
    } catch (e) {
      st.tests.set(k, { error: e.message });
    }
    render();
  }
  function testResult(t) {
    if (!t || t.loading) return null;
    if (t.error) return h("span.test-result", [statusChip("error"), h("span", t.error)]);
    const r = t.result;
    const ui = st.form.ui;
    if (r.status !== "ok") return h("span.test-result", [statusChip(r.status), r.message ? h("span.muted", r.message) : null]);
    return h("span.test-result", [statusChip("ok"), r.plan ? h("span.badge", r.plan.toUpperCase()) : null,
      ...r.limits.filter((l) => l.kind === "session" || l.kind === "weekly_all").map((l) =>
        h("span.test-limit", [h("span.muted", l.kind === "session" ? "5h" : "週間"), bar(l.percent, { ui }), h("span.num", fmtPct(l.percent))]))]);
  }

  function addAccount(cand) {
    const f = st.form;
    const used = new Set(f.accounts.map((a) => a.color));
    const a = {
      id: cand ? uniqueId(cand.suggested_id) : "",
      label: cand ? cand.suggested_id : "",
      config_dir: cand ? cand.config_dir : "",
      launch_command: null,
      color: PALETTE.find((c) => !used.has(c)) || null,
      interval_minutes: null,
      enabled: true,
      _key: newKey(),
    };
    f.accounts.push(a);
    st.newKeys.add(a._key);
    st.open = a._key;
    render();
    requestAnimationFrame(() => {
      const row = root.querySelector(`.acct-row[data-key="${a._key}"]`);
      row && row.scrollIntoView({ behavior: "smooth", block: "center" });
      row && row.querySelector("input")?.focus({ preventScroll: true });
    });
    if (cand) toast(`「${a.label}」を一覧に加えました。保存すると記録が始まります`, "info");
  }
  function uniqueId(base) {
    const ids = new Set(st.form.accounts.map((a) => a.id));
    let id = base, n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    return id;
  }
  function removeAccount(k) {
    const f = st.form;
    const a = f.accounts.find((x) => x._key === k);
    f.accounts = f.accounts.filter((x) => x._key !== k);
    st.confirmDelete = null;
    if (st.open === k) st.open = null;
    for (const key of [...st.errors.keys()]) if (key.startsWith(`acct:${k}:`)) st.errors.delete(key);
    render();
    toast(`「${(a && (a.label || a.id)) || ""}」を一覧から外しました（保存で確定）`, "info");
  }

  // ---- 未登録の候補 -------------------------------------------------------------------
  function candidatesPanel() {
    const known = new Set(st.form.accounts.map((a) => a.config_dir));
    const cands = st.candidates.filter((c) => !known.has(c.config_dir));
    if (!cands.length) return null;
    return h("section.panel.cands", [
      h("div.panel-head", [h("h2", "見つかったアカウント"), h("span.panel-sub", "まだ登録されていない Claude の設定フォルダです")]),
      h("ul.cand-list", cands.map((c) => h("li.cand", [
        h("span.cand-text", [h("b.mono", c.suggested_id), h("span.mono.muted", c.config_dir)]),
        h("button.btn.btn-sm", { type: "button", onclick: () => addAccount(c) }, "＋ 追加"),
      ]))),
    ]);
  }

  // ---- 全体設定 ----------------------------------------------------------------------
  function globalPanel(f) {
    const c = f.collector, ui = f.ui, sv = f.server;
    const preview = h("div.th-preview");
    const paintPreview = () => {
      const w = Number(ui.warn_percent), d = Number(ui.danger_percent);
      const okW = Math.max(0, Math.min(100, w)), dW = Math.max(okW, Math.min(100, d));
      setChildren(preview, 
        h("span.th-zone.lv-ok", { style: { width: `${okW}%` } }, okW >= 12 ? "通常" : ""),
        h("span.th-zone.lv-warn", { style: { width: `${dW - okW}%` } }, dW - okW >= 10 ? "警告" : ""),
        h("span.th-zone.lv-danger", { style: { width: `${100 - dW}%` } }, 100 - dW >= 8 ? "危険" : ""),
      );
    };
    paintPreview();
    const uiErr = st.errors.get("ui");
    return h("section.panel", [
      h("div.panel-head", [h("h2", "全体の設定")]),
      h("div.form-grid", [
        field("既定の取得間隔", numInput(c, "default_interval_minutes", { min: 1, max: 1440, unit: "分", errKey: "collector.default_interval_minutes" }),
          { errKey: "collector.default_interval_minutes", help: "アカウントで空欄にしたときの間隔です。" }),
        field("タイムアウト", numInput(c, "timeout_seconds", { min: 5, max: 300, unit: "秒", errKey: "collector.timeout_seconds" }),
          { errKey: "collector.timeout_seconds", help: "1回の取得をあきらめるまでの時間です。" }),
        field("同時実行数", numInput(c, "concurrency", { min: 1, max: 8, errKey: "collector.concurrency" }),
          { errKey: "collector.concurrency", help: "いくつのアカウントを同時に取りに行くか。" }),
        h("div.field.is-wide", { class: uiErr ? "has-error" : "" }, [
          h("span.field-label", "使用率の色"),
          h("div.th-row", [
            h("label.th-input", [h("span.muted", "警告"), numInput(ui, "warn_percent", { min: 0, max: 100, unit: "%", errKey: "ui.warn_percent", onInput: paintPreview })]),
            h("label.th-input", [h("span.muted", "危険"), numInput(ui, "danger_percent", { min: 0, max: 100, unit: "%", errKey: "ui.danger_percent", onInput: paintPreview })]),
          ]),
          preview,
          uiErr ? h("span.field-error", { dataset: { err: "ui" } }, uiErr) : null,
          ...["ui.warn_percent", "ui.danger_percent"].map((x) => st.errors.get(x) ? h("span.field-error", { dataset: { err: x } }, st.errors.get(x)) : null),
        ]),
      ]),
      h("details.advanced", [
        h("summary", "詳細"),
        h("div.form-grid", [
          field("ホスト", textInput(sv, "host", { errKey: "server.host", mono: true }), { errKey: "server.host", help: "再起動すると反映されます。" }),
          field("ポート", numInput(sv, "port", { min: 1, max: 65535, errKey: "server.port" }), { errKey: "server.port", help: "再起動すると反映されます。" }),
          field("claude の場所", textInput(c, "claude_path", { errKey: "collector.claude_path", mono: true }), { errKey: "collector.claude_path" }),
          field("アカウントを探す場所", h("textarea.mono", { rows: 2, spellcheck: "false", value: (c.discover_roots || []).join("\n"),
            oninput: (e) => { c.discover_roots = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean); changed("collector.discover_roots"); } }),
            { errKey: "collector.discover_roots", wide: true, help: "1行に1つ。この下にある Claude の設定フォルダを候補として出します。" }),
        ]),
      ]),
    ]);
  }

  return {
    mount, unmount, onState, isDirty,
    discard: () => { st.form = null; st.baseline = null; },
  };
}
