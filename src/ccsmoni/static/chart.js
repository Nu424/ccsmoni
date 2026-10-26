// グラフの描画（canvas）。タイル・重ね合わせ・5h レーン・時間軸のストリップの共通部品。
// 何を: Plot（canvas 2枚: base＝データ、ovl＝カーソル・選択範囲）と、それぞれの描き方。
// なぜ: 4種類のグラフで、x の写像・目盛り・点の間引き・抜けやエラーの描き方を同じにするため。
// 方針:
//   - x は TimeViewport の shown（start, end）から決める。範囲外の点は二分探索で飛ばす。
//   - 1画素の列に点がいくつも入るときは、その列の最初・最小・最大・最後だけを描く（30日・12アカウントでも軽い）。
//   - 点（マーカー）は画素密度で決める: 取得の間隔が 6px 以上なら全点、それ未満なら値が変わった点だけ、さらに密なら終端だけ。
//   - 色はトークン（CSS 変数）から読む。テーマが変わったら invalidateTokens()。

import { lowerBound, upperBound, nearest } from "./history.js";
import { rgba, isDark } from "./colors.js";
import { fmtDate, fmtSpan, fmtAgo } from "./ui.js";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const pad2 = (n) => String(n).padStart(2, "0");

// ---- テーマのトークン（1フレームに何度も getComputedStyle しない） ----
let TK = null;
export function invalidateTokens() { TK = null; }
export function tokens() {
  if (TK) return TK;
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  TK = {
    font: v("--font"), surface: v("--surface"), grid: v("--grid"), axis: v("--axis"),
    ink: v("--ink"), ink2: v("--ink-2"), ink3: v("--ink-3"), ink4: v("--ink-4"),
    hatch: v("--hatch"), crit: v("--st-crit"), critInk: v("--st-crit-ink"), serious: v("--st-serious"),
    critSoft: v("--st-crit-soft"), lineStrong: v("--line-strong"), sel: v("--sel"), selLine: v("--sel-line"),
    track: v("--track"), focus: v("--focus"), dark: isDark(),
  };
  return TK;
}

// ---- Plot: 1つのグラフの面 ----
const PADS = {
  tile: { l: 34, r: 38, t: 10, b: 18 },
  overlay: { l: 84, r: 150, t: 12, b: 22 },
  lanes: { l: 84, r: 150, t: 20, b: 6 },
  strip: { l: 0, r: 0, t: 0, b: 0 },
};
export class Plot {
  constructor(el, kind) {
    this.el = el;
    this.kind = kind;
    this.base = document.createElement("canvas");
    this.base.className = "base";
    this.ovl = document.createElement("canvas");
    this.ovl.className = "ovl";
    el.append(this.base, this.ovl);
    this.w = 1; this.h = 1;
    this.narrow = false;
    this.measure();
  }
  // canvas は枠線の内側（padding box）に敷くので、大きさも内側で測る。変わったら true
  measure() {
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    const changed = w !== this.w || h !== this.h;
    this.w = w; this.h = h;
    this.narrow = this.w < 560;
    return changed;
  }
  // 画面座標 → この面の座標（枠線の分を引く）
  local(clientX, clientY = 0) {
    const r = this.el.getBoundingClientRect();
    return { x: clientX - r.left - this.el.clientLeft, y: clientY - r.top - this.el.clientTop };
  }
  destroy() { this.base.remove(); this.ovl.remove(); this.mmCache = null; }
  get pad() {
    const p = { ...PADS[this.kind] };
    if ((this.kind === "overlay" || this.kind === "lanes") && this.narrow) { p.l = this.kind === "lanes" ? 26 : 34; p.r = 50; }
    if (this.kind === "lanes" && this.alignTo) { p.l = this.alignTo.pad.l; p.r = this.alignTo.pad.r; }
    if (this.padOverride) Object.assign(p, this.padOverride);
    return p;
  }
  frame() {
    const P = this.pad;
    return { l: P.l, r: this.w - P.r, t: P.t, b: this.h - P.b, w: Math.max(1, this.w - P.l - P.r), h: Math.max(1, this.h - P.t - P.b) };
  }
  // canvas を用意して消す
  ctx(which = "base") {
    const cv = which === "base" ? this.base : this.ovl;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(this.w * dpr), H = Math.round(this.h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    return c;
  }
  xmap(vp) {
    const F = this.frame();
    const s = vp.start, k = F.w / (vp.end - vp.start);
    return { F, X: (t) => F.l + (t - s) * k, T: (px) => s + (px - F.l) / k };
  }
  // 画面座標 → 時刻（グラフの外なら null。margin だけははみ出しを許す）
  tAt(clientX, vp, margin = 6) {
    const { F, T } = this.xmap(vp);
    const px = this.local(clientX).x;
    if (px < F.l - margin || px > F.r + margin) return null;
    return T(Math.max(F.l, Math.min(F.r, px)));
  }
}

// ---- 目盛り ----
const STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 345600, 604800, 1209600];
export function xticks(s, e, w, minPx = 62) {
  const span = e - s;
  const step = STEPS.find((x) => (x / span) * w >= minPx) || STEPS[STEPS.length - 1];
  const o = -new Date(e * 1000).getTimezoneOffset() * 60;
  const base = step >= 604800 ? 86400 : step;
  const out = [];
  for (let t = Math.ceil((s + o) / base) * base - o; t <= e; t += base) {
    const d = new Date(t * 1000);
    const day = d.getHours() === 0 && d.getMinutes() === 0;
    if (step >= 604800 && (Math.round((t + o) / 86400) % (step / 86400)) !== 0) continue;
    out.push({ t, day, step, label: day || step >= 86400 ? fmtDate(t) : `${d.getHours()}:${pad2(d.getMinutes())}` });
  }
  return out;
}

