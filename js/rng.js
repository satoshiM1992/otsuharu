// Seeded random number generator (mulberry32).
// The whole game state of the RNG is one 32-bit integer, so it can be saved and restored.

export function createRng(seed) {
  let s = seed >>> 0;
  const rng = {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) {
      return Math.floor(rng.next() * n);
    },
    chance(p) {
      return rng.next() < p;
    },
    pick(arr) {
      if (!arr || arr.length === 0) return undefined;
      return arr[rng.int(arr.length)];
    },
    shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    get state() {
      return s;
    },
    set state(v) {
      s = v >>> 0;
    },
  };
  return rng;
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32) >>> 0;
}
