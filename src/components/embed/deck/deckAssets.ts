/**
 * Loading a deck's *heavy* parts — placed images and interstitial GIFs.
 *
 * Extracted from `DeckView` when the dual-window presenter landed: the audience
 * window is a separate webview with its own heap, so it cannot be handed the
 * editor's blob URLs or decoded frames — it must load them itself. Two copies of
 * this would be two chances to leak, since both halves own resources the GC
 * cannot reclaim (an object URL and an `ImageBitmap`), so there is one.
 *
 * Both hooks own their resources for the lifetime of the mount and release what
 * leaves the deck as it leaves, plus everything at unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readFileBytes } from "../fileAccess";
import { normalizePath } from "../../../lib/paths";
import type { Deck, Interstitial } from "../../../lib/viewers/deck/model";
import { type DecodedGif, decodeInterstitial, disposeGif } from "./gifPlayback";

/** The directory part of a path, `""` for a bare filename. */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

/** Resolve a deck-relative asset path against the sidecar's own directory.
 *
 *  A `.`/`..` segment is folded away: `deckRelative` stores a figure beside or
 *  above the deck as `../figures/x.png` (V #108), and the backend's file
 *  commands refuse any path that still holds a `..` (threat recheck gap 22). */
export function resolveRel(dir: string, rel: string): string {
  const joined = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : dir ? `${dir}/${rel}` : rel;
  return /(^|[\\/])\.\.?([\\/]|$)/.test(joined) ? normalizePath(joined) : joined;
}

/** The per-deck folder a TeX-figure object's source/PDF/PNG live in, beside the
 *  sidecar — kept out of the main `.tex`'s own directory so a figure's build
 *  artifacts (`.aux`/`.log`) never clutter the deck's own folder listing. */