function drawGrid(c, F, X, s, e, { yLabels = [0, 50, 100], xLabels = true, Y } = {}) {
  const K = tokens();
  c.lineWidth = 1;
  c.font = `10.5px ${K.font}`;
  for (const v of [25, 50, 75, 100]) {
    c.strokeStyle = K.grid; c.globalAlpha = v % 50 ? 0.55 : 1;
    const y = Math.round(Y(v)) + 0.5;
    c.beginPath(); c.moveTo(F.l, y); c.lineTo(F.r, y); c.stroke();
  }
  c.globalAlpha = 1;
  c.fillStyle = K.ink3; c.textAlign = "right"; c.textBaseline = "middle";
  for (const v of yLabels) c.fillText(v + "%", F.l - 6, Y(v));
  c.textAlign = "center"; c.textBaseline = "top";
  for (const tk of xticks(s, e, F.w)) {
    const x = Math.round(X(tk.t)) + 0.5;
    c.strokeStyle = K.grid; c.globalAlpha = tk.day ? 1 : 0.6;
    c.beginPath(); c.moveTo(x, F.t); c.lineTo(x, F.b); c.stroke();
    c.globalAlpha = 1;
    if (xLabels && x > F.l + 14 && x < F.r - 10) c.fillText(tk.label, x, F.b + 5);
  }
  c.strokeStyle = K.axis;
  c.beginPath(); c.moveTo(F.l, Math.round(F.b) + 0.5); c.lineTo(F.r, Math.round(F.b) + 0.5); c.stroke();
}

function hatch(c, x0, x1, top, bottom, color) {
  if (x1 - x0 < 0.5) return;
  c.save();
  c.beginPath(); c.rect(x0, top, x1 - x0, bottom - top); c.clip();
  c.strokeStyle = color || tokens().hatch; c.lineWidth = 1;
  c.beginPath();
  const hgt = bottom - top;
  for (let x = Math.floor(x0 / 5) * 5 - hgt; x < x1; x += 5) { c.moveTo(x, bottom); c.lineTo(x + hgt, top); }
  c.stroke();
  c.restore();
}

// 見えている範囲の添字（前後に1点ずつ余分に含めて、線が端で切れないようにする）
function visRange(arr, s, e) {
  return [Math.max(0, lowerBound(arr, s) - 1), Math.min(arr.length, upperBound(arr, e) + 1)];
}
// 区間（線の切れ目で分けたもの）ごとに cb(i0, i1)
function eachSeg(arr, i0, i1, brk, cb) {
  let a = i0;
  for (let i = i0 + 1; i <= i1; i++) {
    if (i === i1 || brk(arr[i - 1], arr[i])) { if (i > a) cb(a, i); a = i; }
  }
}
// 1つの区間をなぞる（1画素の列ごとに 最初・最小・最大・最後 だけ）。first: "move" | "line"
function trace(c, arr, i0, i1, X, Y, first = "move") {
  let col = NaN, fx = 0, fy = 0, mn = 0, mx = 0, lx = 0, ly = 0, open = false;
  const flush = () => {
    if (!open) return;
    c.lineTo(fx, fy);
    const mid = (fx + lx) / 2;
    if (mn < Math.min(fy, ly)) c.lineTo(mid, mn);
    if (mx > Math.max(fy, ly)) c.lineTo(mid, mx);
    c.lineTo(lx, ly);
    open = false;
  };
  for (let i = i0; i < i1; i++) {
    const p = arr[i];
    const x = X(p[0]), y = Y(p[1]);
    if (i === i0) {
      if (first === "move") c.moveTo(x, y); else c.lineTo(x, y);
      col = Math.floor(x); fx = lx = x; fy = ly = mn = mx = y; open = true;
      continue;
    }
    const cc = Math.floor(x);
    if (cc !== col) { flush(); col = cc; fx = lx = x; fy = ly = mn = mx = y; open = true; }
    else { lx = x; ly = y; if (y < mn) mn = y; if (y > mx) mx = y; }
  }
  flush();
}
function strokeSeries(c, arr, s, e, brk, X, Y) {
  const [i0, i1] = visRange(arr, s, e);
  c.beginPath();
  eachSeg(arr, i0, i1, brk, (a, b) => trace(c, arr, a, b, X, Y, "move"));
  c.stroke();
}
function fillSeries(c, arr, s, e, brk, X, Y, base) {
  const [i0, i1] = visRange(arr, s, e);
  c.beginPath();
  eachSeg(arr, i0, i1, brk, (a, b) => {
    c.moveTo(X(arr[a][0]), base);
    trace(c, arr, a, b, X, Y, "line");
    c.lineTo(X(arr[b - 1][0]), base);
    c.closePath();
  });
  c.fill();
}
// 点を打つ取得（画素密度で決める）
function markerIdx(arr, s, e, X, iv, span, w) {
  const [i0, i1] = [lowerBound(arr, s), upperBound(arr, e)];
  if (i1 - i0 <= 0) return [];
  const pxPer = (iv / span) * w;
  const out = [];
  if (pxPer >= 6) { for (let i = i0; i < i1; i++) out.push(i); return out; }
  const chg = [];
  for (let i = i0; i < i1; i++) if (i === 0 || arr[i][1] !== arr[i - 1][1] || arr[i][2] !== arr[i - 1][2]) chg.push(i);
  if (chg.length && w / chg.length >= 6) {
    let lastX = -99;
    for (const i of chg) { const x = X(arr[i][0]); if (x - lastX >= 6) { out.push(i); lastX = x; } }
    return out;
  }
  return [];
}
export function dot(c, x, y, r, fill, ring, ringW = 2) {
  c.beginPath(); c.arc(x, y, r + ringW, 0, Math.PI * 2); c.fillStyle = ring; c.fill();
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
}
function lastVisible(arr, e) {
  const i = upperBound(arr, e) - 1;
  return i >= 0 ? arr[i] : null;
}
const clampY = (y, F) => Math.max(F.t + 4, Math.min(F.b - 4, y));
export function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

