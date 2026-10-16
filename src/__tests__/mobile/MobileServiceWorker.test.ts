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
import { BRAND, NAMES } from "../../lib/brand";
import { translate } from "../../lib/i18n";
import { TRANSLATIONS } from "../../lib/i18nDicts/all";
import {
  PUSH_LANG_CACHE,
  PUSH_LANG_URL,
  PUSH_TITLES_PLACEHOLDER,
  pushTitleTable,
  stampPushTitles,
} from "../../../mobile-web/src/pushTitles";

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
  const stored: string[] = [];
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
      put: (request: { url: string }) => { stored.push(request.url.slice(ORIGIN.length)); return Promise.resolve(); },
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
  return { dispatch, install, added, puts: () => stored.length, stored };
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

  it("keeps a newer build's start page out of its cache", async () => {
    // The phone still runs the previous build's worker when the desktop has
    // updated. The new start page names a script this cache does not hold;
    // stored over the old one, an offline open painted a black page with no
    // app to explain it (2026-10-11). It is served, never stored.
    const stamped = SOURCE.split("__APP_BUILD__").join("old").split("__APP_ASSETS__").join("/assets/index-old.js,/assets/index-old.css");
    const page = (entry: string) => new Response(`<script type="module" src="${entry}"></script>`, { headers: { "content-type": "text/html" } });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const newer = boot({}, () => Promise.resolve(page("/assets/index-new.js")), stamped);
    await expect(newer.dispatch("/", "navigate")).resolves.toBeInstanceOf(Response);
    await settle();
    expect(newer.stored).toEqual([]);

    const own = boot({}, () => Promise.resolve(page("/assets/index-old.js")), stamped);
    await own.dispatch("/", "navigate");
    await settle();
    expect(own.stored).toEqual(["/"]);
  });

  it("stores any start page while unstamped, as in dev", async () => {
    const { dispatch, stored } = boot({}, () => Promise.resolve(new Response("<!doctype html>", { headers: { "content-type": "text/html" } })));
    await dispatch("/", "navigate");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored).toEqual(["/"]);
  });

  it("precaches only the static shell while unstamped, as in dev", async () => {
    const { install, added } = boot({}, () => Promise.resolve(script));
    await install();
    expect(added).toEqual(["/", "/manifest.webmanifest", "/icons/icon.svg"]);
  });
});

describe(`${BRAND.display} Mobile push titles`, () => {
  /** Run the worker's push handler for `data`, with `pageLang` (or nothing)
   *  in the page's language cache and `browser` as the worker's navigator
   *  language; resolves with the title the notification was shown under. */
  function push(source: string, data: unknown, pageLang: string | null, browser = "en-US") {
    const listeners = new Map<string, (event: unknown) => void>();
    const prefs = new Map<string, Response>();
    if (pageLang !== null) prefs.set(PUSH_LANG_URL, new Response(pageLang));
    const deleted: string[] = [];
    const shown: string[] = [];
    const self = {
      location: { origin: ORIGIN },
      navigator: { language: browser },
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
      skipWaiting: () => undefined,
      clients: { claim: () => Promise.resolve() },
      registration: { showNotification: (title: string) => { shown.push(title); return Promise.resolve(); } },
    };
    const caches = {
      open: (name: string) => Promise.resolve({
        match: (url: string) => Promise.resolve(name === PUSH_LANG_CACHE ? prefs.get(url) : undefined),
      }),
      keys: () => Promise.resolve([`${NAMES.mobileShellCachePrefix}old`, PUSH_LANG_CACHE]),
      delete: (key: string) => { deleted.push(key); return Promise.resolve(true); },
    };
    new Function("self", "caches", "fetch", "URL", "setTimeout", source)(self, caches, () => Promise.reject(new Error("offline")), URL, setTimeout);
    const title = new Promise<string>((resolve, reject) => {
      listeners.get("push")!({
        data: { json: () => data },
        waitUntil: (work: Promise<unknown>) => void work.then(() => resolve(shown[0]), reject),
      });
    });
    const activate = new Promise<string[]>((resolve) => {
      listeners.get("activate")!({ waitUntil: (work: Promise<unknown>) => void work.then(() => resolve(deleted)) });
    });
    return { title, activate };
  }

  const stamped = stampPushTitles(SOURCE, pushTitleTable(TRANSLATIONS));
  const question = { kind: "agent", status: "question" };

  it("titles a bare push in the page's language", async () => {
    await expect(push(stamped, question, "de").title).resolves.toBe(translate("de", "mobile.push.titleAgentQuestion"));
    await expect(push(stamped, { kind: "agent", status: "done" }, "it").title).resolves.toBe(translate("it", "mobile.push.titleAgentDone"));
    await expect(push(stamped, { kind: "calendar" }, "es").title).resolves.toBe(translate("es", "mobile.push.titleCalendar"));
    expect(translate("de", "mobile.push.titleAgentQuestion")).not.toBe(translate("en", "mobile.push.titleAgentQuestion"));
  });

  it("falls back to the browser's language, then English", async () => {
    await expect(push(stamped, question, null, "fr-CA").title).resolves.toBe(translate("fr", "mobile.push.titleAgentQuestion"));
    await expect(push(stamped, question, null, "nl-NL").title).resolves.toBe(translate("en", "mobile.push.titleAgentQuestion"));
    await expect(push(stamped, question, "xx", "nl-NL").title).resolves.toBe(translate("en", "mobile.push.titleAgentQuestion"));
  });

  it("still shows English unstamped, as in dev", async () => {
    await expect(push(SOURCE, question, "de").title).resolves.toBe(translate("en", "mobile.push.titleAgentQuestion"));
    await expect(push(SOURCE, { kind: "calendar" }, null).title).resolves.toBe(translate("en", "mobile.push.titleCalendar"));
  });

  it("keeps a title the desktop sent", async () => {
    await expect(push(stamped, { ...question, title: "Aurora · Claude" }, "de").title).resolves.toBe("Aurora · Claude");
  });

  it("spares the page's language cache when it purges old shells", async () => {
    await expect(push(stamped, question, null).activate).resolves.toEqual([`${NAMES.mobileShellCachePrefix}old`]);
  });

  it("refuses to stamp a worker without the placeholder", () => {
    expect(() => stampPushTitles("const x = 1;", pushTitleTable(TRANSLATIONS))).toThrow(PUSH_TITLES_PLACEHOLDER);
  });
});