export function texFigureDir(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.tex-figures`;
}

/** `rel` as an absolute path when it names a file directly in the deck's own
 *  figure folder (`<deck>.tex-figures/<name><ext>`), else null. */
function figureFile(deckPath: string, rel: string, ext: string): string | null {
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 2) return null;
  const [folder, name] = parts;
  const dir = texFigureDir(deckPath);
  const own = dir.slice(Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\")) + 1);
  if (folder !== own) return null;
  // A plain name: not empty, not `.`/`..`, no drive or stream colon, no
  // control character, no `~` (a Windows 8.3 alias such as `EVIL~1.PNG`
  // names another file in the folder), and more than the bare extension.
  if (name === "." || name === ".." || [...name].some((c) => c === ":" || c === "~" || c.charCodeAt(0) < 0x20)) {
    return null;
  }
  if (name.length <= ext.length || !name.toLowerCase().endsWith(ext)) return null;
  return `${dir}/${name}`;
}

/**
 * Where the deck may write a TeX figure's PNG, or null when it may not
 * (decision D3, threat recheck gap 23).
 *
 * The deck re-rasters a figure with no click (the figure poll) and on
 * Recompile, so whatever the deck JSON says its `src` is gets overwritten — and
 * that JSON may come from anyone who can write the project. Only a `.png`
 * directly in the deck's own figure folder is written: a relative `src` with
 * no `..`, no absolute path, no other folder and no nesting. Anything else is
 * read as an image (picked figures above the deck are legitimate) but never
 * written.
 */
export function figureTarget(deckPath: string, src: string): string | null {
  return figureFile(deckPath, src, ".png");
}

/** The `.tex` a TeX figure may compile, by the same rule as `figureTarget`:
 *  a compile writes its `.pdf`/`.aux`/`.log` beside the source. */
export function figureSource(deckPath: string, texSrc: string): string | null {
  return figureFile(deckPath, texSrc, ".tex");
}

/** Every interstitial in the deck, in slide order. */
export function interstitialsOf(deck: Deck | null): Interstitial[] {
  return (deck?.slides ?? [])
    .map((s) => s.after)
    .filter((a): a is Interstitial => a != null);
}

/**
 * Blob URLs for every image object's bytes, keyed by the deck-relative `src`.
 *
 * A missing image resolves to no entry — `DeckObjectView` draws its own
 * placeholder, which is more useful mid-talk than an error banner over an
 * otherwise fine slide.
 *
 * Returns a `refresh(src)` alongside the map: a TeX-figure object's PNG is
 * overwritten **at the same path** every time its source recompiles, so the
 * ordinary "fetch only what's missing" effect below would never notice the new
 * bytes. The editor calls `refresh` right after it rewrites such a file to evict
 * the stale blob URL and force a re-fetch.
 */
export function useDeckImages(deck: Deck | null, path: string, scope: string | null) {
  const [assets, setAssets] = useState<Map<string, string>>(new Map());

  const refresh = useCallback((src: string) => {
    setAssets((cur) => {
      const url = cur.get(src);
      if (!url) return cur;
      URL.revokeObjectURL(url);
      const next = new Map(cur);
      next.delete(src);
      return next;
    });
  }, []);

  const wantedSrcs = useMemo(() => {
    const out = new Set<string>();
    for (const s of deck?.slides ?? []) {
      for (const o of s.objects) if (o.kind === "image") out.add(o.src);
    }
    return out;
  }, [deck]);

  useEffect(() => {
    let live = true;
    const dir = dirOf(path);
    const missing = [...wantedSrcs].filter((s) => !assets.has(s));
    if (missing.length === 0) return;
    void (async () => {
      const added = new Map<string, string>();
      for (const rel of missing) {
        try {
          const bytes = await readFileBytes(resolveRel(dir, rel), scope);
          added.set(rel, URL.createObjectURL(new Blob([new Uint8Array(bytes)])));
        } catch {
          /* placeholder, see above */
        }
      }
      if (!live) {
        added.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      if (added.size) setAssets((cur) => new Map([...cur, ...added]));
    })();
    return () => {
      live = false;
    };
  }, [wantedSrcs, assets, path, scope]);

  useEffect(() => {
    // Drop URLs for images no longer anywhere in the deck.
    const stale = [...assets.keys()].filter((k) => !wantedSrcs.has(k));
    if (stale.length === 0) return;
    setAssets((cur) => {
      const next = new Map(cur);
      for (const k of stale) {
        URL.revokeObjectURL(next.get(k)!);
        next.delete(k);
      }
      return next;
    });
  }, [wantedSrcs, assets]);

  // Unmount: revoke whatever is left. Its own effect with an empty dep list so it
  // fires once, at teardown, rather than on every asset change.
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  useEffect(
    () => () => {
      assetsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  return { assets, refresh };
}

/**
 * Decoded interstitial clips, keyed by interstitial id.
 *
 * Decoded lazily and kept for the session: a clip costs real memory (every GIF
 * frame is a full-canvas RGBA copy), so `gifPlayback` caps each one, and the
 * bitmaps are explicitly closed when they leave the deck.
 */
export function useDeckGifs(
  interstitials: readonly Interstitial[],
  path: string,
  scope: string | null,
) {
  /**
   * Cache key: **id AND source path**.
   *
   * Replacing an interstitial's GIF reuses the existing interstitial id
   * (`DeckAnimate.pickGif` does that deliberately, so the object keeps its
   * identity), so keying by id alone meant a replaced clip was never re-decoded
   * and the presenter kept playing the old one forever (TODO V #110). Exactly the
   * bug `useDeckImages` already fixed with `refresh(src)`, one hook over.
   */
  const [gifs, setGifs] = useState<Map<string, DecodedGif>>(new Map());
  /**
   * Sources that failed to decode. Without this the effect re-reads and
   * **re-decodes** a broken clip on every render that touches the deck — a full
   * LZW pass over a file that will never work.
   */
  const failed = useRef<Set<string>>(new Set());

  const refresh = useCallback((key: string) => {
    failed.current.delete(key);
    setGifs((cur) => {
      const hit = cur.get(key);
      if (!hit) return cur;
      disposeGif(hit);
      const next = new Map(cur);
      next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    const dir = dirOf(path);
    const missing = interstitials.filter(
      (a) => !gifs.has(gifKey(a)) && !failed.current.has(gifKey(a)),
    );
    if (missing.length === 0) return;
    void (async () => {
      const added = new Map<string, DecodedGif>();
      for (const a of missing) {
        try {
          const bytes = await readFileBytes(resolveRel(dir, a.src), scope);
          added.set(gifKey(a), await decodeInterstitial(new Uint8Array(bytes)));
        } catch {
          // A clip that will not decode shows as "Loading animation…" in the
          // presenter rather than taking the talk down — and is remembered as
          // failed so it is not re-read and re-decoded on every edit.
          failed.current.add(gifKey(a));
        }
      }
      if (!live) {
        added.forEach((g) => disposeGif(g));
        return;
      }
      if (added.size) setGifs((cur) => new Map([...cur, ...added]));
    })();
    return () => {
      live = false;
    };
  }, [interstitials, gifs, path, scope]);

  // Drop clips no longer in the deck — including the OLD entry of a replaced
  // one, since its `id:src` key stops being wanted the moment `src` changes.
  useEffect(() => {
    const wanted = new Set(interstitials.map(gifKey));
    const stale = [...gifs.keys()].filter((k) => !wanted.has(k));
    if (stale.length === 0) return;
    setGifs((cur) => {
      const next = new Map(cur);
      for (const k of stale) {
        const g = next.get(k);
        if (g) disposeGif(g);
        next.delete(k);
      }
      return next;
    });
  }, [interstitials, gifs]);

  const gifsRef = useRef(gifs);
  gifsRef.current = gifs;
  useEffect(
    () => () => {
      gifsRef.current.forEach((g) => disposeGif(g));
    },
    [],
  );

  return { gifs, refresh };
}

/** The `useDeckGifs` cache key for an interstitial — see the hook's own note on
 *  why the source path is part of it. */
export function gifKey(a: Pick<Interstitial, "id" | "src">): string {
  return `${a.id}:${a.src}`;
}