// エラーの帯を画素に直す。広い範囲で短いエラーが点線のように並ばないよう、4px より近いものはまとめ、
// 短いもの（1.5px 未満）だけでできた帯は薄くする
function bandRuns(D, X, F, s, e) {
  const out = [];
  for (const b of D.bands) {
    if (b.to < s || b.from > e) continue;
    const x0 = Math.max(F.l, X(b.from)), x1 = Math.min(F.r, X(b.to));
    const blip = x1 - x0 < 1.5;
    const last = out[out.length - 1];
    if (last && x0 - last.x1 < 4) {
      last.x1 = Math.max(last.x1, x1); last.blip = last.blip && blip;
      if (b.status === "logged_out") last.status = "logged_out";
    } else out.push({ x0, x1, blip, status: b.status });
  }
  return out;
}
// 背景: 取得の抜け（斜線）・エラーの帯（薄い面）
function drawBackdrops(c, D, X, F, s, e) {
  const K = tokens();
  for (const g of D.gaps) if (g.to > s && g.from < e) hatch(c, Math.max(F.l, X(g.from)), Math.min(F.r, X(g.to)), F.t, F.b);
  for (const r of bandRuns(D, X, F, s, e)) {
    if (r.blip) continue;
    c.fillStyle = K.critSoft; c.fillRect(r.x0, F.t, r.x1 - r.x0, F.h);
  }
}
function drawBandStrips(c, D, X, F, s, e, y, hgt) {
  const K = tokens();
  for (const r of bandRuns(D, X, F, s, e)) {
    c.globalAlpha = r.blip ? 0.45 : 1;
    c.fillStyle = r.status === "logged_out" ? K.crit : K.serious;
    c.fillRect(r.x0, y, Math.max(2, r.x1 - r.x0), hgt);
  }
  c.globalAlpha = 1;
}
// 文字の縁取り（背景色）。線の上に重なっても読めるように
function haloText(c, txt, x, y) {
  c.save();
  c.lineWidth = 3.5; c.lineJoin = "round"; c.strokeStyle = tokens().surface; c.globalAlpha = 1;
  c.strokeText(txt, x, y);
  c.restore();
  c.fillText(txt, x, y);
}
function drawResets(c, D, X, F, s, e) {
  const K = tokens();
  c.lineWidth = 1;
  c.strokeStyle = K.ink3; c.globalAlpha = 0.55;
  for (const t of D.wkRes) { if (t < s || t > e) continue; const x = Math.round(X(t)) + 0.5; c.beginPath(); c.moveTo(x, F.t - 4); c.lineTo(x, F.b); c.stroke(); }
  c.globalAlpha = 1;
  c.strokeStyle = K.ink4;
  for (const t of D.ssRes) { if (t < s || t > e) continue; const x = Math.round(X(t)) + 0.5; c.beginPath(); c.moveTo(x, F.b - 5); c.lineTo(x, F.b); c.stroke(); }
}
function emptyText(c, F, text, at = 0.5) {
  const K = tokens();
  c.font = `12px ${K.font}`; c.fillStyle = K.ink3; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillText(text, F.l + F.w / 2, F.t + F.h * at);
}

