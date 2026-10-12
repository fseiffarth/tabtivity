import { configure } from "@testing-library/react";
import {
  installTestGuards,
  unmockedFetch,
  unmockedInvoke,
} from "./__tests__/helpers/testGuards";

// The heavy in-app viewer tests (FileViewerPane pulls in pdfjs/katex/mermaid/
// xlsx) render and resolve async load chains that, under the full suite's
// parallel CPU load, routinely exceed Testing Library's 1s default
// `waitFor`/`findBy*` budget — producing timeout flakes that pass in isolation.
// A wrong assertion still fails (just later), so this only buys patience, not
// false greens. The Tauri-side real-timer poll tests bump their own explicit
// `waitFor` budgets on top of this.
configure({ asyncUtilTimeout: 10000 });

// jsdom has no Tauri runtime, so `window.__TAURI_INTERNALS__` is undefined.
// Components that subscribe via `listen()` (e.g. FileTree's fs-change watcher)
// call it on mount; the real `@tauri-apps/api/event` `listen` synchronously hits
// `transformCallback` → `window.__TAURI_INTERNALS__.transformCallback` and the
// resulting rejection is uncaught, which vitest reports as an "Unhandled
// Rejection" error (failing the run's exit code) even though every test passes.
// Tests that mock `@tauri-apps/api/*` are unaffected (the mock replaces the
// module); this stub only makes the real event plumbing inert. A real, unmocked
// *command* fails its test (see `helpers/testGuards`). Each test that mocks core
// still controls its own `invoke` resolutions.
if (!(globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } })
  .window?.__TAURI_INTERNALS__) {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: unmockedInvoke,
    convertFileSrc: (p: string) => p,
    unregisterCallback: () => {},
  };
  // The event plugin's unlisten path goes through a separate global.
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown })
    .__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => Promise.resolve(),
  };
}

// Global test setup (referenced by vitest.config.ts `setupFiles`).
//
// jsdom has no layout engine and so provides no ResizeObserver. Several
// components (e.g. TabBar's overflow/scroll-state tracking) construct one at
// mount, which would otherwise throw `ResizeObserver is not defined` during any
// render that mounts them. A NO-OP stub is the right default: tests that care
// about resize behavior drive it explicitly via dispatched events.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

// jsdom does not implement the CSS interface, so `CSS.escape` (used when
// building attribute selectors in drag/drop hit-testing) is undefined. Provide a
// minimal, spec-faithful escape so those selectors resolve in tests.
const cssObj = (globalThis as unknown as { CSS?: { escape?: unknown } }).CSS;
if (!cssObj || typeof cssObj.escape !== "function") {
  const escape = (value: string) =>
    String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  if (cssObj) cssObj.escape = escape;
  else (globalThis as unknown as { CSS: unknown }).CSS = { escape };
}

// No test reaches the network or the Tauri backend: an unmocked `fetch` or
// `invoke` command is rejected and fails the test that made it, by name, on
// every machine — not just on the CI runner slow enough to see the fallout.
globalThis.fetch = unmockedFetch;
installTestGuards();
