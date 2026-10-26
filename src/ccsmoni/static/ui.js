// 共通部品と書式。
// 何を: DOM の組み立て、バー・チップ・セグメントボタン・トースト、時刻やパーセントの書式。
// なぜ: 推移画面と設定画面で同じ見た目・同じふるまいにするため、部品はここで一度だけ定義する。
// 方針: フレームワークは使わず、h() で要素を作る小さな関数群にする。状態は持たない（トーストを除く）。

// ---- DOM ヘルパー -------------------------------------------------------
// h("div.card.is-ok", {onclick}, [子...]) の形で要素を作る。文字列・数値の子はテキストになる。
// 子の扱い（ここで一度だけ決めて、呼び出し側で気にしなくてよいようにする）:
//   - null / undefined / true / false は何も出さない（`cond ? h(...) : null` や `cond && h(...)` をそのまま書ける）
//   - 配列は入れ子でも平らにする（以前は1段しか平らにせず、[a, [null, null]] の内側の配列が String() されて
//     「,」が画面に出ていた。append() に null を直接渡すと「null」という文字になるのも同じ種類の事故）
//   - 第2引数が属性でない（文字列・数値・Node・配列・null）なら、それを子として扱う
export function h(tag, attrs = {}, children = []) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs == null || typeof attrs !== "object" || Array.isArray(attrs) || attrs instanceof Node) {
    if (attrs != null || arguments.length < 3) children = attrs;
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value") el.value = v; // textarea は属性ではなくプロパティで入れる
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...nodes(children));
  return el;
}

// 子の指定（h() の children と同じ書き方）を Node の配列にする。
// replaceChildren(...) / append(...) に null や配列を渡すと「null」「a,b」という文字になってしまうので、
// h() を通さずに子を入れ替えるときも、必ずこれを通す（setChildren を使う）。
export function nodes(children) {
  const out = [];
  const walk = (c) => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    out.push(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  walk(children);
  return out;
}
export function setChildren(el, ...children) {
  el.replaceChildren(...nodes(children));
  return el;
}

// localStorage は使えない環境（プライベートウィンドウ等）があるので、必ずこの2つを通す。
export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem("ccsmoni." + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function savePref(key, value) {
  try {
    if (value === undefined) localStorage.removeItem("ccsmoni." + key);
    else localStorage.setItem("ccsmoni." + key, JSON.stringify(value));
  } catch { /* 保存できなくても画面は動く */ }
}

// ---- 書式 -----------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
const WD = ["日", "月", "火", "水", "木", "金", "土"];

export function fmtPct(p) {
  if (p == null || Number.isNaN(p)) return "—";
  // 丸めたあとの値で桁を決める（9.96 → 「10.0%」ではなく「10%」）
  const r = Math.round(p * 10) / 10;
  return r.toFixed(r >= 10 || Number.isInteger(r) ? 0 : 1) + "%";
}

// 「2分前」「たった今」。now, t は epoch 秒。
export function fmtAgo(t, now) {
  if (!t) return "—";
  const s = Math.max(0, now - t);
  if (s < 10) return "たった今";
  if (s < 60) return `${Math.floor(s)}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

// 「あと 1:12」「あと 3日 4時間」。t が過去なら null（呼び出し側で「リセット済み」と出す）。
export function fmtCountdown(t, now) {
  const s = t - now;
  if (s <= 0) return null;
  if (s < 86400) {
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    if (hh === 0) return mm ? `あと ${mm}分` : "あと 1分未満";
    return `あと ${hh}:${pad2(mm)}`;
  }
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600);
  return hh ? `あと ${d}日 ${hh}時間` : `あと ${d}日`;
}

// 「3分後」「まもなく」
export function fmtIn(t, now) {
  if (!t) return "—";
  const s = t - now;
  if (s <= 15) return "まもなく";
  // 分に切り上げてから時間と分に分ける（先に時間を割ると「1時間60分後」「60分後」になる）
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}分後`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh}時間${mm}分後` : `${hh}時間後`;
}

export function fmtClock(t) {
  const d = new Date(t * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtDateTime(t, withWeekday = true) {
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}${withWeekday ? `(${WD[d.getDay()]})` : ""} ${fmtClock(t)}`;
}
export function fmtDate(t) {
  const d = new Date(t * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 使用率の3段階（ok / warn / danger）。しきい値はサーバーの ui 設定。
export function level(p, ui) {
  if (p == null) return "none";
  if (p >= ui.danger_percent) return "danger";
  if (p >= ui.warn_percent) return "warn";
  return "ok";
}

// ログインが終わったあと、取り直した結果がもう state に入っているか。
// 完了（finished_at。古いサーバーには無いので started_at）より後に取得していれば取り直し済み。
// 推移画面の表示（スピナーを出すか）と、app.js の「速く問い合わせるか」で同じ判定を使う。
export function loginRetaken(a) {
  const lg = a && a.login;
  if (!lg) return true;
  const since = lg.finished_at ?? lg.started_at;
  return a.taken_at != null && since != null && a.taken_at >= since;
}

// ---- バー -----------------------------------------------------------------
// 使用率のミニバー。expected があれば「均等に使ったらここ」の目盛りを置く。
export function bar(percent, { ui, expected = null, faded = false } = {}) {
  const lv = level(percent, ui);
  const wrap = h("div.bar", { class: `lv-${lv}${faded ? " is-faded" : ""}`, role: "img",
    "aria-label": `使用率 ${fmtPct(percent)}` + (expected != null ? `、目安 ${fmtPct(expected)}` : "") });
  wrap.append(h("div.bar-fill", { style: { width: `${Math.max(0, Math.min(100, percent ?? 0))}%` } }));
  if (expected != null) {
    wrap.append(h("div.bar-tick", { style: { left: `${Math.max(0, Math.min(100, expected))}%` },
      title: `均等に使った場合の目安: ${fmtPct(expected)}` }));
  }
  return wrap;
}

// ---- チップ -----------------------------------------------------------------
const STATUS = {
  ok: ["OK", "ok"],
  logged_out: ["ログイン切れ", "danger"],
  error: ["取得失敗", "danger"],
  timeout: ["タイムアウト", "warn"],
  parse_error: ["形式不明", "warn"],
  never: ["未取得", "muted"],
  stale: ["データが古い", "warn"],
};
export function statusChip(status) {
  const [text, tone] = STATUS[status] || [status, "muted"];
  return h("span.chip", { class: `tone-${tone}` }, text);
}
export function chip(text, tone = "muted", attrs = {}) {
  return h("span.chip", { class: `tone-${tone}`, ...attrs }, text);
}

// ---- セグメントボタン ---------------------------------------------------------
// options: [{value, label}]。選ばれているものは aria-pressed で示す。
export function segmented(options, value, onChange, label = "") {
  return h("div.seg", { role: "group", "aria-label": label },
    options.map((o) => h("button", {
      type: "button", "aria-pressed": String(o.value === value),
      onclick: () => { if (o.value !== value) onChange(o.value); },
    }, o.label)));
}

// ---- スピナー -----------------------------------------------------------------
export const spinner = () => h("span.spinner", { "aria-hidden": "true" });

// ---- トースト -----------------------------------------------------------------
// 一時的なお知らせ。tone: info / ok / warn / danger。3.2 秒で消える（押すとすぐ消える）。
export function toast(text, tone = "info", ms = 3200) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const t = h("div.toast", { class: `tone-${tone}`, role: "status", onclick: () => t.remove() }, text);
  box.append(t);
  requestAnimationFrame(() => t.classList.add("is-in"));
  setTimeout(() => { t.classList.remove("is-in"); setTimeout(() => t.remove(), 250); }, ms);
}

// クリップボードへのコピー（http の tailnet 経由だと navigator.clipboard が無いので代替を用意）
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("コピーしました", "ok", 1800);
  } catch {
    toast("コピーできませんでした", "warn");
  }
}

