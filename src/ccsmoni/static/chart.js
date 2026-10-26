// 推移グラフ（uPlot）。
// 何を: /api/history の応答を uPlot の形に変換し、重ね合わせ表示と、アカウントごとの分割表示（small multiples）を描く。
// なぜ: 枠（window）ごとに線を切る・データの抜けを補間しない、という「嘘の線を引かない」描き方を守るため（PLAN §4.2）。
// 方針:
//   - 枠の境目と gaps の中に null を入れた [[t, v|null]] の列（runs）を作り、null で必ず線を切る。
//   - uPlot には x の範囲・目盛り・カーソルだけを任せ、線・リセットの縦線・gaps の網掛け・errors の印・
//     1点だけの枠の点は、hooks で canvas に直接描く。
//   - 強調（カードを押したとき）と表示／非表示は、作り直さずに series[].show と redraw で切り替える。

import uPlot from "./vendor/uPlot.esm.js";
import { h, setChildren, cssVar, readableColor, withAlpha, fmtPct, fmtDateTime, fmtClock, fmtDate } from "./ui.js";

// ---- データの変換 -----------------------------------------------------------------
// アカウント1つ・kind 1つ分を [[t, v|null], ...] の列にする（null は線の切れ目）。
function toRuns(series, gaps) {
  const out = [];
  const isolated = []; // 1点しかない枠（線にならないので点で描く）
  const myGaps = gaps || [];
  const inGap = (a, b) => myGaps.some((g) => g.from < b && g.to > a);
  for (const seg of series ? series.segments : []) {
    const pts = seg.points;
    if (!pts.length) continue;
    if (out.length) out.push([out[out.length - 1][0] + 1, null]);
    if (pts.length === 1) isolated.push(pts[0]);
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && inGap(pts[i - 1][0], pts[i][0])) out.push([pts[i - 1][0] + 1, null]);
      out.push(pts[i]);
    }
  }
  return { runs: out, isolated };
}

// 線は uPlot に描かせず、自前で canvas に描く。
// （uPlot の null による切れ目は「隣の x」までしか切らないため、10 分おきの点だとリセットの所に
//   ほぼ垂直な線が残ってしまう。枠ごとに moveTo し直せば、確実に切れる）
// uPlot には x の範囲だけを渡し、目盛り・カーソル・サイズ変更を任せる。
function strokeRuns(u, runs, { stroke, width, fill = null }) {
  const { ctx } = u;
  const dpr = devicePixelRatio;
  const { left, top, width: pw, height: ph } = u.bbox;
  const bottom = top + ph;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 2 * dpr, pw, ph + 4 * dpr);
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const p = new Path2D();
      run.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      if (fill) {
        const f = new Path2D(p);
        f.lineTo(run[run.length - 1][0], bottom);
        f.lineTo(run[0][0], bottom);
        f.closePath();
        ctx.fillStyle = fill;
        ctx.fill(f);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * dpr;
      ctx.stroke(p);
    }
    run = [];
  };
  for (const [t, v] of runs) {
    if (v == null) { flush(); continue; }
    run.push([u.valToPos(t, "x", true), u.valToPos(v, "y", true)]);
  }
  flush();
  ctx.restore();
}

