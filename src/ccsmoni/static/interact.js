// 時間軸の操作の層（全グラフ共通）。
// 何を: グラフの上のドラッグ（範囲の選択）・Ctrl+ホイール（拡大縮小）・横スクロール（移動）・ダブルクリック（プリセットに戻る）・ホバー、
//       時間軸のストリップ（上段＝全期間の縮図、下段＝今の範囲の目盛り）の上のホイール（拡大縮小）・ドラッグ・ピンチ、
//       スマホの横スワイプ（ページ）。
// なぜ: どのグラフで操作しても同じふるまいにし、結果は TimeViewport にだけ渡す（グラフは viewport を購読して描き直すだけ）。
// 方針:
//   - イベントは root に1回だけ付ける（委譲）。グラフの特定は plotFor(canvas) に任せる。destroy() で外せるようにする。
//   - ストリップの上段（縮図）: 枠の中をドラッグ＝移動、枠の端をドラッグ＝範囲の変更、枠の外を押す＝その位置へ移動、
//     枠の外を横にドラッグ＝これまでどおりのパン（つかんで動かす向き）。下段はパン。ホイールはどちらでも、カーソル位置を中心に拡大縮小。

import { MIN_SPAN } from "./viewport.js";
import { stripGeom, mmMap } from "./chart.js";

const WHEEL_K = 0.0035;
const wheelFactor = (dy) => Math.exp(Math.max(-120, Math.min(120, dy)) * WHEEL_K);
// deltaMode（行・ページ単位）を画素に直す
const px = (e, d) => (e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * 400 : d);
const EDGE = 6; // 縮図の枠の端をつかめる幅（px）

