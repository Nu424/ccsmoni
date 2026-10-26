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
  return (Math.round(p * 10) / 10).toFixed(p >= 10 || Number.isInteger(p) ? 0 : 1) + "%";
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
    if (hh === 0) return `あと ${mm}分`;
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
  if (s < 3600) return `${Math.ceil(s / 60)}分後`;
  return `${Math.floor(s / 3600)}時間${Math.round((s % 3600) / 60)}分後`;
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

// ---- 色 -----------------------------------------------------------------
// アカウントの色はサーバーから来る（ユーザーが自由に決める）。背景に対して読めないほど
// 暗い／明るい色は、明度だけ調整して線や印に使う（色相は保つので見分けはつく）。
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [136, 136, 136];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function mix(rgb, target, t) {
  return rgb.map((c, i) => Math.round(c + (target[i] - c) * t));
}
const cache = new Map();
export function readableColor(hex, bgHex) {
  const key = hex + bgHex;
  if (cache.has(key)) return cache.get(key);
  const bg = hexToRgb(bgHex);
  let rgb = hexToRgb(hex);
  const toward = lum(bg) < 0.2 ? [255, 255, 255] : [0, 0, 0];
  for (let i = 0; i < 10 && contrast(rgb, bg) < 3; i++) rgb = mix(rgb, toward, 0.18);
  const out = "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
  cache.set(key, out);
  return out;
}
export function withAlpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// CSS 変数（テーマのトークン）を JS 側で読む。canvas に描くグラフで使う。
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