// その時刻の値（ツールチップ用）。直前の点の値を返し、切れ目の中なら null。
function valueAt(runs, t) {
  let lo = 0, hi = runs.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (runs[m][0] <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  if (ans < 0) return null;
  const v = runs[ans][1];
  const next = runs[ans + 1];
  if (v == null) return null;
  // 最後の点から 1 時間以上先は「わからない」
  if (!next && t - runs[ans][0] > 3600) return null;
  return v;
}

// ---- テーマ ------------------------------------------------------------------------
function themeTokens() {
  return {
    bg: cssVar("--surface") || "#ffffff",
    grid: cssVar("--grid") || "#e5e7eb",
    axis: cssVar("--text-3") || "#6b7280",
    hatch: cssVar("--hatch") || "rgba(0,0,0,.08)",
    font: `11px ${cssVar("--font-ui") || "system-ui"}`,
  };
}

// x 軸の目盛り。選んだ期間（24h / 7日 / 30日）ではなく、実際に描いている幅から間隔を決める。
// データが期間より短いときは x 軸の左端を詰める（dashboard.js の dataStart）ので、1 時間しか描かないこともある。
// 間隔は「画面の幅に対して目盛りが多すぎない、いちばん細かいもの」。結果として
//   24h → 3 時間ごと（スマホは 6 時間）、7日 → 1 日ごと（2 日）、30日 → 3 日ごと（7 日）になる。
const STEPS = [600, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 3 * 86400, 7 * 86400];
function pickStep(span, width) {
  const target = width < 500 ? 5 : 10;
  return STEPS.find((s) => span / s <= target) || STEPS[STEPS.length - 1];
}

// 1 日より細かい間隔は時刻、日の境目と 1 日以上の間隔は日付
function xAxisValues() {
  return (u, splits) => {
    const step = splits.length > 1 ? splits[1] - splits[0] : 86400;
    return splits.map((t) => {
      const d = new Date(t * 1000);
      return step >= 86400 || (d.getHours() === 0 && d.getMinutes() === 0) ? fmtDate(t) : fmtClock(t);
    });
  };
}

// 目盛りはローカル時刻の切りのよい所（0:00 から間隔ごと）に置く
function xSplits() {
  return (u, axisIdx, min, max) => {
    const step = pickStep(max - min, u.width);
    const d = new Date(min * 1000);
    d.setHours(0, 0, 0, 0);
    let t = d.getTime() / 1000;
    if (step < 86400) t += Math.ceil((min - t) / step) * step;
    const out = [];
    for (; t <= max; t += step) if (t >= min) out.push(t);
    return out;
  };
}

// errors（ok 以外の取得）を、続いている区間にまとめる。
// ログイン切れが続くと 10 分おきに印が並んでうるさいので、続いているものは細い帯 1 本にする。
// 「続いている」= 間に値の取れた点（線の点）が無く、取得の抜け（gaps）もまたいでいない。
// pointTimes はそのアカウントの点の時刻（昇順）。戻り値は [{from, to, n}]（n = まとめた件数）。
function errorSpans(errors, pointTimes, gaps) {
  const hasPointBetween = (a, b) => {
    let lo = 0, hi = pointTimes.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pointTimes[m] <= a) lo = m + 1; else hi = m; }
    return lo < pointTimes.length && pointTimes[lo] < b;
  };
  const spans = [];
  for (const e of [...errors].sort((a, b) => a.t - b.t)) {
    const last = spans[spans.length - 1];
    if (last && !hasPointBetween(last.to, e.t) && !gaps.some((g) => g.from < e.t && g.to > last.to)) {
      last.to = e.t;
      last.n++;
    } else spans.push({ from: e.t, to: e.t, n: 1 });
  }
  return spans;
}
function accountPointTimes(history, accountId) {
  return history.series.filter((s) => s.account_id === accountId)
    .flatMap((s) => s.segments.flatMap((g) => g.points.map((p) => p[0])))
    .sort((a, b) => a - b);
}
// ツールチップ用: その時刻が errors の区間（または 1 件だけの印の近く）に入っているか
const inErrorSpan = (spans, t) => spans.some((s) => t >= s.from - 900 && t <= s.to + 900);

