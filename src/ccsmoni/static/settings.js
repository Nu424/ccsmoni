// 設定画面（PLAN §6.2、U4）。
// 何を: GET /api/config を読み込んでフォームで編集し、PUT で保存する（読み込んだときの hash を付けた楽観ロック）。
// なぜ: TOML が唯一の正（PLAN §7.1）。画面はその編集画面なので、保存の状態（保存済み・未保存・競合）を常に見せる。
// 方針:
//   - 編集中の内容は st.form（設定の深いコピー）に持ち、保存済みの内容（st.baseline の文字列）と比べて「未保存」を判断する。
//   - 文字入力では作り直さない（カーソルが飛ばないように）。開閉・並べ替え・追加・削除・結果表示のときだけ render() する。
//   - 行には画面内だけの _key を付ける。新規の id は書き換えられるので、id を行の目印にしない。

import { api } from "./api.js";
import { h, setChildren, spinner, toast, statusChip, bar, fmtPct } from "./ui.js";
import { themePalette, setPalette, colorOf } from "./colors.js";

let keySeq = 0;
const newKey = () => `k${++keySeq}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const HEX = /^#[0-9a-f]{6}$/i;

// サーバーの自動の割り当て（config.resolve_colors、API.md「色の割り当て」）と同じ規則で、フォームの内容から番号を決める。
// 戻り値: _key → 番号（独自の色なら null）。保存前の並べ替え・追加でも、推移画面で何色になるかをそのまま見せるため。
export function resolveSlots(accounts, n = 7) {
  const taken = new Set(accounts.filter((a) => Number.isInteger(a.color)).map((a) => a.color));
  const out = new Map();
  accounts.forEach((a, i) => {
    if (Number.isInteger(a.color)) { out.set(a._key, a.color); return; }
    if (typeof a.color === "string" && a.color !== "") { out.set(a._key, null); return; }
    let slot = i % n;
    for (let k = 0; k < n; k++) { const c = (i + k) % n; if (!taken.has(c)) { slot = c; break; } }
    taken.add(slot);
    out.set(a._key, slot);
  });
  return out;
}

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
    historyIds: new Set(),    // 履歴があるアカウントの id（新しい id が重なったら注意を出す）
    readonly: null,           // claude_path / host / port（画面では変えられない。設定ファイルで編集する）
    knownHashes: new Set(),   // この画面で読み込んだ・保存した hash（state の config_hash がこれ以外なら外部の変更）
    external: false,          // 編集中に、設定ファイルが外部で変更された
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
  let root = null, statusEl = null, saveBtn = null, revertBtn = null, bannersEl = null;

  const isDirty = () => !!(st.form && st.baseline !== JSON.stringify(strip(st.form)));

  // ---- 読み込み ------------------------------------------------------------------
  // keepOpen: 外部の変更を自動で読み込み直すとき、開いていた行（id で探す）を開いたままにする
  async function load({ keepOpen = false } = {}) {
    const openId = keepOpen && st.form ? (st.form.accounts.find((a) => a._key === st.open) || {}).id : null;
    st.loading = true;
    render();
    try {
      const r = await api.getConfig();
      st.hash = r.hash;
      st.knownHashes.add(r.hash);
      st.path = r.path;
      st.fileError = r.error;
      st.candidates = r.candidates || [];
      // 以下は新しいサーバーだけが返す。無ければ空として扱う
      setPalette(r.palette);
      st.historyIds = new Set(Array.isArray(r.history_ids) ? r.history_ids : []);
      st.readonly = r.readonly && typeof r.readonly === "object" ? r.readonly : null;
      st.form = clone(r.config);
      for (const a of st.form.accounts) a._key = newKey();
      st.baseline = JSON.stringify(strip(st.form));
      st.newKeys.clear();
      st.errors.clear();
      st.generalErrors = [];
      st.conflict = false;
      st.external = false;
      st.saveError = null;
      st.open = openId ? (st.form.accounts.find((a) => a.id === openId) || {})._key || null : null;
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
      st.knownHashes.add(r.hash);
      st.external = false;
      st.fileError = null; // 保存でファイルを書き直したので、誤りは直っている（state の config_error も次の取得で消える）
      st.baseline = JSON.stringify(body);
      st.newKeys.clear();
      st.errors.clear();
      st.generalErrors = [];
      st.restartRequired = st.restartRequired || !!r.restart_required;
      st.justSaved = true;
      toast("保存しました。すぐに反映されます", "ok");
      // スキーマに無いキーを取り除いた・壊れていたファイルを控えに残した、は保存とは別に知らせる
      const removed = Array.isArray(r.removed_keys) ? r.removed_keys : [];
      if (removed.length) toast(`設定ファイルにあった不明な項目を取り除きました: ${removed.join("、")}`, "warn", 7000);
      if (r.backup_path) toast(`誤りのあった設定ファイルは控えを残しました: ${r.backup_path}`, "info", 7000);
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
    "ui.tiles_per_page": "1ページのタイル数", "server.port": "ポート", "server.host": "ホスト", "collector.discover_roots": "探す場所",
    "collector.claude_path": "claude の場所", "ui": "色のしきい値", "accounts": "アカウント",
  };
  // 画面に入力欄があるもの（claude_path / host / port は読み取り専用なので、エラーは保存バーの一覧に出す）
  const READONLY_FIELDS = new Set(["server.port", "server.host", "collector.claude_path"]);
  const fieldExists = (f) => f in GLOBAL_FIELDS && f !== "accounts" && !READONLY_FIELDS.has(f);
  const labelFor = (f) => GLOBAL_FIELDS[f] || f;

  // ---- 画面の骨組み -------------------------------------------------------------------
  function mount(el) {
    root = h("div.settings");
    el.append(root);
    document.addEventListener("keydown", onKey);
    window.addEventListener("ccsmoni:theme", render);
    if (!st.form || !isDirty()) load(); else render();
  }
  function unmount() {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("ccsmoni:theme", render);
    root = null;
  }
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  }
  // 設定画面はサーバーの状態の更新では作り直さない（編集中のため）。
  // ただし設定ファイルが外部で変更されたら（state の config_hash が、ここで読み込んだ・保存したどれとも違う）、
  // 未編集なら黙って読み込み直し、編集中なら帯で知らせる。古いサーバーは config_hash を返さないので何もしない。
  let lastExternalHash = null;
  function onState(s) {
    renderBanners();
    const h2 = s && s.config_hash;
    if (!root || !h2 || !st.form || st.loading || st.saving) return;
    if (st.knownHashes.has(h2) || h2 === lastExternalHash) return;
    lastExternalHash = h2; // 読み込み直しても hash が合わない場合（壊れたファイル等）に、繰り返さないように
    if (!isDirty()) {
      // 中身が同じだった（hash の付け方の違いだけ等）なら、知らせない
      const before = st.baseline;
      load({ keepOpen: true }).then(() => {
        if (!st.loadError && st.baseline !== before) toast("設定ファイルの変更を読み込みました", "info");
      });
    } else if (!st.external) {
      st.external = true;
      renderBanners();
    }
  }

  function render() {
    if (!root) return;
    if (st.loading && !st.form) { setChildren(root, h("div.chart-empty", [spinner(), " 読み込み中…"])); return; }
    if (st.loadError && !st.form) {
      setChildren(root, h("div.panel", [h("p", ["設定を読み込めませんでした（", st.loadError, "）"]),
        h("button.btn", { type: "button", onclick: load }, "再試行")]));
      return;
    }
    const f = st.form;
    bannersEl = h("div.settings-banners");
    renderBanners();
    setChildren(root, ...[
      bannersEl,
      st.restartRequired ? h("div.banner.tone-info", "ホスト・ポートの変更は、ccsmoni を再起動すると反映されます。") : null,
      accountsPanel(f),
      candidatesPanel(),
      globalPanel(f),
      st.path ? h("p.file-path", ["設定ファイル: ", h("code", st.path)]) : null,
      saveBar(),
    ].filter(Boolean));
    updateStatus();
  }

  // 画面の上の帯。state が来るたびにも呼ぶ（フォームは作り直さない）。
  // 設定ファイルの誤りは、アプリ全体の帯（app.js）ではなくここで1つだけ出す。
  function renderBanners() {
    if (!bannersEl) return;
    const fileError = st.fileError || (ctx.store.server && ctx.store.server.config_error);
    setChildren(bannersEl,
      st.external ? h("div.banner.tone-warn", [h("b", "設定ファイルが外部で変更されました。"), " ",
        h("button.btn.btn-sm", { type: "button", onclick: () => {
          if (confirm("読み込み直すと、この画面の変更は破棄されます。よろしいですか？")) load({ keepOpen: true });
        } }, "読み込み直す")]) : null,
      fileError ? h("div.banner.tone-warn", [h("b", "設定ファイルに誤りがあります。"),
        " 最後に有効だった設定で動いています。保存すると、この画面の内容でファイルを書き直します。 ",
        h("span.banner-detail", fileError)]) : null,
    );
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
  function numInput(obj, key, { placeholder = "", errKey, min, max, unit, onInput } = {}) {
    const input = h("input", {
      type: "number", inputmode: "numeric", value: obj[key] ?? "", placeholder, min, max,
      oninput: (e) => {
        const v = e.target.value.trim();
        // 空欄は null（nullable な項目は「既定を使う」、そうでない項目はサーバーの検証で「入力してください」になる）
        obj[key] = v === "" ? null : Number(v);
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

  // 行の色（いまのテーマでの hex）。色の指定: null＝自動、0〜6＝パレットの番号、"#rrggbb"＝独自の色
  // 自動のときは、サーバーと同じ規則でフォームの内容から決める（保存済みなら推移画面と同じ番号になる）。
  function rowColor(a) {
    if (typeof a.color === "string" && HEX.test(a.color)) return a.color;
    if (Number.isInteger(a.color)) return colorOf({ color_slot: a.color });
    const slot = resolveSlots(st.form.accounts, themePalette().length).get(a._key);
    return colorOf({ color_slot: slot ?? 0 });
  }

  function accountRow(a, i, f) {
    const k = a._key;
    const open = st.open === k;
    const isNew = st.newKeys.has(k);
    const auto = a.color == null || a.color === "";
    const color = rowColor(a);
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
      h("span.sw", { style: { background: color }, class: auto ? "is-auto" : "",
        title: auto ? "自動で決めた色" : null }),
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
    const colorField = colorPicker(a, i, ek("color"), () => {
      const sw = head() && head().querySelector(".acct-head .sw");
      if (sw) { sw.style.background = rowColor(a); sw.classList.toggle("is-auto", a.color == null); }
    });
    const test = st.tests.get(k);

    // 新しい id が過去の履歴の id と同じなら、続きとして記録される（エラーではないので、注意だけ出す）
    const histNote = h("span.field-note.tone-text-warn", { hidden: true }, "この id には過去の履歴があります。同じアカウントなら続きとして記録されます。");
    // いま一覧にある別の行と同じ id なら、それは重複のエラー（保存時に 422）なので、この注意は出さない
    const paintHistNote = (v) => {
      const id = (v || "").trim();
      histNote.hidden = !(id && st.historyIds.has(id) && !st.form.accounts.some((x) => x !== a && x.id === id));
    };
    if (isNew) paintHistNote(a.id);
    const idField = isNew
      ? field("id", [textInput(a, "id", { errKey: ek("id"), mono: true, placeholder: "acct-x",
          onInput: (v) => { const el = head()?.querySelector(".acct-id"); if (el) el.textContent = v || "（id 未入力）"; paintHistNote(v); } }), histNote],
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
        field("色", colorField,
          { errKey: ek("color"), div: true, wide: true, help: "パレットの7色は、ライトとダークでそれぞれ見分けやすい色に切り替わります。独自の色は両方のテーマで同じ色です。" }),
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

  // 色の選択: 自動（いま何色になるかも見せる）｜パレット7色（ほかのアカウントが使っている色に印）｜独自の色
  function colorPicker(a, i, errKey, onPaint) {
    const pal = themePalette();
    const accs = st.form.accounts;
    // ほかのアカウントが使っている番号（自動で決まるものも含む）→ 名前
    const slots = resolveSlots(accs, pal.length);
    const usedBy = new Map();
    for (const x of accs) {
      if (x === a) continue;
      const n = slots.get(x._key);
      if (n == null) continue;
      if (!usedBy.has(n)) usedBy.set(n, []);
      usedBy.get(n).push(x.label || x.id || "（名前なし）");
    }
    // 「自動」にしたら何番になるか
    const autoSlot = resolveSlots(accs.map((x) => (x === a ? { ...x, color: null } : x)), pal.length).get(a._key);
    const wrap = h("div.color-choice", { role: "radiogroup", "aria-label": "色" });
    const custom = typeof a.color === "string" && HEX.test(a.color) ? a.color : null;
    const hexInput = h("input.mono.hex", { type: "text", spellcheck: "false", placeholder: "#rrggbb", value: custom || "", "aria-label": "独自の色（#rrggbb）",
      oninput: (e) => {
        const v = e.target.value.trim();
        if (HEX.test(v)) { a.color = v.toLowerCase(); picker.value = a.color; paint(); }
        else if (v === "") { a.color = null; paint(); }
        else { a.color = v; changed(errKey); }
      } });
    const picker = h("input.color-picker", { type: "color", value: custom || rowColor(a), "aria-label": "独自の色を選ぶ", tabindex: "-1",
      oninput: (e) => { a.color = e.target.value; hexInput.value = a.color; paint(); } });
    const opt = (sel, label, attrs, kids) => h("button.cc", { type: "button", role: "radio", "aria-checked": String(sel), title: label, "aria-label": label, ...attrs }, kids);
    const paint = () => {
      for (const b of wrap.querySelectorAll(".cc")) {
        const v = b.dataset.v;
        const sel = v === "auto" ? a.color == null : v === "custom" ? typeof a.color === "string" : Number.isInteger(a.color) && String(a.color) === v;
        b.setAttribute("aria-checked", String(sel));
      }
      wrap.classList.toggle("is-custom", typeof a.color === "string");
      onPaint(); changed(errKey);
    };
    setChildren(wrap,
      opt(a.color == null, `自動（並び順で決める。いまは ${autoSlot + 1} 番の色）`, { dataset: { v: "auto" }, onclick: () => { a.color = null; hexInput.value = ""; paint(); } },
        [h("span.cc-auto", "自動"), h("span.cc-sw.cc-mini", { style: { "--sw": pal[autoSlot] }, "aria-hidden": "true" })]),
      pal.map((c, n) => {
        const users = usedBy.get(n);
        const label = `パレットの ${n + 1} 番${users ? `（${users.map((x) => `「${x}」`).join("")}が使用中）` : ""}`;
        return opt(a.color === n, label, { dataset: { v: String(n) }, style: { "--sw": c }, class: users ? "is-used" : "",
          onclick: () => { a.color = n; hexInput.value = ""; paint(); } },
        [h("span.cc-sw"), users ? h("span.cc-used", { "aria-hidden": "true" }, users.length > 1 ? String(users.length) : "") : null]);
      }),
      h("span.cc-custom", [opt(typeof a.color === "string", "独自の色", { dataset: { v: "custom" }, onclick: () => {
        if (typeof a.color !== "string") { a.color = picker.value; hexInput.value = a.color; paint(); }
        picker.click();
      } }, [h("span.cc-sw.cc-rainbow"), h("span.cc-lbl", "独自")]), picker, hexInput]),
    );
    wrap.classList.toggle("is-custom", typeof a.color === "string");
    return wrap;
  }

  async function runTest(a) {
    const k = a._key;
    st.tests.set(k, { loading: true });
    render();
    try {
      const r = await api.testAccount(a.config_dir);
      st.tests.set(k, { result: r });
    } catch (e) {
      // 429: 別の接続テストがまだ実行中（サーバーは1つずつしか動かさない）
      st.tests.set(k, e.status === 429 ? { busy: true } : { error: e.message });
    }
    render();
  }
  function testResult(t) {
    if (!t || t.loading) return null;
    if (t.busy) return h("span.test-result", [h("span.chip.tone-warn", "実行中です"), h("span.muted", "別の接続テストが終わってから、もう一度押してください。")]);
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
    // 未使用の色番号を明示して保存する（自動の割り当ては並び順で決まるので、あとで別のアカウントを消したときに、
    // ほかのアカウントの色まで変わってしまうため）。全部使われていれば、使っている数がいちばん少ない番号
    const n = themePalette().length;
    const count = new Array(n).fill(0);
    for (const slot of resolveSlots(f.accounts, n).values()) if (slot != null) count[slot]++;
    const free = count.indexOf(Math.min(...count));
    const a = {
      id: cand ? uniqueId(cand.suggested_id) : "",
      label: cand ? cand.suggested_id : "",
      config_dir: cand ? cand.config_dir : "",
      launch_command: null,
      color: free,
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

  // ---- 読み取り専用の項目 -------------------------------------------------------------
  // claude の場所・ホスト・ポートは、画面からは変えられない（ネットワークに出す設定や実行するファイルなので、
  // ファイルを直接編集したときだけ変わるようにする）。古いサーバーは readonly を返さないので、設定の値で代用する。
  function readonlyFields(c, sv) {
    const ro = st.readonly || { claude_path: c.claude_path, host: sv && sv.host, port: sv && sv.port };
    const show = (v) => (v == null || v === "" ? "（自動）" : String(v));
    const item = (label, v) => h("div.field", [h("span.field-label", label), h("code.readonly.mono", show(v)),
      h("span.field-help", "設定ファイルで編集できます。")]);
    return [item("claude の場所", ro.claude_path), item("ホスト", ro.host), item("ポート", ro.port)];
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
        field("1ページのタイル数", h("div.seg.tpp", { role: "group", "aria-label": "1ページのタイル数" }, [4, 6, 8, 9, 12].map((n) =>
          h("button", { type: "button", "aria-pressed": String((ui.tiles_per_page ?? 6) === n), onclick: (e) => {
            ui.tiles_per_page = n;
            for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
            changed("ui.tiles_per_page");
          } }, String(n)))),
          { errKey: "ui.tiles_per_page", div: true, help: "アカウントがこれより多いときだけ、ページに分けます。" }),
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
          ...readonlyFields(c, sv),
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
