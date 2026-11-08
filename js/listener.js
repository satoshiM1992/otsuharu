// Listener-type result shown on the ending screen and in the share text.
// data.listenerTypes is checked in order; the first whose conditions all hold wins:
//   minShare {kind|mitsugi|neta: 0..1}   share of that comment style
//   maxShare {style: 0..1}               (every style at most this share: "balanced")
//   minMiss  0..1                        share of 💣 trap / 💀 bad choices
//   minGesu  n                           creepy / dirty comments posted
//   maxMiss  0..1
// An entry without conditions is the fallback.

export const STYLE_ICON = { kind: '😇', mitsugi: '💰', neta: '🤪' };

export function listenerStats(state) {
  const t = state.styleTotals ?? {};
  const total = (t.kind ?? 0) + (t.mitsugi ?? 0) + (t.neta ?? 0);
  const share = {};
  for (const k of Object.keys(STYLE_ICON)) share[k] = total ? (t[k] ?? 0) / total : 0;
  const c = state.typeCounts ?? {};
  const choices = Object.values(c).reduce((a, b) => a + b, 0);
  const miss = choices ? ((c.trap ?? 0) + (c.bad ?? 0)) / choices : 0;
  return { share, total, choices, miss, gesu: state.gesu ?? 0 };
}

export function listenerType(types, state) {
  const st = listenerStats(state);
  const ok = (cond = {}) => {
    for (const [k, v] of Object.entries(cond.minShare ?? {})) if (st.share[k] < v) return false;
    if (cond.maxShare != null && Object.values(st.share).some((x) => x > cond.maxShare)) return false;
    if (cond.minMiss != null && st.miss < cond.minMiss) return false;
    if (cond.maxMiss != null && st.miss > cond.maxMiss) return false;
    if (cond.minGesu != null && st.gesu < cond.minGesu) return false;
    return true;
  };
  const type = types.find((x) => ok(x.if)) ?? types[types.length - 1];
  return { type, stats: st };
}

/** "😇20% 💰60% 🤪20%" */
export function shareText(st) {
  const pct = Object.entries(st.share).map(([k, v]) => [k, Math.round(v * 100)]);
  // make the rounded numbers add up to 100
  const diff = 100 - pct.reduce((a, [, v]) => a + v, 0);
  if (st.total && diff) pct.sort((a, b) => b[1] - a[1])[0][1] += diff;
  return pct.sort((a, b) => Object.keys(STYLE_ICON).indexOf(a[0]) - Object.keys(STYLE_ICON).indexOf(b[0])).map(([k, v]) => `${STYLE_ICON[k]}${v}%`).join(' ');
}