// errors を下端に描く。1 件だけなら小さな三角、続いているものは細い帯。
function drawErrors(u, spans, color) {
  const { ctx } = u;
  const dpr = devicePixelRatio;
  const y = u.bbox.top + u.bbox.height - 1 * dpr;
  ctx.fillStyle = color;
  let lastX = -99;
  for (const s of spans) {
    const x0 = u.valToPos(s.from, "x", true);
    if (s.n === 1) {
      if (x0 - lastX < 5 * dpr) continue; // 同じ画素に重なる印は1つにまとめる
      lastX = x0;
      ctx.beginPath();
      ctx.moveTo(x0, y - 5 * dpr); ctx.lineTo(x0 - 3 * dpr, y); ctx.lineTo(x0 + 3 * dpr, y);
      ctx.closePath(); ctx.fill();
    } else {
      // 帯は破線＋半透明にする。実線だと「0% のデータの線」と見分けがつかないため
      const x1 = Math.max(u.valToPos(s.to, "x", true), x0 + 3 * dpr);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * dpr;
      ctx.setLineDash([2 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(x0, y - 1.5 * dpr); ctx.lineTo(x1, y - 1.5 * dpr);
      ctx.stroke();
      ctx.restore();
      lastX = x1;
    }
  }
}

function hatchPattern(ctx, color) {
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d");
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, 8); g.lineTo(8, 0);
  g.stroke();
  return ctx.createPattern(c, "repeat");
}

// ---- 重ね合わせ ------------------------------------------------------------------------
// opts: { el, history, kind, accounts:[{id,label,color}], hidden:Set, focus, xMin }
// xMin: x 軸の左端（データが期間より短いときに詰める。省略すると history.since）
export function overlayChart(opts) {
  const { el, history, kind, accounts } = opts;
  const xMin = opts.xMin ?? history.since;
  const tk = themeTokens();
  const items = accounts.map((a) => {
    const s = history.series.find((x) => x.account_id === a.id && x.kind === kind);
    const gaps = history.gaps.filter((g) => g.account_id === a.id);
    const { runs, isolated } = toRuns(s, gaps);
    return { ...a, line: readableColor(a.color, tk.bg), runs, isolated, gaps,
      resets: history.resets.filter((r) => r.account_id === a.id && r.kind === kind),
      errSpans: errorSpans(history.errors.filter((e) => e.account_id === a.id), accountPointTimes(history, a.id), gaps) };
  });
  const data = [[xMin, history.until], ...items.map(() => [null, null])];

  let focus = opts.focus;
  let hidden = new Set(opts.hidden);
  const strokeFor = (it) => (focus && focus !== it.id ? withAlpha(it.line, 0.22) : it.line);
  const widthFor = (it) => (focus === it.id ? 2.6 : focus ? 1.4 : 1.8);

  // ツールチップ（HTML）。カーソル位置の時刻で、表示中の全アカウントの値を並べる。
  const tip = h("div.chart-tip", { hidden: true });
  el.append(tip);

  const height = () => (el.clientWidth < 600 ? 240 : 320);
  const u = new uPlot({
    width: Math.max(280, el.clientWidth),
    height: height(),
    padding: [12, 8, 0, 0],
    legend: { show: false },
    cursor: {
      drag: { x: false, y: false },
      points: { show: false },
      y: false,
    },
    scales: {
      x: { time: true, range: () => [xMin, history.until] },
      y: { range: [0, 100] },
    },
    axes: [
      { stroke: tk.axis, font: tk.font, grid: { stroke: tk.grid, width: 1 }, ticks: { show: false },
        splits: xSplits(), values: xAxisValues(), gap: 6, size: 28 },
      { stroke: tk.axis, font: tk.font, grid: { stroke: tk.grid, width: 1 }, ticks: { show: false },
        splits: () => [0, 25, 50, 75, 100], values: (u, s) => s.map((v) => v + "%"), size: 40, gap: 4 },
    ],
    series: [
      {},
      ...items.map((it) => ({
        label: it.label,
        show: !hidden.has(it.id),
        stroke: () => strokeFor(it),
        paths: () => null, // 線は draw フックで描く
        points: { show: false },
      })),
    ],
    hooks: {
      // 線より奥: gaps の網掛け、リセット位置の縦線
      drawAxes: [(u) => {
        const { ctx } = u;
        const { top, height: ph } = u.bbox;
        ctx.save();
        ctx.fillStyle = hatchPattern(ctx, tk.hatch);
        // 表示中のアカウントの gaps を1本にまとめてから塗る（PC のスリープ等は全アカウント同時に起きるので、
        // 重ね塗りで濃くならないように）
        const spans = items.filter((it, i) => u.series[i + 1].show).flatMap((it) => it.gaps)
          .map((g) => [Math.max(g.from, xMin), Math.min(g.to, history.until)])
          .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const sp of spans) {
          const last = merged[merged.length - 1];
          if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]);
        }
        for (const [a, b] of merged) {
          const x0 = u.valToPos(a, "x", true), x1 = u.valToPos(b, "x", true);
          ctx.fillRect(x0, top, x1 - x0, ph);
        }
        items.forEach((it, i) => {
          if (!u.series[i + 1].show || it.resets.length > 40) return;
          ctx.strokeStyle = withAlpha(it.line, focus && focus !== it.id ? 0.12 : 0.45);
          ctx.lineWidth = 1 * devicePixelRatio;
          ctx.setLineDash([3 * devicePixelRatio, 3 * devicePixelRatio]);
          for (const r of it.resets) {
            const x = Math.round(u.valToPos(r.t, "x", true)) + 0.5;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
          }
        });
        ctx.restore();
      }],
      // 線より手前: 1点だけの枠、errors の印（下端）
      draw: [(u) => {
        const { ctx } = u;
        const { top, height: ph } = u.bbox;
        const dpr = devicePixelRatio;
        // 強調中のアカウントは最後に描いて、いちばん手前に出す
        const order = items.map((it, i) => i).sort((a, b) => (items[a].id === focus) - (items[b].id === focus));
        for (const i of order) {
          if (u.series[i + 1].show) strokeRuns(u, items[i].runs, { stroke: strokeFor(items[i]), width: widthFor(items[i]) });
        }
        ctx.save();
        items.forEach((it, i) => {
          if (!u.series[i + 1].show) return;
          ctx.fillStyle = strokeFor(it);
          for (const [t, v] of it.isolated) {
            ctx.beginPath();
            ctx.arc(u.valToPos(t, "x", true), u.valToPos(v, "y", true), 2.2 * dpr, 0, Math.PI * 2);
            ctx.fill();
          }
          // errors: 下端に小さな三角（続いているものは細い帯）
          drawErrors(u, it.errSpans, withAlpha(it.line, focus && focus !== it.id ? 0.25 : 0.8));
        });
        ctx.restore();
      }],
      setCursor: [(u) => {
        const { left, top } = u.cursor;
        if (left == null || left < 0) { tip.hidden = true; return; }
        const t = u.posToVal(left, "x");
        const rows = items
          .filter((it, i) => u.series[i + 1].show)
          .map((it) => ({ it, v: valueAt(it.runs, t), err: inErrorSpan(it.errSpans, t) }));
        if (!rows.length) { tip.hidden = true; return; }
        setChildren(tip,
          h("div.tip-time", fmtDateTime(t)),
          ...rows.map(({ it, v, err }) => h("div.tip-row", { class: focus === it.id ? "is-focus" : "" }, [
            h("span.sw", { style: { background: it.line } }),
            h("span.tip-label", it.label),
            h("span.tip-val.num", v == null ? (err ? "取得できず" : "—") : fmtPct(v)),
          ])),
        );
        tip.hidden = false;
        const w = tip.offsetWidth, plotW = u.bbox.width / devicePixelRatio;
        const x = left + u.bbox.left / devicePixelRatio;
        tip.style.left = `${left > plotW - w - 24 ? x - w - 14 : x + 14}px`;
        tip.style.top = `${Math.max(4, Math.min(top - 10, u.bbox.height / devicePixelRatio - tip.offsetHeight))}px`;
      }],
    },
  }, data, el);

  u.over.addEventListener("mouseleave", () => { tip.hidden = true; });

  const ro = new ResizeObserver(() => {
    const w = Math.max(280, el.clientWidth);
    if (Math.abs(w - u.width) > 1) u.setSize({ width: w, height: height() });
  });
  ro.observe(el);

  return {
    setHidden(next) {
      hidden = new Set(next);
      // 線は自前で描くので、uPlot の setSeries（カーソルの点の DOM も触る）は使わず、印だけ変えて描き直す
      items.forEach((it, i) => { u.series[i + 1].show = !hidden.has(it.id); });
      u.redraw(false, false);
    },
    setFocus(id) {
      focus = id;
      u.redraw(false, false);
    },
    hasData: items.some((it) => it.runs.length > 0),
    destroy() { ro.disconnect(); u.destroy(); tip.remove(); },
  };
}

