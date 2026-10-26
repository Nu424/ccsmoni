// TimeViewport: 時間軸の表示範囲（全グラフで1つ）。
// 何を: {start, end, preset | null, follow} を持ち、プリセット・拡大縮小・移動・範囲の指定を受け付けて、
//       購読しているグラフ（タイル・重ね合わせ・5h レーン・時間軸のストリップ・ツールバー）に知らせる。
// なぜ: どのグラフで操作しても全部に効くように、範囲の状態と制約（最小 30 分・最大 120 日・未来に行かない）を1か所にまとめる。
// 方針:
//   - target（操作の結果）と shown（画面に出している値）を分ける。shown は 150ms で target に近づく（連続ホイールでは即時）。
//   - 知らせるのは requestAnimationFrame で1フレームに1回だけ。購読側はその中で描く。
//   - 右端が「今」にくっついている（follow）あいだは、時間がたつと右端が今に追従する。

export const PRESETS = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
export const MIN_SPAN = 30 * 60;
export const MAX_SPAN = 120 * 86400;
const ANIM_MS = 150;

export function createViewport({ now, preset = "7d" }) {
  const listeners = new Set();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (!PRESETS[preset]) preset = "7d";
  let floor = null;           // 記録の始まり（わかっていれば）。プリセットの左端をここまで詰める
  let st = { preset, lastPreset: preset, follow: true };
  let target = presetRange(preset);
  let shown = { ...target };
  let anim = null;
  let raf = 0;

  function presetRange(p) {
    const n = now();
    let s = n - PRESETS[p];
    // 記録が範囲より短いときは、最も古い記録まで詰める（グラフの大部分が空白にならないように）
    if (floor != null && floor > s) s = Math.min(n - MIN_SPAN, floor - (n - floor) * 0.02);
    return { start: s, end: n };
  }

  function clamp(s, e) {
    const n = now();
    let span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, e - s));
    if (e - s !== span) { const c = (s + e) / 2; s = c - span / 2; e = c + span / 2; }
    if (e > n) { e = n; s = n - span; }
    return { start: s, end: e };
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(step);
  }
  function step(ts) {
    raf = 0;
    if (anim) {
      const k = Math.min(1, (performance.now() - anim.t0) / ANIM_MS);
      const e = 1 - Math.pow(1 - k, 3);
      shown = { start: anim.from.start + (anim.to.start - anim.from.start) * e, end: anim.from.end + (anim.to.end - anim.from.end) * e };
      if (k < 1) schedule(); else { anim = null; shown = { ...target }; }
    }
    for (const fn of listeners) fn(api, ts);
  }

  function apply(r, { animate = true, preset: p = null } = {}) {
    const n = now();
    const c = p ? r : clamp(r.start, r.end);
    // 右端が今から少し（範囲の 0.5%・最低 1 分）以内なら「今に追従」
    st.follow = c.end >= n - Math.max(60, (c.end - c.start) * 0.005);
    if (st.follow) { const span = c.end - c.start; c.end = n; c.start = n - span; }
    st.preset = p;
    if (p) st.lastPreset = p;
    target = c;
    if (animate && !reduced.matches) anim = { from: { ...shown }, to: target, t0: performance.now() };
    else { anim = null; shown = { ...target }; }
    schedule();
  }

  const api = {
    get start() { return shown.start; },
    get end() { return shown.end; },
    get span() { return shown.end - shown.start; },
    get target() { return target; },
    get preset() { return st.preset; },
    get lastPreset() { return st.lastPreset; },
    get follow() { return st.follow; },
    get animating() { return !!anim; },
    subscribe(fn) { listeners.add(fn); schedule(); return () => listeners.delete(fn); },
    setPreset(p, opt = {}) { if (PRESETS[p]) apply(presetRange(p), { ...opt, preset: p }); },
    reset() { apply(presetRange(st.lastPreset), { preset: st.lastPreset }); },
    setRange(s, e, opt = {}) { apply({ start: s, end: e }, opt); },
    // t を中心に factor 倍（<1 で拡大）。連続ホイールでは animate:false
    zoomAt(t, factor, opt = { animate: false }) {
      const { start, end } = target;
      apply({ start: t - (t - start) * factor, end: t + (end - t) * factor }, opt);
    },
    zoom(factor, opt = {}) {
      const { start, end } = target;
      // 今に追従しているときは右端（今）を中心に、そうでなければ中央を中心に
      api.zoomAt(st.follow ? end : (start + end) / 2, factor, opt);
    },
    pan(dt, opt = { animate: false }) {
      const { start, end } = target;
      apply({ start: start + dt, end: end + dt }, opt);
    },
    // 時間がたったとき（state の取得ごと・毎分）。追従中なら右端を今に合わせる
    tick() {
      if (!st.follow) return;
      if (st.preset) { apply(presetRange(st.preset), { animate: false, preset: st.preset }); return; }
      const span = target.end - target.start;
      const n = now();
      apply({ start: n - span, end: n }, { animate: false });
    },
    // 記録の始まりがわかったら呼ぶ。プリセットを見ているなら、左端を詰め直す
    setFloor(t) {
      if (t === floor) return;
      floor = t;
      if (st.preset) apply(presetRange(st.preset), { preset: st.preset });
    },
    // 描画の再要求（データが届いた・大きさが変わった）。範囲は変えない
    redraw() { schedule(); },
  };
  return api;
}
