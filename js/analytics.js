// Anonymous play statistics with GoatCounter (https://www.goatcounter.com):
// no cookies, no third-party script — each event is one small image request.
// Nothing is sent until SITE_CODE is set, on localhost, with ?debug / ?seed,
// or when the browser asks not to be tracked.
//
//   track('ending/lover')  → shows up in GoatCounter as the event "ending/lover"
//
// To enable: sign up at goatcounter.com, pick a code (e.g. "oshivtuber"),
// and put it in SITE_CODE below.

export const SITE_CODE = 'satoshim1992'; // ← GoatCounter code; empty = analytics off

const params = new URLSearchParams(location.search);
const off =
  !SITE_CODE ||
  /^(localhost|127\.|\[::1\])/.test(location.hostname) ||
  location.protocol === 'file:' ||
  params.has('debug') ||
  params.has('seed') ||
  navigator.doNotTrack === '1' ||
  navigator.globalPrivacyControl === true;

export const analyticsOn = !off;

function send(q) {
  if (off) return;
  try {
    q.rnd = Math.random().toString(36).slice(2, 8); // defeat caches
    new Image().src = `https://${SITE_CODE}.goatcounter.com/count?${new URLSearchParams(q)}`;
  } catch {
    /* statistics must never break the game */
  }
}

/** One page view (title screen). */
export function pageview() {
  send({ p: location.pathname, t: document.title, r: document.referrer, s: `${screen.width},${screen.height},${devicePixelRatio || 1}` });
}

/** A named event, e.g. track('chapter/3'). No personal data: ids only. */
export function track(name) {
  send({ p: name, t: name, e: 'true' });
}