// ---- 分割表示（small multiples） ----------------------------------------------------------
// 1行1アカウント。週間を線、5h を薄い面にする。カーソルは全行で同期する。
export function multiplesChart(opts) {
  const { el, history, accounts, focus } = opts;
  const xMin = opts.xMin ?? history.since;
  const tk = themeTokens();
  const sync = uPlot.sync("ccsmoni-multi");
  const charts = [];
  const wrap = h("div.multi");
  el.append(wrap);
  const ro = new ResizeObserver(() => {
    for (const c of charts) {
      const w = Math.max(240, c.host.clientWidth);
      if (Math.abs(w - c.u.width) > 1) c.u.setSize({ width: w, height: c.u.height });
    }
  });

  accounts.forEach((a, idx) => {
    const line = readableColor(a.color, tk.bg);
    const gaps = history.gaps.filter((g) => g.account_id === a.id);
    const wk = toRuns(history.series.find((s) => s.account_id === a.id && s.kind === "weekly_all"), gaps);
    const ss = toRuns(history.series.find((s) => s.account_id === a.id && s.kind === "session"), gaps);
    const data = [[xMin, history.until], [null, null], [null, null]];
    const resets = history.resets.filter((r) => r.account_id === a.id && r.kind === "weekly_all");
    const errSpans = errorSpans(history.errors.filter((e) => e.account_id === a.id), accountPointTimes(history, a.id), gaps);
    const readout = h("span.multi-read.num");
    const showReadout = (t) => {
      if (t == null) {
        const lw = [...wk.runs].reverse().find((p) => p[1] != null);
        const ls = [...ss.runs].reverse().find((p) => p[1] != null);
        readout.textContent = `週間 ${fmtPct(lw && lw[1])} · 5h ${fmtPct(ls && ls[1])}`;
        return;
      }
      readout.textContent = `${fmtDateTime(t)}  週間 ${fmtPct(valueAt(wk.runs, t))} · 5h ${fmtPct(valueAt(ss.runs, t))}`;
    };
    showReadout(null);
    const host = h("div.multi-plot");
    const row = h("div.multi-row", { class: focus && focus !== a.id ? "is-dim" : focus === a.id ? "is-focus" : "" }, [
      h("div.multi-head", [h("span.sw", { style: { background: line } }), h("b", a.label), readout]),
      host,
    ]);
    wrap.append(row);
    const last = idx === accounts.length - 1;
    const u = new uPlot({
      width: Math.max(240, el.clientWidth),
      height: last ? 112 : 84,
      padding: [6, 8, last ? 0 : 8, 0],
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false }, y: false, sync: { key: sync.key } },
      scales: { x: { time: true, range: () => [xMin, history.until] }, y: { range: [0, 100] } },
      axes: [
        { show: last, stroke: tk.axis, font: tk.font, grid: { stroke: tk.grid, width: 1 }, ticks: { show: false },
          splits: xSplits(), values: xAxisValues(), size: 26, gap: 6 },
        { stroke: tk.axis, font: tk.font, grid: { stroke: tk.grid, width: 1 }, ticks: { show: false },
          splits: () => [0, 50, 100], values: (u, s) => s.map((v) => v + "%"), size: 40, gap: 4 },
      ],
      series: [
        {},
        { stroke: line, paths: () => null, points: { show: false } },
        { stroke: line, paths: () => null, points: { show: false } },
      ],
      hooks: {
        drawAxes: [(u) => {
          const { ctx } = u;
          const { top, height: ph } = u.bbox;
          ctx.save();
          ctx.fillStyle = hatchPattern(ctx, tk.hatch);
          for (const g of gaps) {
            const x0 = u.valToPos(Math.max(g.from, xMin), "x", true);
            const x1 = u.valToPos(Math.min(g.to, history.until), "x", true);
            if (x1 > x0) ctx.fillRect(x0, top, x1 - x0, ph);
          }
          ctx.strokeStyle = withAlpha(line, 0.5);
          ctx.setLineDash([3 * devicePixelRatio, 3 * devicePixelRatio]);
          for (const r of resets) {
            const x = Math.round(u.valToPos(r.t, "x", true)) + 0.5;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke();
          }
          ctx.restore();
        }],
        draw: [(u) => {
          strokeRuns(u, ss.runs, { stroke: withAlpha(line, 0.35), width: 1, fill: withAlpha(line, 0.13) });
          strokeRuns(u, wk.runs, { stroke: line, width: 1.8 });
          u.ctx.save();
          drawErrors(u, errSpans, withAlpha(line, 0.8));
          u.ctx.restore();
        }],
        setCursor: [(u) => {
          const { left } = u.cursor;
          showReadout(left == null || left < 0 ? null : u.posToVal(left, "x"));
        }],
      },
    }, data, host);
    u.over.addEventListener("mouseleave", () => showReadout(null));
    charts.push({ u, host });
    ro.observe(host);
  });

  return {
    destroy() { ro.disconnect(); charts.forEach((c) => c.u.destroy()); wrap.remove(); },
  };
}
