/**
 * The one way a small JSON record is kept in `localStorage` — a convenience
 * the app can lose without harm (a remembered view, a draft, a place), never
 * state that must survive: a private window, blocked or full storage, a
 * hand-edited or future-version value all read as "nothing kept" and write as
 * "not kept this time", and never throw into the caller.
 *
 * `storage` is injectable (tests pass a fake; the default is `localStorage`,
 * looked up inside the guard because merely touching it can throw).
 */

export type JsonStorage = Pick<Storage, "getItem" | "setItem"> & { removeItem?: Storage["removeItem"] };

/**
 * Read `key` as JSON and hand it to `parse`, which checks it field by field
 * and returns the value to use (it receives `unknown`: never trust a stored
 * shape). A missing key, unparsable JSON, a refusing store or a throwing
 * `parse` all give `fallback`.
 */
export function readJson<T>(key: string, parse: (raw: unknown) => T, fallback: T, storage?: JsonStorage): T {
  try {
    const stored = (storage ?? localStorage).getItem(key);
    if (stored === null || stored === undefined) return fallback;
    return parse(JSON.parse(stored));
  } catch {
    return fallback;
  }
}

/**
 * Store `value` under `key`; `undefined` removes the key (the idiom for "an
 * empty record keeps nothing"). Answers whether the store took it.
 */
export function writeJson(key: string, value: unknown, storage?: JsonStorage): boolean {
  try {
    const store = storage ?? localStorage;
    if (value === undefined) store.removeItem?.(key);
    else store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * `map` cut to its last `max` entries in insertion order — callers re-insert a
 * key to mark it fresh (`delete map[k]; map[k] = v`), so the cap drops the
 * least recently written. (Integer-like keys sort first in a plain object; a
 * map keyed by such ids belongs in a list of pairs instead.)
 */
export function cappedMap<V>(map: Record<string, V>, max: number): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const out: Record<string, V> = {};
  for (const key of keys.slice(keys.length - max)) out[key] = map[key];
  return out;
}
