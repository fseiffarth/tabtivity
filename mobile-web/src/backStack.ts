/**
 * The phone's Back: Android's back gesture (a swipe in from the screen's
 * edge) and its back button step back through the app — a sheet or a viewer
 * closes, a tab returns to its project, a project to the list — instead of
 * leaving it. The app's screens are React state, not URLs, so the browser had
 * no entry to go back to and Back closed the PWA from anywhere.
 *
 * Whatever is open registers a layer (`useBackLayer`). While any is, one
 * guard entry sits on top of the page's history: Back pops it, the top layer
 * steps back, and the guard goes back on while something is still open. The
 * last layer closing by its own button takes the guard off again, so Back at
 * the project list leaves the app at the first press.
 *
 * The top layer is the deepest (`BackNest`), then the latest opened: effects
 * run child-first, so a screen and a sheet it opens on arrival register in
 * the wrong order without the depth.
 */
import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";

interface Layer { seq: number; depth: number; back: () => void }

/** Marks the guard entry in `history.state`, so a reloaded page knows it
 * stands on one. */
const GUARD = "backGuard";

let layers: Layer[] = [];
let seq = 0;
/** Whether the guard entry is the current history entry. */
let guarded = false;
/** `history.back()` calls of our own whose `popstate` is still to come. */
let ownPops = 0;
let installed = false;

function top(): Layer | undefined {
  let best: Layer | undefined;
  for (const layer of layers) {
    if (!best || layer.depth > best.depth || (layer.depth === best.depth && layer.seq > best.seq)) best = layer;
  }
  return best;
}

/** Puts the guard on while something is open and takes it off when nothing
 * is. Waits out a pending pop of our own: a push queued behind it would land
 * before it in some browsers. */
function sync() {
  if (ownPops > 0) return;
  try {
    if (layers.length > 0 && !guarded) {
      window.history.pushState({ ...(window.history.state as object | null), [GUARD]: true }, "");
      guarded = true;
    } else if (layers.length === 0 && guarded) {
      guarded = false;
      ownPops += 1;
      try {
        window.history.back();
      } catch (error) {
        ownPops -= 1;
        throw error;
      }
    }
  } catch {
    // A sandboxed frame or a throttled history: Back just leaves, as before.
  }
}

function onPopState() {
  if (ownPops > 0) {
    ownPops -= 1;
    sync();
    return;
  }
  guarded = false;
  const layer = top();
  if (layer) layer.back();
  // Still open (a folder went up one, a tab went back to its project): the
  // guard goes back on. Looked at once React has committed the step — an
  // update from `popstate` renders before the next task — so a layer that
  // closed is gone by then and no guard is pushed only to be popped again.
  window.setTimeout(sync, 0);
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("popstate", onPopState);
  // A reload on a guard entry: there is nothing open yet to step back from.
  try {
    if ((window.history.state as Record<string, unknown> | null)?.[GUARD] === true) {
      guarded = true;
      queueMicrotask(sync);
    }
  } catch {
    // unreadable state: start unguarded
  }
}
// At load, not at the first layer: a reload at the project list has none,
// and its guard would cost a Back press that does nothing.
if (typeof window !== "undefined") install();

/** Whether a Back now would step back inside the app rather than leave it. */
export function canGoBack(): boolean {
  return layers.length > 0;
}

/** What an in-app swipe does: the same step a Back takes, through the same
 * guard, so the two never disagree. Nothing open: nothing happens — an
 * in-app swipe never leaves the app. */
export function goBack(): void {
  if (layers.length === 0) return;
  if (guarded && ownPops === 0) {
    try {
      window.history.back();
      return;
    } catch {
      // fall through to stepping back directly
    }
  }
  top()?.back();
}

const BackDepth = createContext<{ depth: number; off: boolean }>({ depth: 0, off: false });

/** Children's layers sit above this component's: a screen wraps what opens
 * inside it. `off`: a subtree kept mounted but hidden (a tucked-away markup
 * view) takes no Back while it is. */
export function BackNest({ children, off = false }: { children?: ReactNode; off?: boolean }) {
  const outer = useContext(BackDepth);
  return createElement(BackDepth.Provider, { value: { depth: outer.depth + 1, off: outer.off || off } }, children);
}

/**
 * Registers a step back while `back` is given and `active` holds — a sheet
 * passes its `onClose`, a screen its ‹. The latest `back` is called, so a
 * re-render never re-registers (which would move the layer to the top).
 */
export function useBackLayer(back: (() => void) | null | undefined, active = true): void {
  const { depth, off } = useContext(BackDepth);
  const latest = useRef(back);
  useEffect(() => {
    latest.current = back;
  });
  const on = active && !off && !!back;
  useEffect(() => {
    if (!on) return;
    install();
    const layer: Layer = { seq: ++seq, depth, back: () => latest.current?.() };
    layers = [...layers, layer];
    sync();
    return () => {
      layers = layers.filter((entry) => entry !== layer);
      sync();
    };
  }, [on, depth]);
}

/** Test hook: forget every layer and the guard. */
export function resetBackStackForTests(): void {
  layers = [];
  guarded = false;
  ownPops = 0;
}
