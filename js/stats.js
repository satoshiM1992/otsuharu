// Popularity (0..100) shown as concurrent viewers and channel subscribers.
// Shared by the engine ({viewers} / {subs} in lines) and the UI (HUD, overlay).

/** 23 viewers at 0, about 20,000 at 100 (exponential, like real channel growth). */
export const viewersFor = (pop) => Math.round(23 * 870 ** (pop / 100));

/** 180 subscribers at 0, about 72,000 at 100. */
export const subsFor = (pop) => Math.round(180 * 400 ** (pop / 100));

/** 1,234 / 1.2万 / 12万 */
export function fmtCount(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return n.toLocaleString('ja-JP');
}