// コピーボタン付きのコマンド表示
export function copyCmd(text) {
  return h("div.cmd", [
    h("code", text),
    h("button.btn.btn-ghost.btn-xs", { type: "button", onclick: (e) => { e.stopPropagation(); copyText(text); } }, "コピー"),
  ]);
}

// ---- アイコン（16px の線画。currentColor で塗る） ------------------------------
const ICONS = {
  warn: '<path d="M8 2.2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/>',
  crit: '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  err: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.6M8 10.8v.1"/>',
  tip: '<path d="M6 12.5h4M6.5 14.5h3M8 1.8a4.2 4.2 0 0 0-2.4 7.7c.5.4.8.9.8 1.5h3.2c0-.6.3-1.1.8-1.5A4.2 4.2 0 0 0 8 1.8z"/>',
  ok: '<path d="M3 8.5l3 3 7-7"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.6"/>',
  off: '<circle cx="8" cy="8" r="6"/><path d="M3.8 12.2l8.4-8.4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  left: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  right: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  zoom: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14M5 7h4M7 5v4"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  key: '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11.5 4.5l1.8 1.8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
};
export function icon(name, cls = "i") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

// CSS 変数（テーマのトークン）を JS 側で読む。canvas に描くグラフで使う。
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 「6時間20分」「2日 4時間」（長さ。範囲の表示・ドラッグ中の表示に使う）
export function fmtSpan(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60);
  if (d >= 3) return hh ? `${d}日 ${hh}時間` : `${d}日`;
  if (d > 0) return !hh && !mm ? `${d}日` : `${d}日 ${hh}時間${mm && d < 2 ? `${mm}分` : ""}`;
  if (hh > 0) return mm ? `${hh}時間${mm}分` : `${hh}時間`;
  return `${Math.max(1, mm)}分`;
}