// =====================================================================
// タイル: 週間の線＋点、5h の薄い面、リセット線、抜け、エラーの区間、終端の値
// =====================================================================
// lastOk: { v, t, now }（ログイン切れ・エラーのとき、最後にわかった週間の値。薄い点線で示す）
export function drawTile(plot, vp, D, { color, faded = false, loading = false, lastOk = null }) {
  const c = plot.ctx("base");
  const K = tokens();
  const { F, X } = plot.xmap(vp);
  const Y = (v) => F.b - (v / 100) * F.h;
  const s = vp.start, e = vp.end;
  if (!D) { drawGrid(c, F, X, s, e, { Y }); emptyText(c, F, loading ? "読み込み中…" : ""); return; }
  drawBackdrops(c, D, X, F, s, e);
  drawGrid(c, F, X, s, e, { Y, xLabels: true });
  drawResets(c, D, X, F, s, e);
  if (lastOk) drawLastOk(c, F, X, Y, lastOk, color, vp);
  c.save();
  // 左端は範囲の端で切る（範囲の外の点の丸い端が残らないように）。右端は終端の点のぶんだけ余白
  c.beginPath(); c.rect(F.l, 0, F.w + 8, plot.h); c.clip();
  if (faded) c.globalAlpha = 0.45;
  // 5h: 面＋上辺の細い線
  c.fillStyle = rgba(color, K.dark ? 0.10 : 0.11);
  fillSeries(c, D.ss, s, e, D.brk, X, Y, F.b);
  c.lineWidth = 1; c.strokeStyle = rgba(color, K.dark ? 0.30 : 0.38); c.lineJoin = "round";
  strokeSeries(c, D.ss, s, e, D.brk, X, Y);
  // 週間: 2px の線＋点
  c.lineWidth = 2; c.strokeStyle = color; c.lineCap = "round";
  strokeSeries(c, D.wk, s, e, D.brk, X, Y);
  for (const i of markerIdx(D.wk, s, e, X, D.iv, e - s, F.w)) dot(c, X(D.wk[i][0]), Y(D.wk[i][1]), 2.1, color, K.surface, 1.4);
  c.globalAlpha = 1;
  c.restore();
  drawBandStrips(c, D, X, F, s, e, F.b - 3, 3);
  const hasWk = upperBound(D.wk, e) - lowerBound(D.wk, s) > 0;
  const hasSs = upperBound(D.ss, e) - lowerBound(D.ss, s) > 0;
  if (!hasWk && !hasSs) {
    const inBand = D.bands.some((b) => b.to > s && b.from < e);
    emptyText(c, F, loading ? "読み込み中…" : inBand ? "この期間は取得できていません" : "この期間の記録はありません", lastOk ? (lastOk.v < 50 ? 0.35 : 0.72) : 0.5);
    return;
  }
  // 終端（見えている最後の取得）: 点と値のラベル
  const lw = lastVisible(D.wk, e), ls = lastVisible(D.ss, e);
  if (faded) c.globalAlpha = 0.5;
  c.font = `600 11px ${K.font}`; c.textBaseline = "middle"; c.textAlign = "left";
  let yw = lw ? Y(lw[1]) : null, ys = ls ? Y(ls[1]) : null;
  if (ls && ls[0] >= s) dot(c, X(ls[0]), Y(ls[1]), 2.6, color, K.surface, 1.6);
  if (lw && lw[0] >= s) dot(c, X(lw[0]), Y(lw[1]), 4, color, K.surface, 2);
  if (yw != null && ys != null && Math.abs(yw - ys) < 13) { const m = (yw + ys) / 2; if (yw <= ys) { yw = m - 6.5; ys = m + 6.5; } else { yw = m + 6.5; ys = m - 6.5; } }
  // 終端の値は、プロット領域の右（余白）に縁取りつきで出す。終端が右端から離れている（過去に移動した）ときは出さない
  // （範囲の右端より後にまだ点がある＝過去を見ているときは、線の途中なので出さない）
  const atEnd = (arr, p) => p && !lastOk && (X(p[0]) > F.r - 30 || upperBound(arr, e) === arr.length);
  const lx = (p) => (X(p[0]) > F.r - 30 ? Math.max(F.r + 6, X(p[0]) + 8) : X(p[0]) + 8);
  if (atEnd(D.wk, lw)) { c.fillStyle = K.ink; haloText(c, Math.round(lw[1]) + "%", lx(lw), clampY(yw, F)); }
  if (atEnd(D.ss, ls)) { c.font = `500 10.5px ${K.font}`; c.fillStyle = K.ink3; haloText(c, Math.round(ls[1]) + "%", lx(ls), clampY(ys, F)); }
  c.globalAlpha = 1;
}
// 最後にわかった値: 取得した時刻から右端まで、薄い点線の水平線と「最後 17%（1日前）」
function drawLastOk(c, F, X, Y, lo, color, vp) {
  const K = tokens();
  if (lo.t > vp.end) return;
  const x0 = Math.max(F.l, X(lo.t)), y = Math.round(Y(lo.v)) + 0.5;
  c.save();
  c.setLineDash([2, 4]); c.lineWidth = 1.5; c.strokeStyle = rgba(color, 0.8); c.lineCap = "round";
  c.beginPath(); c.moveTo(x0, y); c.lineTo(F.r, y); c.stroke();
  c.setLineDash([]);
  const txt = `最後 ${Math.round(lo.v)}%（${fmtAgo(lo.t, lo.now)}）`;
  c.font = `600 11px ${K.font}`; c.fillStyle = K.ink2; c.textAlign = "right"; c.textBaseline = "bottom";
  const ty = y - 4 < F.t + 12 ? y + 15 : y - 4;
  haloText(c, txt, F.r - 4, ty);
  c.restore();
}

