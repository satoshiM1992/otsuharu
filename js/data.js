// Loads data/scenario.json. Chapters may be listed as file names
// ("chapters": ["chapters/ch1.json", ...]) to keep each file small; they are
// fetched relative to the data/ folder and inlined in order.

export async function loadScenario(base = 'data/') {
  const get = async (path) => {
    const res = await fetch(base + path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  const data = await get('scenario.json');
  data.chapters = await Promise.all(data.chapters.map((c) => (typeof c === 'string' ? get(c) : c)));
  return data;
}
