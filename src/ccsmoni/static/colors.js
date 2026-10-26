// アカウントの色。
// 何を: サーバーが返す色の番号（color_slot）を、いまのテーマのパレットの色にする。独自の色（color: #rrggbb）はそのまま。
// なぜ: 検証済みの7色はライトとダークで段が違う（dataviz の validator で、それぞれの面に対して隣接ペアに合格したもの）。
//       hex をサーバーで決めると、テーマを切り替えたときに合わなくなる。
// 方針: パレットは /api/state の palette を正とし、届くまでは同じ値の控えを使う。

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
};
let palette = FALLBACK;

export function setPalette(p) {
  if (p && Array.isArray(p.light) && Array.isArray(p.dark) && p.light.length && p.dark.length) palette = p;
}
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
export function themePalette() {
  return palette[isDark() ? "dark" : "light"];
}
// a: { color_slot, color }（state の accounts / archived、config の slots と同じ形）
export function colorOf(a) {
  if (a && typeof a.color === "string" && HEX.test(a.color)) return a.color;
  const pal = themePalette();
  if (a && Number.isInteger(a.color_slot)) return pal[((a.color_slot % pal.length) + pal.length) % pal.length];
  return "#8a8983";
}
export function rgba(hex, a) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
export const isHex = (s) => typeof s === "string" && HEX.test(s);
