/**
 * Loading a deck's **embedded fonts** (TODO V #120).
 *
 * The one rule this file exists to keep is the one `deck/fonts.ts` is built on:
 * **the face that is measured must be the face that is drawn, and the face that
 * is drawn must be the face that is embedded.** Three consumers, one source of
 * bytes:
 *
 *  - `metrics.register(path, bytes)` — line breaking, on the stage and in the
 *    exporter;
 *  - an `@font-face` installed into the document — what the DOM renderer paints;
 *  - `exportDeck({ fonts })` — what pdf-lib embeds.
 *
 * Splitting those across three loaders is precisely how an export silently
 * reflows, which is the failure the shared-metrics design was created to prevent.
 * So there is one hook, it hands the same `Map` to all three, and a font it
 * could not read is reported as *missing* rather than quietly substituted in one
 * place and not another.
 *
 * Lives beside `deckAssets.ts` for the same reason that file exists: the audience
 * window is a separate webview with its own heap and its own `document`, so it
 * must install its own `@font-face` rules rather than be handed the editor's.
 */

import { useEffect, useRef, useState } from "react";
import { readFileBytes } from "../../../lib/files/fileAccess";
import { type Deck, customFontsOf } from "../../../lib/viewers/deck/model";
import { type TextMetrics, cssFontName } from "../../../lib/viewers/deck/fonts";
import { dirOf, resolveRel } from "./deckAssets";

export interface LoadedFonts {
  /** Font path → file bytes, for `exportDeck`. */
  bytes: ReadonlyMap<string, Uint8Array>;
  /** Paths that could not be read or parsed, so the UI can say which. */
  missing: ReadonlySet<string>;
}

/**
 * Read every font the deck references, register it for measurement, and install
 * it as an `@font-face` so the DOM renderer paints with it too.
 *
 * `metrics` may be null on the first renders; the effect re-runs when it
 * resolves, so registration is never skipped for a deck opened before the
 * standard faces finished embedding.
 */
export function useDeckFonts(
  deck: Deck | null,
  path: string,
  scope: string | null,
  metrics: TextMetrics | null,
): LoadedFonts {
  const [bytes, setBytes] = useState<Map<string, Uint8Array>>(new Map());
  const [missing, setMissing] = useState<Set<string>>(new Set());
  /** `@font-face` rules this hook installed, so they are removed on unmount
   *  rather than accumulating one per deck tab opened this session. */
  const installed = useRef<Map<string, HTMLStyleElement>>(new Map());

  useEffect(() => {
    if (!deck || !metrics) return;
    const wanted = customFontsOf(deck);
    const todo = wanted.filter((p) => !bytes.has(p) && !missing.has(p));
    if (todo.length === 0) return;
    let live = true;
    void (async () => {
      const added = new Map<string, Uint8Array>();
      const failed = new Set<string>();
      const dir = dirOf(path);
      for (const rel of todo) {
        try {
          const raw = new Uint8Array(await readFileBytes(resolveRel(dir, rel), scope));
          // Registration is what decides whether this face is USABLE: a file
          // fontkit cannot parse must count as missing on all three sides at
          // once, or the layout is measured against one face and drawn with
          // another.
          if (await metrics.register(rel, raw)) added.set(rel, raw);
          else failed.add(rel);
        } catch {
          failed.add(rel);
        }
      }
      if (!live) return;
      if (added.size) {
        for (const [p, raw] of added) install(p, raw, installed.current);
        setBytes((cur) => new Map([...cur, ...added]));
      }
      if (failed.size) setMissing((cur) => new Set([...cur, ...failed]));
    })();
    return () => {
      live = false;
    };
  }, [deck, metrics, path, scope, bytes, missing]);

  useEffect(
    () => () => {
      for (const el of installed.current.values()) el.remove();
      installed.current.clear();
    },
    [],
  );

  return { bytes, missing };
}

/**
 * Install one font as an `@font-face` via a data URL.
 *
 * A data URL rather than a blob URL: a blob URL is revoked on unmount, and a
 * `@font-face` whose source has been revoked renders as the fallback with no
 * error anywhere — a silent, intermittent version of exactly the drift this
 * module prevents. Fonts are small enough that the base64 cost is worth the
 * lifetime being tied to the rule instead of to a handle.
 */
function install(path: string, raw: Uint8Array, into: Map<string, HTMLStyleElement>): void {
  if (into.has(path) || typeof document === "undefined") return;
  let bin = "";
  for (let i = 0; i < raw.length; i += 1) bin += String.fromCharCode(raw[i]);
  const el = document.createElement("style");
  el.dataset.deckFont = path;
  el.textContent =
    `@font-face { font-family: "${cssFontName(path)}"; ` +
    `src: url(data:font/ttf;base64,${btoa(bin)}); font-display: block; }`;
  document.head.appendChild(el);
  into.set(path, el);
}
