// 履歴のキャッシュ（/api/history?since=&until=）。
// 何を: 表示範囲に余白を足した範囲を取りに行き、手元で結合して持つ。描画用のモデル（区間・リセット・取得の抜け・エラーの帯）も作る。
// なぜ: 拡大縮小・移動のたびに通信が走らないようにするため（範囲の2倍の分をまとめて取る）。
// 方針:
//   - 系列（アカウント × kind）ごとに、時刻順の点 [t, v, window_id] の配列を1本持つ。取り直した範囲は、その範囲の点を差し替える。
//   - 線の切れ目（枠の切り替わり・interval の 3 倍を超える間隔）と取得の抜けは、結合したあとの点から手元で計算し直す
//     （サーバーの区間は取得した範囲ごとに切れているため、そのままつなぐと境目で誤る）。
//   - 取得済みの範囲（covered）を区間のリストで持つ。抜けは「両端が同じ取得済みの区間に入っている」ときだけ描く。

import { api } from "./api.js";
import { MAX_SPAN } from "./viewport.js";

const KINDS = ["weekly_all", "session"];

export function createHistory({ intervalOf, onChange }) {
  const series = new Map();   // `${id}|${kind}` → [[t, v, wid], ...]
  const errs = new Map();     // id → [[t, status], ...]
  const resets = new Map();   // `${id}|${kind}` → [t, ...]
  let covered = [];           // [[s, e], ...]（重ならない・時刻順）
  let version = 0;
  let inflight = null;        // { s, e, ctrl }
  let queued = null;          // { s, e }
  let failed = null;          // 直近の取得エラー
  let earliest = null;        // わかっている最も古い点
  let earliestFinal = false;  // それより前に記録が無いことがわかっているか
  let models = null, modelsKey = "";

  // ---- 取得済みの範囲 ----
  function addCovered(s, e) {
    const all = [...covered, [s, e]].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of all) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    }
    covered = out;
  }
  function uncoveredIn(s, e) {
    // [s, e] のうち取得していない部分（区間のリスト）
    const out = [];
    let cur = s;
    for (const [a, b] of covered) {
      if (b < cur) continue;
      if (a > e) break;
      if (a > cur) out.push([cur, Math.min(a, e)]);
      cur = Math.max(cur, b);
      if (cur >= e) break;
    }
    if (cur < e) out.push([cur, e]);
    return out.filter(([a, b]) => b - a > 1);
  }
  const isCovered = (s, e) => uncoveredIn(s, e).length === 0;
  const coveredAt = (a, b) => covered.some(([s, e]) => s <= a && b <= e);

  // ---- 取得 ----
  // 見えている範囲 [s, e] が取得済みでなければ、前後に範囲の半分ずつ足した範囲のうち、足りない部分をまとめて取りに行く
  function ensure(s, e, now) {
    if (isCovered(s, Math.min(e, now))) return;
    const span = e - s;
    let ws = s - span / 2, we = Math.min(now, e + span / 2);
    if (we - ws > MAX_SPAN) {
      // 最大 120 日。見えている範囲は必ず入れ、残りを前後に振り分ける
      const extra = Math.max(0, MAX_SPAN - span);
      ws = s - extra / 2; we = Math.min(now, e + extra / 2);
      if (we - ws > MAX_SPAN) ws = we - MAX_SPAN;
    }
    const holes = uncoveredIn(ws, we);
    if (!holes.length) return;
    request(holes[0][0], holes[holes.length - 1][1]);
  }
  // 最新の分（取得が進んだとき）。末尾の少し手前から今まで
  function refreshTail(now) {
    const last = covered.length ? covered[covered.length - 1][1] : null;
    if (last == null) return;
    request(Math.max(last - 1800, now - MAX_SPAN), now, true);
  }
  function request(s, e, force = false) {
    s = Math.floor(s); e = Math.ceil(e);
    if (e - s < 60) e = s + 60;
    if (inflight) {
      if (!force && inflight.s <= s && e <= inflight.e) return;
      queued = { s, e, force };
      return;
    }
    run(s, e);
  }
  async function run(s, e) {
    const ctrl = new AbortController();
    inflight = { s, e, ctrl };
    onChange && onChange("loading");
    try {
      const r = await api.history(s, e, ctrl.signal);
      merge(r);
      failed = null;
    } catch (err) {
      failed = err;
    }
    inflight = null;
    if (queued) {
      const q = queued; queued = null;
      if (q.force || !isCovered(q.s, q.e)) { run(q.s, q.e); onChange && onChange("data"); return; }
    }
    onChange && onChange("data");
  }

  function spliceRange(arr, s, e, incoming) {
    // arr（時刻順）の [s, e] の部分を incoming で置き換える
    const i0 = lowerBound(arr, s), i1 = upperBound(arr, e);
    return arr.slice(0, i0).concat(incoming, arr.slice(i1));
  }
  function merge(r) {
    const s = r.since, e = r.until;
    const got = new Map();
    for (const sr of r.series || []) {
      if (!KINDS.includes(sr.kind)) continue;
      const pts = [];
      for (const g of sr.segments) for (const p of g.points) pts.push([p[0], p[1], g.window_id]);
      pts.sort((a, b) => a[0] - b[0]);
      got.set(`${sr.account_id}|${sr.kind}`, pts);
    }
    // この範囲で点が無くなった系列も差し替える（取得し直したら消えていた場合）
    for (const key of new Set([...series.keys(), ...got.keys()])) {
      series.set(key, spliceRange(series.get(key) || [], s, e, got.get(key) || []));
    }
    const ge = new Map();
    for (const x of r.errors || []) {
      if (!ge.has(x.account_id)) ge.set(x.account_id, []);
      ge.get(x.account_id).push([x.t, x.status]);
    }
    for (const id of new Set([...errs.keys(), ...ge.keys()])) {
      const inc = (ge.get(id) || []).sort((a, b) => a[0] - b[0]);
      errs.set(id, spliceRange(errs.get(id) || [], s, e, inc));
    }
    const gr = new Map();
    for (const x of r.resets || []) {
      const key = `${x.account_id}|${x.kind}`;
      if (!gr.has(key)) gr.set(key, []);
      gr.get(key).push([x.t]);
    }
    for (const key of new Set([...resets.keys(), ...gr.keys()])) {
      const inc = (gr.get(key) || []).sort((a, b) => a[0] - b[0]);
      resets.set(key, spliceRange((resets.get(key) || []), s, e, inc));
    }
    addCovered(s, e);
    // 最も古い点。取った範囲の始まりより十分あとに最初の点があれば、それより前に記録は無い
    let first = Infinity;
    for (const arr of series.values()) if (arr.length) first = Math.min(first, arr[0][0]);
    if (isFinite(first)) {
      earliest = first;
      const c0 = covered[0][0];
      earliestFinal = c0 < first - 3600;
    }
    version++;
  }

  // ---- 描画用のモデル ----
  // accounts: [{id, status}]（タイル・重ね合わせに出すもの）。version と accounts が変わったときだけ作り直す
  function model(accounts, now) {
    const key = version + "|" + accounts.map((a) => a.id + ":" + a.status + ":" + intervalOf(a.id)).join(",");
    if (models && key === modelsKey) return models;
    const per = {};
    for (const a of accounts) per[a.id] = buildAccount(a, now);
    models = per; modelsKey = key;
    return per;
  }
  function buildAccount(a, now) {
    const iv = intervalOf(a.id) * 60;
    const wk = series.get(`${a.id}|weekly_all`) || [];
    const ss = series.get(`${a.id}|session`) || [];
    const er = errs.get(a.id) || [];
    // 線の切れ目: 枠が変わる・間隔が interval の 3 倍を超える
    const brk = (p, q) => q[2] !== p[2] || q[0] - p[0] > iv * 3;
    // 取得の抜け（どの状態の取得でもよい）: 時刻を全部並べて、間が 3 倍を超えたところ
    const times = [];
    for (const p of wk) times.push(p[0]);
    for (const p of ss) times.push(p[0]);
    for (const x of er) times.push(x[0]);
    times.sort((x, y) => x - y);
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > iv * 3 && coveredAt(times[i - 1], times[i])) gaps.push({ from: times[i - 1], to: times[i] });
    }
    // エラー: 続いたものを帯にまとめる
    const bands = [];
    for (const [t, status] of er) {
      const last = bands[bands.length - 1];
      if (last && t - last.lastT <= iv * 3 && last.status === status) { last.to = t + iv; last.lastT = t; }
      else bands.push({ from: t, to: t + iv, lastT: t, status });
    }
    // いまも同じ状態が続いているなら、帯を今まで伸ばす
    const lb = bands[bands.length - 1];
    if (lb && a.status === lb.status && a.status !== "ok") lb.to = Math.max(lb.to, now);
    return {
      iv, wk, ss, brk, gaps, bands,
      wkRes: (resets.get(`${a.id}|weekly_all`) || []).map((x) => x[0]),
      ssRes: (resets.get(`${a.id}|session`) || []).map((x) => x[0]),
    };
  }

  return {
    ensure, refreshTail, model, isCovered, uncoveredIn,
    get loading() { return !!inflight; },
    get failed() { return failed; },
    get version() { return version; },
    get hasData() { return covered.length > 0; },
    get earliest() { return earliestFinal ? earliest : null; },
  };
}

// 時刻順の配列（要素は [t, ...]）で、t 以上になる最初の位置／t より大きくなる最初の位置
export function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] < t) lo = m + 1; else hi = m; }
  return lo;
}
export function upperBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= t) lo = m + 1; else hi = m; }
  return lo;
}
// t にいちばん近い点（maxDist 秒より遠ければ null）
export function nearest(arr, t, maxDist = Infinity) {
  if (!arr.length) return null;
  const i = lowerBound(arr, t);
  let best = null;
  for (const j of [i - 1, i]) {
    if (j < 0 || j >= arr.length) continue;
    if (!best || Math.abs(arr[j][0] - t) < Math.abs(best[0] - t)) best = arr[j];
  }
  return best && Math.abs(best[0] - t) <= maxDist ? best : null;
}
