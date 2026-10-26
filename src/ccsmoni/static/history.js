// 履歴のキャッシュ（/api/history?since=&until=）。
// 何を: 表示範囲に余白を足した範囲を取りに行き、手元で結合して持つ。描画用のモデル（区間・リセット・取得の抜け・エラーの帯）も作る。
// なぜ: 拡大縮小・移動のたびに通信が走らないようにするため（範囲の2倍の分をまとめて取る）。
// 方針:
//   - 系列（アカウント × kind）ごとに、時刻順の点 [t, v, window_id] の配列を1本持つ。取り直した範囲は、その範囲の点を差し替える。
//   - 線の切れ目（枠の切り替わり・interval の 3 倍を超える間隔）は、結合したあとの点から手元で計算し直す。
//   - 取得の抜けは、サーバーの gaps を取得した範囲ごとにキャッシュして置き換える（weekly_model:* だけの取得もサーバーは数えるため）。
//     範囲の境目をまたぐ抜けはどちらの応答にも入らないので、応答の spans（範囲内の最初・最後の取得）と手元の点から境目だけ判定する。
//   - 取得の順番: 最新の分（tail）＞ 見えている範囲 ＞ 時間軸の縮図（全期間）。取得が終わるたびに、その時点の「見たい範囲」を
//     wanted() で聞き直す（待っている要求を1つの変数で上書きして、取りこぼすことがないように）。
//   - 見えている範囲が、取得中の範囲から外れたら、取得をやめて（abort）取り直す。

import { api } from "./api.js";
import { MAX_SPAN } from "./viewport.js";

const KINDS = ["weekly_all", "session"];