// =====================================================================
// 重ね合わせ: 線＋点、終端に「値＋名前」の直接ラベル（重ならないよう縦にずらす）
// list: [{id, label, color, D, dash}]（dash: 色が重なるアカウントの破線）
// =====================================================================
export function drawOverlay(plot, vp, list, kind, focus) {
  const c = plot.ctx("base");
  const K = tokens();
  const { F, X } = plot.xmap(vp);
  const Y = (v) => F.b - (v / 100) * F.h;
  const s = vp.start, e = vp.end;
  drawGrid(c, F, X, s, e, { Y, yLabels: [0, 25, 50, 75, 100] });
  const order = focus ? [...list.filter((x) => x.id !== focus), ...list.filter((x) => x.id === focus)] : list;
  const labels = [];
  c.save();
  c.beginPath(); c.rect(F.l, 0, F.w + 8, plot.h); c.clip();
  for (const L of order) {
    const D = L.D;
    if (!D) continue;
    const arr = kind === "session" ? D.ss : D.wk;
    const dashed = !!(L.dash && L.dash.length);
    c.globalAlpha = focus && focus !== L.id ? 0.16 : 1;
    c.lineWidth = 2; c.strokeStyle = L.color; c.lineJoin = "round"; c.lineCap = dashed ? "butt" : "round";
    c.setLineDash(dashed ? L.dash : []);
    strokeSeries(c, arr, s, e, D.brk, X, Y);
    c.setLineDash([]);
    for (const i of markerIdx(arr, s, e, X, D.iv, e - s, F.w)) dot(c, X(arr[i][0]), Y(arr[i][1]), 2, L.color, K.surface, 1.3);
    const lp = lastVisible(arr, e);
    if (lp && lp[0] >= s) {
      dot(c, X(lp[0]), Y(lp[1]), 4, L.color, K.surface, 2);
      labels.push({ L, x: X(lp[0]), y: Y(lp[1]), v: lp[1], ended: lp[0] < e - D.iv * 3 && vp.follow });
    }
    c.globalAlpha = 1;
  }
  c.restore();
  // 直接ラベル
  labels.sort((p, q) => p.y - q.y);
  const gapY = 16;
  for (let i = 0; i < labels.length; i++) labels[i].ly = Math.max(labels[i].y, i ? labels[i - 1].ly + gapY : F.t);
  const over = labels.length ? labels[labels.length - 1].ly - (F.b - 4) : 0;
  if (over > 0) for (let i = labels.length - 1; i >= 0; i--) labels[i].ly = Math.min(labels[i].ly - over, i < labels.length - 1 ? labels[i + 1].ly - gapY : Infinity);
  const lx = F.r + (plot.narrow ? 6 : 16);
  for (const lb of labels) {
    c.globalAlpha = focus && focus !== lb.L.id ? 0.35 : 1;
    c.strokeStyle = K.lineStrong; c.lineWidth = 1;
    if (Math.abs(lb.ly - lb.y) > 1 || !plot.narrow) { c.beginPath(); c.moveTo(lb.x + 6, lb.y); c.lineTo(lx - (plot.narrow ? 2 : 10), lb.ly); if (!plot.narrow) c.lineTo(lx - 4, lb.ly); c.stroke(); }
    const kx = plot.narrow ? 0 : 15;
    if (!plot.narrow) { c.strokeStyle = lb.L.color; c.lineWidth = 2; c.setLineDash(lb.L.dash && lb.L.dash.length ? [3, 2] : []); c.beginPath(); c.moveTo(lx, lb.ly); c.lineTo(lx + 10, lb.ly); c.stroke(); c.setLineDash([]); }
    c.textBaseline = "middle"; c.textAlign = "left";
    c.font = `650 12px ${K.font}`; c.fillStyle = K.ink;
    const vs = Math.round(lb.v) + "%";
    c.fillText(vs, lx + kx, lb.ly);
    if (!plot.narrow) {
      const vw = c.measureText(vs).width;
      c.font = `12px ${K.font}`; c.fillStyle = K.ink2;
      c.fillText(lb.L.label + (lb.ended ? "（途切れ）" : ""), lx + 19 + vw, lb.ly);
    }
    c.globalAlpha = 1;
  }
  if (!list.length) emptyText(c, F, "表示するアカウントがありません");
}

