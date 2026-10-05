/**
 * The PWA's service worker, run against a fake worker scope.
 *
 * Three behaviours are pinned: hashed `/assets/*` are answered from the cache
 * first (they are immutable, so a hit is the whole answer), an asset the cache
 * does not hold is never answered with the cached index.html (an HTML body
 * under a `.js` URL killed the page with "Unexpected token <" instead of the
 * browser's own retry), and the build stamps this build's asset list into the
 * worker so the shell can boot offline after the very first visit.
 */
import { describe, expect, it } from "vitest";
import SOURCE from "../../../mobile-web/public/sw.js?raw";
import INDEX from "../../../mobile-web/index.html?raw";
import { shellAssets } from "../../../mobile-web/src/shellAssets";
import { BRAND } from "../../lib/brand";

const ORIGIN = "https://desktop.example.ts.net";

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  request: { url: string; method: string; mode: string };
  respondWith: (answer: Promise<unknown>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}

/** Evaluate the worker with a cache of `held` URLs and a `fetch` of our choosing. */
function boot(held: Record<string, unknown>, fetch: (url: string) => Promise<unknown>, source = SOURCE) {
  const listeners = new Map<string, Listener>();
  const store = new Map(Object.entries(held).map(([path, body]) => [`${ORIGIN}${path}`, body]));
  const added: string[] = [];
  let puts = 0;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting: () => undefined,
    clients: { claim: () => Promise.resolve() },
  };
  const caches = {
    match: (request: { url: string } | string) => Promise.resolve(store.get(typeof request === "string" ? `${ORIGIN}${request}` : request.url)),
    open: () => Promise.resolve({
      addAll: (paths: string[]) => { added.push(...paths); return Promise.resolve(); },
      put: () => { puts += 1; return Promise.resolve(); },
    }),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };
  const run = new Function("self", "caches", "fetch", "URL", "setTimeout", source);
  run(self, caches, (request: { url: string }) => fetch(request.url), URL, setTimeout);
  const dispatch = (path: string, mode = "no-cors") => new Promise<unknown>((resolve, reject) => {
    listeners.get("fetch")!({
      request: { url: `${ORIGIN}${path}`, method: "GET", mode },
      respondWith: (answer) => answer.then(resolve, reject),
      waitUntil: () => undefined,
    });
  });
  const install = () => new Promise<void>((resolve) => {
    listeners.get("install")!({
      request: { url: "", method: "GET", mode: "" },
      respondWith: () => undefined,
      waitUntil: (work) => void work.then(() => resolve()),
    });
  });
  return { dispatch, install, added, puts: () => puts };
}

const html = { body: "<!doctype html>", ok: true, headers: new Headers({ "content-type": "text/html" }) };
const script = { body: "export {}", ok: true, headers: new Headers({ "content-type": "text/javascript" }) };

describe(`${BRAND.display} Mobile service worker`, () => {
  it("answers a hashed asset from the cache without touching the network", async () => {
    let fetched = 0;
    const { dispatch } = boot({ "/assets/index-abc.js": script }, () => { fetched += 1; return Promise.resolve(script); });
    await expect(dispatch("/assets/index-abc.js")).resolves.toBe(script);
    expect(fetched).toBe(0);
  });

  it("never answers a missing asset with the cached shell document", async () => {
    // Offline, with only the shell cached: the navigation gets the shell, the
    // script it needs gets a network error the browser can report — not HTML.
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    const { dispatch } = boot({ "/": html }, offline);
    await expect(dispatch("/", "navigate")).resolves.toBe(html);
    await expect(dispatch("/assets/index-new.js")).rejects.toThrow("Failed to fetch");
  });

  it("falls back to the shell for a navigation the network cannot serve", async () => {
    const { dispatch } = boot({ "/": html }, () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(dispatch("/some/deep/link", "navigate")).resolves.toBe(html);
  });

  it("serves the cached shell for a navigation the proxy answered with an error page", async () => {
    // The desktop is closed: Tailscale Serve reaches the machine, finds no
    // sidecar, and answers 502 with its own HTML. That is a miss, not a page.
    const proxyError = { body: "<html>502 Bad Gateway</html>", ok: false, status: 502, headers: new Headers({ "content-type": "text/html" }) };
    const { dispatch, puts } = boot({ "/": html }, () => Promise.resolve(proxyError));
    await expect(dispatch("/", "navigate")).resolves.toBe(html);
    // …and the proxy's body is never written into the shell cache.
    expect(puts()).toBe(0);
    // With nothing cached the proxy's answer is still what there is.
    const empty = boot({}, () => Promise.resolve(proxyError));
    await expect(empty.dispatch("/", "navigate")).resolves.toBe(proxyError);
  });

  it("leaves API traffic alone", async () => {
    const { dispatch } = boot({}, () => Promise.resolve(script));
    // No `respondWith` call: the promise never settles, so race it.
    const untouched = await Promise.race([dispatch("/api/v1/projects"), Promise.resolve("untouched")]);
    expect(untouched).toBe("untouched");
  });

  it("leaves the sealed pdf.js frame to the network, even offline", async () => {
    // Its framing policy rides on the answer, and the shell must never be
    // handed to a sandboxed frame as its document.
    const { dispatch } = boot({ "/": html }, () => Promise.reject(new TypeError("Failed to fetch")));
    const untouched = await Promise.race([dispatch("/pdf-frame.html", "navigate"), Promise.resolve("untouched")]);
    expect(untouched).toBe("untouched");
  });

  it("precaches this build's entry script and stylesheet once stamped", async () => {
    const index = INDEX.replace("</head>", '<script type="module" crossorigin src="/assets/index-CYdYva-W.js"></script><link rel="stylesheet" crossorigin href="/assets/index-BazsAu1K.css"></head>');
    const assets = shellAssets(index);
    expect(assets).toEqual(["/assets/index-CYdYva-W.js", "/assets/index-BazsAu1K.css"]);

    // The same substitution the build plugin performs.
    expect(SOURCE).toContain("__APP_BUILD__");
    expect(SOURCE).toContain("__APP_ASSETS__");
    const stamped = SOURCE.split("__APP_BUILD__").join("CYdYva-W").split("__APP_ASSETS__").join(assets.join(","));
    const { install, added } = boot({}, () => Promise.resolve(script), stamped);
    await install();
    expect(added).toEqual(expect.arrayContaining(["/", "/manifest.webmanifest", ...assets]));
  });

  it("precaches only the static shell while unstamped, as in dev", async () => {
    const { install, added } = boot({}, () => Promise.resolve(script));
    await install();
    expect(added).toEqual(["/", "/manifest.webmanifest", "/icons/icon.svg"]);
  });
});