// wanted(): { view: [s, e], bg: [s, e] | null, now }（見えている範囲と、縮図に使う全期間）
export function createHistory({ intervalOf, onChange, wanted }) {
  const series = new Map();   // `${id}|${kind}` → [[t, v, wid], ...]
  const errs = new Map();     // id → [[t, status], ...]
  const resets = new Map();   // `${id}|${kind}` → [[t], ...]
  const srvGaps = new Map();  // id → [[from, to], ...]（サーバーの gaps。from の順）
  const anchors = new Map();  // id → [[t], ...]（各応答の spans の first / last）
  let fetched = [];           // 応答ごとの範囲 [[s, e], ...]（新しい応答が古い範囲を切り取る。重ならない・時刻順）
  let covered = [];           // [[s, e], ...]（重ならない・時刻順。fetched を結合したもの）
  let version = 0;
  let inflight = null;        // { s, e, ctrl, kind: "tail" | "view" | "bg" }
  let tailQ = null;           // 取得中に来た tail の要求（範囲を合わせて1つにする）
  let failed = null;          // 直近の取得エラー（view / tail）
  let bgFailed = false;
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
  function addFetched(s, e) {
    const out = [];
    for (const [a, b] of fetched) {
      if (b < s || a > e) { out.push([a, b]); continue; }
      if (a < s) out.push([a, s]);
      if (b > e) out.push([e, b]);
    }
    out.push([s, e]);
    fetched = out.sort((x, y) => x[0] - y[0]);
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
  const inOneFetch = (a, b) => fetched.some(([s, e]) => s <= a && b <= e);

  // ---- 取得 ----
  // 見えている範囲 [s, e] が取得済みでなければ、前後に範囲の半分ずつ足した範囲のうち、足りない部分（の外側の端から端）
  function viewRequest(s, e, now) {
    if (isCovered(s, Math.min(e, now))) return null;
    const span = e - s;
    let ws = s - span / 2, we = Math.min(now, e + span / 2);
    if (we - ws > MAX_SPAN) {
      // 最大 120 日。見えている範囲は必ず入れ、残りを前後に振り分ける
      const extra = Math.max(0, MAX_SPAN - span);
      ws = s - extra / 2; we = Math.min(now, e + extra / 2);
      if (we - ws > MAX_SPAN) ws = we - MAX_SPAN;
    }
    const holes = uncoveredIn(ws, we);
    return holes.length ? [holes[0][0], holes[holes.length - 1][1]] : null;
  }
  function bgRequest(w) {
    if (!w.bg || bgFailed) return null;
    const s = Math.max(w.bg[0], w.now - MAX_SPAN), e = Math.min(w.bg[1], w.now);
    if (e - s < 60) return null;
    const holes = uncoveredIn(s, e);
    return holes.length ? [holes[0][0], holes[holes.length - 1][1]] : null;
  }
  // 次に取るものを決めて取りに行く（取得中なら何もしない。終わったらまた呼ばれる）
  function pump() {
    if (inflight) return;
    if (tailQ) { const q = tailQ; tailQ = null; run(q.s, q.e, "tail"); return; }
    const w = wanted && wanted();
    if (!w) return;
    const v = viewRequest(w.view[0], w.view[1], w.now);
    if (v) { run(v[0], v[1], "view"); return; }
    const b = bgRequest(w);
    if (b) run(b[0], b[1], "bg");
  }
  // 見えている範囲が変わったとき。取得中のものが役に立たないなら、やめて取り直す
  function ensure() {
    if (inflight) {
      const w = wanted && wanted();
      if (!w || inflight.kind === "tail") return;
      const v = viewRequest(w.view[0], w.view[1], w.now);
      if (!v) return;
      const overlaps = v[0] < inflight.e && inflight.s < v[1];
      if (inflight.kind === "bg" || !overlaps) inflight.ctrl.abort();
      return;
    }
    pump();
  }
  // 最新の分（取得が進んだとき）。末尾の少し手前から今まで
  function refreshTail(now) {
    const last = covered.length ? covered[covered.length - 1][1] : null;
    if (last == null) return;
    const s = Math.max(last - 1800, now - MAX_SPAN), e = now;
    tailQ = tailQ ? { s: Math.min(tailQ.s, s), e: Math.max(tailQ.e, e) } : { s, e };
    if (inflight && inflight.kind === "bg") inflight.ctrl.abort();
    pump();
  }
  // 再試行（読み込みの失敗の表示から）
  function retry() { failed = null; bgFailed = false; pump(); }

  async function run(s, e, kind) {
    s = Math.floor(s); e = Math.ceil(e);
    if (e - s < 60) e = s + 60;
    const ctrl = new AbortController();
    inflight = { s, e, ctrl, kind };
    onChange && onChange("loading");
    let ok = false, aborted = false;
    try {
      const r = await api.history(s, e, ctrl.signal);
      merge(r);
      ok = true;
      if (kind !== "bg") failed = null;
    } catch (err) {
      if (err && err.name === "AbortError") aborted = true;
      else if (kind === "bg") bgFailed = true;
      else failed = err;
    }
    inflight = null;
    // 失敗したときは自動で取り直さない（同じ要求を繰り返さないため。範囲を変えるか［再試行］で取り直す）。tail は別
    if (ok || aborted || tailQ) pump();
    onChange && onChange("data");
  }

  function spliceRange(arr, s, e, incoming) {
    // arr（時刻順）の [s, e] の部分を incoming で置き換える
    const i0 = lowerBound(arr, s), i1 = upperBound(arr, e);
    return arr.slice(0, i0).concat(incoming, arr.slice(i1));
  }
  function spliceMap(map, s, e, incoming) {
    for (const key of new Set([...map.keys(), ...incoming.keys()])) {
      const inc = (incoming.get(key) || []).sort((a, b) => a[0] - b[0]);
      map.set(key, spliceRange(map.get(key) || [], s, e, inc));
    }
  }
  function group(list, keyOf, valOf) {
    const m = new Map();
    for (const x of list || []) {
      const k = keyOf(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(valOf(x));
    }
    return m;
  }
  function merge(r) {
    const s = r.since, e = r.until;
    const got = new Map();
    for (const sr of r.series || []) {
      if (!KINDS.includes(sr.kind)) continue;
      const pts = [];
      for (const g of sr.segments) for (const p of g.points) pts.push([p[0], p[1], g.window_id]);
      got.set(`${sr.account_id}|${sr.kind}`, pts);
    }
    // この範囲で点が無くなった系列も差し替える（取得し直したら消えていた場合）
    spliceMap(series, s, e, got);
    spliceMap(errs, s, e, group(r.errors, (x) => x.account_id, (x) => [x.t, x.status]));
    spliceMap(resets, s, e, group(r.resets, (x) => `${x.account_id}|${x.kind}`, (x) => [x.t]));
    // サーバーの gaps: この範囲に少しでも重なる古いものは捨てる（境目をまたぐものは、手元で判定し直す）
    const gg = group(r.gaps, (x) => x.account_id, (x) => [x.from, x.to]);
    for (const id of new Set([...srvGaps.keys(), ...gg.keys()])) {
      const keep = (srvGaps.get(id) || []).filter(([f, t]) => t < s || f > e);
      srvGaps.set(id, keep.concat(gg.get(id) || []).sort((a, b) => a[0] - b[0]));
    }
    const sp = new Map();
    for (const x of r.spans || []) sp.set(x.account_id, x.first === x.last ? [[x.first]] : [[x.first], [x.last]]);
    spliceMap(anchors, s, e, sp);
    addFetched(s, e);
    addCovered(s, e);
    // 最も古い点。取った範囲の始まりより十分あとに最初の点があれば、それより前に記録は無い
    let first = Infinity;
    for (const arr of series.values()) if (arr.length) first = Math.min(first, arr[0][0]);
    for (const arr of anchors.values()) if (arr.length) first = Math.min(first, arr[0][0]);
    if (isFinite(first)) {
      earliest = first;
      earliestFinal = covered[0][0] < first - 3600;
    }
    version++;
  }

  // ---- 描画用のモデル ----
  // accounts: [{id, status}]（タイル・重ね合わせに出すもの）。version・accounts・時刻（分）が変わったときだけ作り直す
  //（エラーの帯を「今」まで伸ばすので、時刻もキーに入れる）
  function model(accounts, now) {
    const key = version + "|" + Math.floor(now / 60) + "|" + accounts.map((a) => a.id + ":" + a.status + ":" + intervalOf(a.id)).join(",");
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
    // 取得の抜け: サーバーの gaps ＋ 取得した範囲の境目をまたぐもの（手元でわかる取得の時刻から）
    const gaps = (srvGaps.get(a.id) || []).map(([from, to]) => ({ from, to }));
    const times = [];
    for (const arr of [wk, ss, er, anchors.get(a.id) || []]) for (const p of arr) times.push(p[0]);
    for (const g of gaps) times.push(g.from, g.to);
    times.sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) {
      const p = times[i - 1], q = times[i];
      if (q - p <= iv * 3 || !coveredAt(p, q) || inOneFetch(p, q)) continue;
      if (gaps.some((g) => g.from <= p && q <= g.to)) continue;
      gaps.push({ from: p, to: q });
    }
    gaps.sort((x, y) => x.from - y.from);
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
    ensure, refreshTail, retry, model, isCovered, uncoveredIn,
    get loading() { return !!inflight; },
    // 見えている範囲（または最新の分）を取りに行っているか（縮図のための取得では「読み込み中」を出さない）
    get loadingView() { return !!inflight && inflight.kind !== "bg"; },
    get failed() { return failed; },
    get version() { return version; },
    get hasData() { return covered.length > 0; },
    get earliest() { return earliestFinal ? earliest : null; },
    get coveredStart() { return covered.length ? covered[0][0] : null; },
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
