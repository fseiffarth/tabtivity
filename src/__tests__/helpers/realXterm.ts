/**
 * What a REAL `@xterm/xterm` needs from jsdom to open, measure and paint with
 * its DOM renderer, for the tests that run the shipped package instead of a
 * stand-in.
 *
 * jsdom has no layout, so xterm measures its cell as 0×0 and everything that
 * divides by it (FitAddon, mouse reports, the scrollbar) gives up. The cell is
 * measured off its `.xterm-char-measure-element` spans (32 "W"s, read through
 * `offsetWidth`/`offsetHeight` when there is no OffscreenCanvas, as in jsdom),
 * so only those report a size: CELL_W × CELL_H. `matchMedia` is the one more
 * thing xterm's device-pixel-ratio watcher calls, and a canvas never gives a
 * context (see below).
 *
 * `pane` also gives every element a layout box (`clientWidth`/`clientHeight`/
 * `offsetParent`) — what `TerminalView` waits for before it opens a terminal.
 */
export const CELL_W = 10;
export const CELL_H = 20;

type Restore = () => void;

function override(proto: object, prop: string, get: (this: HTMLElement, original: () => unknown) => unknown): Restore {
  const original = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return get.call(this, () => original?.get?.call(this) ?? original?.value);
    },
  });
  return () => {
    if (original) Object.defineProperty(proto, prop, original);
    else delete (proto as Record<string, unknown>)[prop];
  };
}

export function installXtermLayout(opts: { pane?: { width: number; height: number } } = {}): Restore {
  const restores: Restore[] = [];
  const measured = (el: HTMLElement) => el.classList.contains("xterm-char-measure-element");
  restores.push(override(HTMLElement.prototype, "offsetWidth", function (original) {
    return measured(this) ? CELL_W * 32 : original();
  }));
  restores.push(override(HTMLElement.prototype, "offsetHeight", function (original) {
    return measured(this) ? CELL_H : original();
  }));
  if (opts.pane) {
    const { width, height } = opts.pane;
    restores.push(override(HTMLElement.prototype, "clientWidth", () => width));
    restores.push(override(HTMLElement.prototype, "clientHeight", () => height));
    restores.push(override(HTMLElement.prototype, "offsetParent", () => document.body));
  }
  // jsdom has no canvas: `getContext` answers null either way, but logs a
  // "not implemented" line per call. A webview without WebGL2 answers null too,
  // which is what the WebGL addon is meant to survive.
  const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, writable: true, value: () => null });
  restores.push(() => {
    if (getContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
  });
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    restores.push(() => {
      if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
      else delete (window as unknown as Record<string, unknown>).matchMedia;
    });
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

/** `term.write` as a promise: resolved once xterm has parsed `data`. */
export function written(term: { write(data: string, done: () => void): void }, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}
