// 時間軸の操作の層（全グラフ共通）。
// 何を: グラフの上のドラッグ（範囲の選択）・Ctrl+ホイール（拡大縮小）・横スクロール（移動）・ダブルクリック（プリセットに戻る）・ホバー、
//       時間軸のストリップの上のホイール（拡大縮小）・ドラッグ（移動）・ピンチ、スマホの横スワイプ（ページ）。
// なぜ: どのグラフで操作しても同じふるまいにし、結果は TimeViewport にだけ渡す（グラフは viewport を購読して描き直すだけ）。
// 方針: イベントは root に1回だけ付ける（委譲）。グラフの特定は plotFor(canvas) に任せる。

const WHEEL_K = 0.0035;
const wheelFactor = (dy) => Math.exp(Math.max(-120, Math.min(120, dy)) * WHEEL_K);
// deltaMode（行・ページ単位）を画素に直す
const px = (e, d) => (e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * 400 : d);

export function attachInteractions(root, { vp, plotFor, strip, onHover, onLeave, onSelection, onSwipe }) {
  let drag = null;     // グラフ上: { plot, x0, y0, t0, active, touch, time }
  let pan = null;      // ストリップ上: { pointers: Map, s0, e0, ... }

  // ---- グラフ ----
  root.addEventListener("pointerdown", (e) => {
    const cv = e.target.closest && e.target.closest(".plot canvas.ovl");
    if (!cv || e.button !== 0) return;
    const P = plotFor(cv);
    if (!P) return;
    const t0 = P.plot.tAt(e.clientX, vp, 0);
    if (t0 == null) return;
    drag = { P, x0: e.clientX, y0: e.clientY, t0, active: false, touch: e.pointerType === "touch", time: performance.now(), id: e.pointerId };
    if (!drag.touch) { cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  root.addEventListener("pointermove", (e) => {
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
    if (cv && e.pointerType !== "touch") {
      const P = plotFor(cv);
      if (P) { onHover(P, e.clientX, e.clientY); return; }
    }
    if (!pan && !(e.target.closest && e.target.closest(".strip"))) onLeave();
  });
  root.addEventListener("pointerup", (e) => {
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
      if (Math.abs(t1 - d.t0) > 60) vp.setRange(Math.min(d.t0, t1), Math.max(d.t0, t1));
    }
  });
  root.addEventListener("pointercancel", () => { if (drag && drag.active) onSelection(null); drag = null; });
  root.addEventListener("pointerleave", () => onLeave());
  root.addEventListener("dblclick", (e) => {
    if (e.target.closest && (e.target.closest(".plot canvas.ovl") || e.target.closest(".strip"))) { e.preventDefault(); vp.reset(); }
  });
  root.addEventListener("wheel", (e) => {
    const cv = e.target.closest && e.target.closest(".plot canvas.ovl");
    if (!cv) return;
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
    }
  }, { passive: false });

  // ---- ストリップ ----
  const sEl = strip.el;
  const sT = (clientX) => strip.plot.tAt(clientX, vp, 1e6);
  sEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const w = strip.plot.frame().w;
    const dx = px(e, e.deltaX), dy = px(e, e.deltaY);
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const d = e.shiftKey && !dx ? dy : dx;
      vp.pan((d / w) * vp.span);
    } else {
      vp.zoomAt(sT(e.clientX), wheelFactor(dy));
    }
  }, { passive: false });
  sEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    sEl.setPointerCapture(e.pointerId);
    if (!pan) pan = { pointers: new Map() };
    pan.pointers.set(e.pointerId, e.clientX);
    startPan();
    sEl.classList.add("is-grabbing");
    e.preventDefault();
  });
  function startPan() {
    const r = sEl.getBoundingClientRect();
    const xs = [...pan.pointers.values()];
    const F = strip.plot.frame();
    pan.w = F.w; pan.left = r.left + F.l;
    pan.s0 = vp.target.start; pan.e0 = vp.target.end;
    pan.mid0 = xs.reduce((a, b) => a + b, 0) / xs.length;
    pan.dist0 = xs.length > 1 ? Math.abs(xs[0] - xs[1]) : 0;
    pan.anchor = pan.s0 + ((pan.mid0 - pan.left) / pan.w) * (pan.e0 - pan.s0);
  }
  sEl.addEventListener("pointermove", (e) => {
    if (!pan || !pan.pointers.has(e.pointerId)) {
      if (e.pointerType !== "touch") onHover(null, e.clientX, e.clientY, false, sT(e.clientX));
      return;
    }
    pan.pointers.set(e.pointerId, e.clientX);
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
  });
  const endPan = (e) => {
    if (!pan || !pan.pointers.has(e.pointerId)) return;
    pan.pointers.delete(e.pointerId);
    if (pan.pointers.size) startPan();
    else { pan = null; sEl.classList.remove("is-grabbing"); }
  };
  sEl.addEventListener("pointerup", endPan);
  sEl.addEventListener("pointercancel", endPan);
  sEl.addEventListener("pointerleave", (e) => { if (!pan) onLeave(); });
  sEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault(); e.stopPropagation();
      vp.pan((e.key === "ArrowLeft" ? -0.15 : 0.15) * vp.span, { animate: true });
    }
  });

  return { get dragging() { return !!(drag && drag.active) || !!pan; } };
}