export function attachInteractions(root, { vp, plotFor, strip, onHover, onLeave, onSelection, onCommit, onSwipe, onPlainWheel }) {
  let drag = null;     // グラフ上: { P, cv, x0, y0, t0, active, touch, id }
  let pan = null;      // ストリップ上: { mode, pointers: Map, ... }
  const offs = [];
  const on = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); offs.push(() => el.removeEventListener(type, fn, opt)); };

  // ---- グラフ ----
  on(root, "pointerdown", (e) => {
    const cv = e.target.closest && e.target.closest(".plot canvas.ovl");
    if (!cv || e.button !== 0) return;
    const P = plotFor(cv);
    if (!P) return;
    const t0 = P.plot.tAt(e.clientX, vp, 0);
    if (t0 == null) return;
    drag = { P, cv, x0: e.clientX, y0: e.clientY, t0, active: false, touch: e.pointerType === "touch", id: e.pointerId };
    if (!drag.touch) { cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  on(root, "pointermove", (e) => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (drag.touch) {
        // 横に大きく動いたらスワイプ（ページ）。指を離したときに判定する
        drag.swipe = Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.6 ? Math.sign(dx) : 0;
        return;
      }
      if (!drag.active && Math.abs(dx) > 4) drag.active = true;
      if (drag.active) {
        const t1 = drag.P.plot.tAt(e.clientX, vp, 1e6);
        onSelection({ t0: drag.t0, t1 }, drag.P);
        return;
      }
    }
    const cv = e.target.closest && e.target.closest(".plot canvas.ovl");
    if (cv && e.pointerType !== "touch" && !(e.target.closest && e.target.closest(".strip"))) {
      const P = plotFor(cv);
      if (P) { onHover(P, e.clientX, e.clientY); return; }
    }
    if (!pan && !(e.target.closest && e.target.closest(".strip"))) onLeave();
  });
  on(root, "pointerup", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.touch) {
      if (d.swipe) { onSwipe(-d.swipe); return; }
      if (Math.abs(e.clientX - d.x0) < 10 && Math.abs(e.clientY - d.y0) < 10) onHover(d.P, e.clientX, e.clientY, true);
      return;
    }
    if (d.active) {
      const t1 = d.P.plot.tAt(e.clientX, vp, 1e6);
      onSelection(null);
      if (Math.abs(t1 - d.t0) > 60) { vp.setRange(Math.min(d.t0, t1), Math.max(d.t0, t1)); onCommit && onCommit(); }
    }
  });
  on(root, "pointercancel", () => { if (drag && drag.active) onSelection(null); drag = null; });
  on(root, "pointerleave", () => onLeave());
  on(root, "dblclick", (e) => {
    if (e.target.closest && (e.target.closest(".plot canvas.ovl") || e.target.closest(".strip"))) { e.preventDefault(); vp.reset(); }
  });
  on(root, "wheel", (e) => {
    const cv = e.target.closest && e.target.closest(".plot canvas.ovl");
    if (!cv || (e.target.closest && e.target.closest(".strip"))) return;
    const P = plotFor(cv);
    if (!P) return;
    const dx = px(e, e.deltaX), dy = px(e, e.deltaY);
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+ホイール（トラックパッドのピンチも ctrlKey 付きで来る）: 拡大縮小。ブラウザのズームは止める
      e.preventDefault();
      const t = P.plot.tAt(e.clientX, vp, 1e6);
      vp.zoomAt(t, wheelFactor(dy));
    } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.5) {
      // トラックパッドの横スクロール: 移動
      e.preventDefault();
      vp.pan((dx / P.plot.frame().w) * vp.span);
    } else if (Math.abs(dy) > 0.5) {
      // 修飾キーなしの縦ホイール: ページのスクロールに任せる（拡大の方法を一度だけ知らせる）
      onPlainWheel && onPlainWheel();
    }
  }, { passive: false });

  // ---- ストリップ ----
  const sEl = strip.el, sP = strip.plot;
  const sT = (clientX) => sP.tAt(clientX, vp, 1e6);
  // ストリップのどこにいるか: { row: "mm" | "axis", part: "move" | "edgeL" | "edgeR" | "outside", x, tMini }
  function where(e) {
    const { x, y } = sP.local(e.clientX, e.clientY);
    const G = stripGeom(sP);
    const M = mmMap(sP);
    if (!M || y > G.mmB + 3) return { row: "axis", x };
    const { start, end } = vp.target;
    const x0 = M.X(start), x1 = M.X(end);
    let part = "outside";
    if (Math.abs(x - x0) <= EDGE && (x <= x0 || x1 - x0 > EDGE * 2)) part = "edgeL";
    else if (Math.abs(x - x1) <= EDGE) part = "edgeR";
    else if (x > x0 && x < x1) part = "move";
    return { row: "mm", part, x, tMini: M.T(x), M };
  }
  const CURSOR = { move: "grab", edgeL: "ew-resize", edgeR: "ew-resize", outside: "pointer" };

  on(sEl, "wheel", (e) => {
    e.preventDefault();
    const w = sP.frame().w;
    const dx = px(e, e.deltaX), dy = px(e, e.deltaY);
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const d = e.shiftKey && !dx ? dy : dx;
      vp.pan((d / w) * vp.span);
    } else {
      vp.zoomAt(sT(e.clientX), wheelFactor(dy));
    }
  }, { passive: false });
  on(sEl, "pointerdown", (e) => {
    if (e.button !== 0) return;
    sEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    const wh = where(e);
    if (pan && pan.mode === "pan") { pan.pointers.set(e.pointerId, e.clientX); startPan(); return; }
    if (pan) return; // 縮図の枠を動かしている最中の2本目の指は無視する
    const { start, end } = vp.target;
    if (wh.row === "mm" && wh.part !== "outside") {
      pan = { mode: wh.part, id: e.pointerId, x0: wh.x, s0: start, e0: end, M: wh.M, pointers: new Map([[e.pointerId, e.clientX]]) };
      sEl.classList.add("is-grabbing");
      return;
    }
    pan = { mode: wh.row === "mm" ? "pending" : "pan", id: e.pointerId, x0: e.clientX, tMini: wh.tMini, pointers: new Map([[e.pointerId, e.clientX]]) };
    if (pan.mode === "pan") { startPan(); sEl.classList.add("is-grabbing"); }
  });
  function startPan() {
    const xs = [...pan.pointers.values()];
    const F = sP.frame();
    pan.w = F.w; pan.left = sP.el.getBoundingClientRect().left + sP.el.clientLeft + F.l;
    pan.s0 = vp.target.start; pan.e0 = vp.target.end;
    pan.mid0 = xs.reduce((a, b) => a + b, 0) / xs.length;
    pan.dist0 = xs.length > 1 ? Math.abs(xs[0] - xs[1]) : 0;
    pan.anchor = pan.s0 + ((pan.mid0 - pan.left) / pan.w) * (pan.e0 - pan.s0);
  }
  on(sEl, "pointermove", (e) => {
    if (!pan || !pan.pointers.has(e.pointerId)) {
      if (e.pointerType === "touch") return;
      const wh = where(e);
      sEl.style.cursor = wh.row === "mm" ? CURSOR[wh.part] : "";
      if (wh.row === "mm") onHover(null, e.clientX, e.clientY, false, wh.tMini, wh.part === "outside" ? "jump" : "mini");
      else onHover(null, e.clientX, e.clientY, false, sT(e.clientX), "axis");
      return;
    }
    pan.pointers.set(e.pointerId, e.clientX);
    if (pan.mode === "pending") {
      // 枠の外: 動かさずに離せば「そこへ移動」、横に動かせばパン
      if (Math.abs(e.clientX - pan.x0) <= 4) return;
      pan.mode = "pan";
      pan.pointers = new Map([[e.pointerId, pan.x0]]);
      startPan();
      pan.pointers.set(e.pointerId, e.clientX);
      sEl.classList.add("is-grabbing");
    }
    if (pan.mode === "pan") {
      const xs = [...pan.pointers.values()];
      const mid = xs.reduce((a, b) => a + b, 0) / xs.length;
      const span0 = pan.e0 - pan.s0;
      if (xs.length > 1 && pan.dist0 > 10) {
        // ピンチ: 2本の指の中点を固定して拡大縮小
        const span = span0 * (pan.dist0 / Math.max(10, Math.abs(xs[0] - xs[1])));
        const s = pan.anchor - ((mid - pan.left) / pan.w) * span;
        vp.setRange(s, s + span, { animate: false });
      } else {
        const dt = -((mid - pan.mid0) / pan.w) * span0;
        vp.setRange(pan.s0 + dt, pan.e0 + dt, { animate: false });
      }
      return;
    }
    // 縮図の枠: 移動・端の変更
    const { x } = sP.local(e.clientX);
    const M = pan.M;
    const dt = ((x - pan.x0) / (M.r - M.l)) * (M.e - M.s);
    if (pan.mode === "move") vp.setRange(pan.s0 + dt, pan.e0 + dt, { animate: false });
    else if (pan.mode === "edgeL") vp.setRange(Math.min(pan.s0 + dt, pan.e0 - MIN_SPAN), pan.e0, { animate: false });
    else if (pan.mode === "edgeR") vp.setRange(pan.s0, Math.min(M.e, Math.max(pan.e0 + dt, pan.s0 + MIN_SPAN)), { animate: false });
  });
  const endPan = (e) => {
    if (!pan || !pan.pointers.has(e.pointerId)) return;
    if (pan.mode === "pending" && e.type === "pointerup") {
      // 枠の外を押した: そこを中心に移動（範囲の長さは変えない）
      const span = vp.target.end - vp.target.start;
      vp.setRange(pan.tMini - span / 2, pan.tMini + span / 2, { animate: true });
    }
    pan.pointers.delete(e.pointerId);
    if (pan.mode === "pan" && pan.pointers.size) startPan();
    else { pan = null; sEl.classList.remove("is-grabbing"); }
  };
  on(sEl, "pointerup", endPan);
  on(sEl, "pointercancel", endPan);
  on(sEl, "pointerleave", () => { if (!pan) { sEl.style.cursor = ""; onLeave(); } });
  on(sEl, "keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); e.stopPropagation();
      vp.pan((e.key === "ArrowLeft" ? -0.15 : 0.15) * vp.span, { animate: true });
    }
  });

  return {
    get dragging() { return !!(drag && drag.active) || !!pan; },
    // ドラッグ中の選択を取り消す（Esc）。取り消したら true
    cancel() {
      const d = drag;
      if (!d || !d.active) return false;
      drag = null;
      try { d.cv.releasePointerCapture(d.id); } catch { /* もう離れている */ }
      onSelection(null);
      return true;
    },
    destroy() { for (const off of offs.splice(0)) off(); drag = null; pan = null; },
  };
}