// =====================================================================
// 5h レーン: アカウントごとに1行の小さな面（x 軸は重ね合わせと共有）
// =====================================================================
export const LANE = { h: 18, gap: 4 };
export function lanesHeight(n) { return PADS.lanes.t + n * (LANE.h + LANE.gap) - LANE.gap + PADS.lanes.b; }
export function laneTop(i) { return PADS.lanes.t + i * (LANE.h + LANE.gap); }
// kind: レーンに出す値（上の重ね合わせが 5h のときは、同じ内容にならないよう週間にする）
export function drawLanes(plot, vp, list, focus, kind = "session") {
  const c = plot.ctx("base");
  const K = tokens();
  const { F, X } = plot.xmap(vp);
  const s = vp.start, e = vp.end;
  const wk = kind === "weekly_all";
  c.font = `600 11px ${K.font}`; c.fillStyle = K.ink2; c.textAlign = "left"; c.textBaseline = "alphabetic";
  c.fillText(wk ? "週間" : "5時間枠", plot.narrow ? 4 : 10, 13);
  c.font = `10.5px ${K.font}`; c.fillStyle = K.ink3; c.textAlign = "right";
  c.fillText(plot.narrow ? "今" : wk ? "今の週間" : "今の 5h", plot.w - 8, 13);
  list.forEach((L, i) => {
    const top = laneTop(i), hh = LANE.h, bot = top + hh;
    const D = L.D;
    const dim = focus && focus !== L.id;
    c.globalAlpha = dim ? 0.3 : 1;
    c.fillStyle = K.grid; c.globalAlpha *= 0.7;
    roundRect(c, F.l, top, F.w, hh, 3); c.fill();
    c.globalAlpha = dim ? 0.3 : 1;
    if (D) {
      for (const g of D.gaps) if (g.to > s && g.from < e) hatch(c, Math.max(F.l, X(g.from)), Math.min(F.r, X(g.to)), top, bot);
      c.save(); c.beginPath(); c.rect(F.l, top, F.w, hh); c.clip();
      const Y = (v) => bot - (v / 100) * hh;
      const arr = wk ? D.wk : D.ss;
      c.fillStyle = rgba(L.color, K.dark ? 0.42 : 0.32);
      fillSeries(c, arr, s, e, D.brk, X, Y, bot);
      c.lineWidth = 1.2; c.strokeStyle = L.color; c.lineJoin = "round";
      strokeSeries(c, arr, s, e, D.brk, X, Y);
      c.restore();
      for (const r of bandRuns(D, X, F, s, e)) {
        hatch(c, r.x0, Math.max(r.x1, r.x0 + 2), top, bot, rgba(K.crit.startsWith("#") ? K.crit : "#d03b3b", r.blip ? 0.3 : 0.55));
      }
    }
    // 名前（左）と見えている最後の 5h（右）
    const dashed = !!(L.dash && L.dash.length);
    c.strokeStyle = L.color; c.lineWidth = 2; c.lineCap = dashed ? "butt" : "round";
    c.setLineDash(dashed ? [3, 2] : []);
    const midY = top + hh / 2;
    c.beginPath(); c.moveTo(plot.narrow ? 6 : 10, midY); c.lineTo(plot.narrow ? 18 : 20, midY); c.stroke();
    c.setLineDash([]);
    if (!plot.narrow) {
      c.font = `12px ${K.font}`; c.fillStyle = K.ink2; c.textAlign = "left"; c.textBaseline = "middle";
      let nm = L.label;
      while (nm.length > 1 && c.measureText(nm).width > F.l - 34) nm = nm.slice(0, -1);
      c.fillText(nm === L.label ? nm : nm + "…", 26, midY);
    }
    c.textAlign = "left"; c.textBaseline = "middle";
    const lp = D ? lastVisible(wk ? D.wk : D.ss, e) : null;
    const nowV = wk ? L.nowWk : L.now5h;
    if (nowV != null && vp.follow) { c.font = `650 12px ${K.font}`; c.fillStyle = K.ink; c.fillText(Math.round(nowV) + "%", F.r + 12, midY); }
    else if (L.nowText && vp.follow) { c.font = `11px ${K.font}`; c.fillStyle = K.critInk; c.fillText(plot.narrow ? "切れ" : L.nowText, F.r + 12, midY); }
    else if (lp) { c.font = `600 12px ${K.font}`; c.fillStyle = K.ink2; c.fillText(Math.round(lp[1]) + "%", F.r + 12, midY); }
    c.globalAlpha = 1;
  });
}

// =====================================================================
// 時間軸のストリップ（2段）:
//   上段 = 全期間の縮図（ミニマップ）。全アカウントの週間の薄い線と、今見ている範囲の枠。
//   下段 = 今見ている範囲の目盛り（日付・曜日）。上段の枠と下段の両端を薄い面でつなぎ、どこを拡大しているかを見せる。
// mm: { s, e, list: [{color, D}], holes: [[a, b]], key }（key が同じなら、縮図の線は前回の絵を使い回す）
// =====================================================================
export function stripGeom(plot) {
  const h = plot.h;
  const mmT = 4, mmB = Math.max(16, Math.round(h * 0.5));
  return { mmT, mmB, axT: mmB + 8, axB: h };
}
// 縮図の x の写像
export function mmMap(plot) {
  const m = plot.mm;
  if (!m) return null;
  const k = (m.r - m.l) / Math.max(1, m.e - m.s);
  return { ...m, X: (t) => m.l + (t - m.s) * k, T: (x) => m.s + (x - m.l) / k };
}
function drawMiniData(plot, F, G, mm) {
  const K = tokens();
  const dpr = window.devicePixelRatio || 1;
  const key = `${mm.key}|${plot.w}|${plot.h}|${dpr}|${F.l}|${F.r}|${K.dark}`;
  let cache = plot.mmCache;
  if (!cache || cache.key !== key) {
    const cv = (cache && cache.cv) || document.createElement("canvas");
    cv.width = Math.round(plot.w * dpr); cv.height = Math.round(plot.h * dpr);
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, plot.w, plot.h);
    const k = F.w / Math.max(1, mm.e - mm.s);
    const X = (t) => F.l + (t - mm.s) * k;
    const Y = (v) => G.mmB - (v / 100) * (G.mmB - G.mmT);
    c.save(); c.beginPath(); c.rect(F.l, G.mmT - 1, F.w, G.mmB - G.mmT + 2); c.clip();
    for (const [a, b] of mm.holes || []) hatch(c, Math.max(F.l, X(a)), Math.min(F.r, X(b)), G.mmT, G.mmB);
    // 日の区切り（縮図の目盛り。下段の目盛りとは縮尺が違うことがわかるように、上端に短く）
    const days = xticks(mm.s, mm.e, F.w, 10).filter((tk) => tk.day);
    c.strokeStyle = K.grid; c.lineWidth = 1;
    for (const tk of days) { const x = Math.round(X(tk.t)) + 0.5; c.beginPath(); c.moveTo(x, G.mmT - 1); c.lineTo(x, G.mmB + 1); c.stroke(); }
    c.lineWidth = 1.3; c.lineJoin = "round";
    for (const L of mm.list) {
      if (!L.D) continue;
      c.strokeStyle = rgba(L.color, K.dark ? 0.9 : 0.85);
      strokeSeries(c, L.D.wk, mm.s, mm.e, L.D.brk, X, Y);
    }
    c.restore();
    // 縮図の左端の日付（全期間の始まり）
    c.font = `600 10px ${K.font}`; c.textAlign = "left"; c.textBaseline = "top";
    const d0 = new Date(mm.s * 1000);
    const t0 = `${d0.getMonth() + 1}/${d0.getDate()}`;
    c.fillStyle = K.surface; c.globalAlpha = 0.85; c.fillRect(F.l + 2, G.mmT, c.measureText(t0).width + 6, 12); c.globalAlpha = 1;
    c.fillStyle = K.ink3; c.fillText(t0, F.l + 5, G.mmT + 1);
    cache = plot.mmCache = { key, cv };
  }
  const c = plot.base.getContext("2d");
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(cache.cv, 0, 0); c.restore();
}
export function drawStrip(plot, vp, { now, holes = [], loading = false, mm = null, hint = null }) {
  const c = plot.ctx("base");
  const K = tokens();
  const G = stripGeom(plot);
  const s = vp.start, e = vp.end;
  const { F, X } = plot.xmap(vp);
  const w = F.r;

  // ---- 下段: 今見ている範囲の目盛り ----
  c.save(); c.beginPath(); c.rect(F.l, G.axT, F.w, G.axB - G.axT); c.clip();
  for (const [a, b] of holes) hatch(c, Math.max(F.l, X(a)), Math.min(F.r, X(b)), G.axT, G.axB);
  const ticks = xticks(s, e, F.w, 76);
  const ly = (G.axT + G.axB) / 2;
  c.textBaseline = "middle"; c.textAlign = "left";
  for (const tk of ticks) {
    const x = Math.round(X(tk.t)) + 0.5;
    c.strokeStyle = tk.day ? K.axis : K.grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, tk.day ? G.axT : G.axT + (G.axB - G.axT) * 0.5); c.lineTo(x, G.axB); c.stroke();
    const d = new Date(tk.t * 1000);
    const txt = tk.day || tk.step >= 86400 ? `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})` : `${d.getHours()}:${pad2(d.getMinutes())}`;
    c.fillStyle = tk.day ? K.ink2 : K.ink3;
    c.font = `${tk.day ? 600 : 400} 11px ${K.font}`;
    if (x + 8 + c.measureText(txt).width < w - 18) c.fillText(txt, x + 4, ly);
  }
  // 細かい目盛り（ドラッグしている感触のため）
  c.strokeStyle = K.grid;
  for (const tk of xticks(s, e, F.w, 14)) { const x = Math.round(X(tk.t)) + 0.5; c.beginPath(); c.moveTo(x, G.axB - 4); c.lineTo(x, G.axB); c.stroke(); }
  c.restore();
  if (vp.follow || e >= now - 1) {
    c.fillStyle = K.ink; c.font = `650 10.5px ${K.font}`; c.textAlign = "right"; c.textBaseline = "middle";
    c.fillText("今", w - 4, ly);
  }

  // ---- 上段: 全期間の縮図 ----
  plot.mm = null;
  if (mm && mm.e > mm.s) {
    plot.mm = { s: mm.s, e: mm.e, l: F.l, r: F.r, top: G.mmT, bot: G.mmB, axT: G.axT };
    drawMiniData(plot, F, G, mm);
    const M = mmMap(plot);
    let x0 = M.X(s), x1 = M.X(e);
    if (x1 - x0 < 6) { const m = (x0 + x1) / 2; x0 = m - 3; x1 = m + 3; }
    x0 = Math.max(F.l, x0); x1 = Math.min(F.r, x1);
    // 枠の外を少し沈める
    c.fillStyle = K.surface; c.globalAlpha = 0.55;
    c.fillRect(F.l, G.mmT - 1, x0 - F.l, G.mmB - G.mmT + 2);
    c.fillRect(x1, G.mmT - 1, F.r - x1, G.mmB - G.mmT + 2);
    c.globalAlpha = 1;
    // 枠と下段をつなぐ面
    c.beginPath();
    c.moveTo(x0, G.mmB + 1); c.lineTo(x1, G.mmB + 1); c.lineTo(F.r, G.axT); c.lineTo(F.l, G.axT); c.closePath();
    c.fillStyle = K.sel; c.fill();
    c.strokeStyle = K.selLine; c.lineWidth = 1; c.globalAlpha = 0.6;
    c.beginPath(); c.moveTo(x0, G.mmB + 1); c.lineTo(F.l, G.axT); c.moveTo(x1, G.mmB + 1); c.lineTo(F.r, G.axT); c.stroke();
    c.globalAlpha = 1;
    // 枠
    c.fillStyle = K.sel; c.fillRect(x0, G.mmT - 1, x1 - x0, G.mmB - G.mmT + 2);
    c.strokeStyle = K.selLine; c.lineWidth = 1.25;
    roundRect(c, x0 + 0.5, G.mmT - 0.5, Math.max(1, x1 - x0 - 1), G.mmB - G.mmT + 1, 3); c.stroke();
    // 端のつまみ
    c.fillStyle = K.ink2;
    const gh = Math.min(10, G.mmB - G.mmT - 4), gy = (G.mmT + G.mmB) / 2 - gh / 2;
    for (const gx of [x0, x1]) { roundRect(c, gx - 1.5, gy, 3, gh, 1.5); c.fill(); }
    // 操作の印（控えめに）。枠と重ならない側に置く
    if (hint) {
      c.font = `500 10.5px ${K.font}`;
      const tw = c.measureText(hint).width + 12;
      const left = (x0 + x1) / 2 > F.l + F.w / 2;
      const hx = left ? x0 - 10 - tw : x1 + 10;
      if ((left && hx > F.l + 40) || (!left && hx + tw < F.r - 4)) {
        const hy = (G.mmT + G.mmB) / 2;
        c.fillStyle = K.surface; c.globalAlpha = 0.85;
        roundRect(c, hx, hy - 8, tw, 16, 8); c.fill();
        c.globalAlpha = 1;
        c.fillStyle = K.ink3; c.textAlign = "left"; c.textBaseline = "middle";
        c.fillText(hint, hx + 6, hy + 0.5);
      }
    }
  }
  if (loading) {
    c.fillStyle = K.focus; c.globalAlpha = 0.7;
    const t = (performance.now() / 900) % 1;
    c.save(); c.beginPath(); c.rect(F.l, 0, F.w, plot.h); c.clip();
    c.fillRect(F.l + t * (F.w + 80) - 80, G.axT, 80, 2);
    c.restore();
    c.globalAlpha = 1;
  }
}

// =====================================================================
// カーソル・選択範囲（ovl）
// =====================================================================
export function drawSelection(c, F, X, sel, withLabel) {
  const K = tokens();
  const a = Math.max(F.l, X(Math.min(sel.t0, sel.t1))), b = Math.min(F.r, X(Math.max(sel.t0, sel.t1)));
  c.fillStyle = K.sel; c.fillRect(a, F.t - 4, b - a, F.b - F.t + 4);
  c.strokeStyle = K.selLine; c.lineWidth = 1;
  for (const x of [a, b]) { c.beginPath(); c.moveTo(Math.round(x) + 0.5, F.t - 4); c.lineTo(Math.round(x) + 0.5, F.b); c.stroke(); }
  if (!withLabel) return;
  const txt = fmtSpan(Math.abs(sel.t1 - sel.t0));
  c.font = `650 11.5px ${K.font}`;
  const tw = c.measureText(txt).width + 14;
  let bx = (a + b) / 2 - tw / 2;
  bx = Math.max(F.l, Math.min(F.r - tw, bx));
  c.fillStyle = K.ink; roundRect(c, bx, F.t + 2, tw, 20, 5); c.fill();
  c.fillStyle = K.surface; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillText(txt, bx + tw / 2, F.t + 12.5);
}
export function cursorLine(c, F, x) {
  const K = tokens();
  c.strokeStyle = K.ink3; c.lineWidth = 1;
  c.beginPath(); c.moveTo(Math.round(x) + 0.5, F.t - 4); c.lineTo(Math.round(x) + 0.5, F.b); c.stroke();
}
// 値を読む: 取得の間隔の 1.6 倍以内にある点
export function valueAt(arr, t, iv) { return nearest(arr, t, iv * 1.6); }
export { nearest };
