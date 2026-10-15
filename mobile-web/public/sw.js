/* global self, caches, fetch, URL, URLSearchParams, setTimeout */
/* The cache name carries THIS build's entry hash, stamped into the emitted
 * copy by `stampServiceWorker` in vite.mobile.config.ts.
 *
 * It used to be a hand-bumped constant, which is the same thing as never
 * bumping it: `public/` files are copied verbatim, so vite never fingerprints
 * this one, the browser saw byte-identical `sw.js` across every release and
 * never installed a new worker, and `activate` — which only drops caches under
 * a *different* name — never purged anything. The cache accumulated every
 * bundle ever served, and the offline fallback below could still boot a
 * months-old shell out of it long after the desktop had upgraded. */
const CACHE = "tabtivity-mobile-shell-__APP_BUILD__";
/* The page's language, kept by the page (`pushTitles.ts`) in a cache of its
 * own — which is why `activate` below spares it. */
const PREFS = "tabtivity-mobile-prefs";
const PREFS_LANG = "/__push-lang";
/* A stalled connection — the common mobile-data failure — is not a network
 * *error*, so a plain `.catch()` fallback left the user on a white screen for
 * the browser's full timeout with the cached shell sitting right there. */
const NETWORK_TIMEOUT = 3000;
/* This build's hashed entry script and stylesheet, stamped in by the same
 * plugin. Precaching them is what lets the shell boot offline after the very
 * first visit: on that visit the page's own asset requests are issued before
 * the worker controls it, so nothing else ever put them in the cache, and an
 * offline reopen served the cached index.html pointing at scripts it did not
 * have — the exact white screen the "phone is offline" splash exists to
 * replace. */
/* Only stamped paths count: in dev (`mobile:dev` serves `public/` verbatim)
 * the placeholder is still here, and precaching *it* would fail the install. */
const ASSETS = "__APP_ASSETS__".split(",").filter((asset) => asset.startsWith("/assets/"));
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"].concat(ASSETS);
/* The script the cached start page must name. A start page from a newer build
 * names that build's script, which this cache does not hold until a newer
 * worker installs: storing it over our own left a shell pointing at nothing,
 * and when the tunnel died before that script arrived, every later open
 * painted a black page with no app to say why (2026-10-11). Kept out, the
 * offline open boots this worker's own build, which shows the tunnel steps. */
const ENTRY = ASSETS.find((asset) => asset.endsWith(".js"));
/* Take over on the next navigation rather than waiting for every client to
 * close. A phone PWA is rarely "closed", so waiting is what kept a superseded
 * worker — and the stale cache it answers from — alive for days. Dropping the
 * old cache out from under a running page is safe here because the build emits
 * one bundle under immutable hashed URLs: a page already open holds its JS in
 * memory. The one lazy chunk is a non-English dictionary (the Language picker),
 * fetched and cached like any asset; a stale page whose chunk is gone stays in
 * English until it reloads. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== PREFS).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
  /* The markup view's sealed pdf.js frame comes from the network only: its
   * own framing policy rides on the answer, and the shell stand-in below must
   * never land in a sandboxed frame. */
  if (url.pathname === "/pdf-frame.html") return;
  if (event.request.method !== "GET") return;
  const isAsset = url.pathname.startsWith("/assets/");
  /* The index.html stand-in is for *navigations* only. It used to answer any
   * miss, so an asset the cache did not hold — the new build's script, one
   * network hiccup after the worker had purged the old cache — came back as an
   * HTML document under a `.js` URL, and the page died on "Unexpected token <"
   * instead of the browser's own retry. */
  const navigation = event.request.mode === "navigate";
  const cached = () => caches.match(event.request).then((hit) => hit || (navigation ? caches.match("/") : undefined));
  const network = () => fetch(event.request).then((response) => {
    /* Never store a document under an asset URL. The host's SPA fallback used
     * to answer a missing /assets/* with index.html and a one-year immutable
     * header, which this cache then served as JavaScript for a year. */
    const type = response.headers.get("content-type") || "";
    const isDocument = type.includes("text/html");
    const cacheable = response.ok && (SHELL.includes(url.pathname) || (isAsset && !isDocument));
    if (cacheable) {
      const copy = response.clone();
      const store = () => caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      if (url.pathname === "/" && ENTRY) response.clone().text().then((page) => page.includes(ENTRY) && store());
      else store();
    }
    /* A navigation the proxy answered *for* the sidecar is a miss, not a page:
     * with the desktop closed, Tailscale Serve answers 502 with its own error
     * page, and the phone rendered that instead of the app. The cached shell
     * boots and then says, in the app's own words, that Tabtivity Mobile isn't
     * running on the desktop (`connection.ts`, `host_down`). The proxy's body
     * is never stored — `cacheable` above already needs `ok`. */
    if (navigation && (!response.ok || !isDocument)) {
      return cached().then((hit) => hit || response);
    }
    return response;
  });
  /* Hashed build output is immutable — the host serves it with a one-year
   * `immutable` header — so a cache hit is the whole answer, and racing the
   * network for it only made every boot on a slow link wait out the timeout
   * above for bytes the phone already had. */
  if (isAsset) {
    event.respondWith(caches.match(event.request).then((hit) => hit || network()));
    return;
  }
  const attempt = network();
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(cached().then((hit) => hit || attempt)), NETWORK_TIMEOUT);
  });
  event.respondWith(Promise.race([attempt, timeout]).catch(cached));
});
/* Notices pushed by the desktop (`mobile_control::push`): calendar reminders
 * and agent turns. The payload was encrypted to this browser; the push service
 * saw ciphertext only. Every push must show a notification — iOS revokes the
 * subscription of a worker that swallows one — so a malformed payload still
 * shows the generic line. A phone that chose "no details" gets no title: the
 * line below is all it shows. Project and tab are the phone's own opaque ids. */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,512}$/;
/* The fallback titles in every language, stamped from the i18n dictionaries by
 * the build (`stampServiceWorker`, `pushTitles.ts`): this file cannot import
 * them. Unstamped (dev) the table is empty and English below stands in. */
function readTitles(stamped) {
  try {
    const table = JSON.parse(stamped);
    return table && typeof table === "object" ? table : {};
  } catch {
    return {};
  }
}
const PUSH_TITLES = readTitles("__APP_PUSH_TITLES__");
const ENGLISH_TITLES = { agentDone: "An agent finished its turn", agentQuestion: "An agent needs your answer", calendar: "Calendar reminder" };
/* The page's language as it last wrote it; "" when it never did. */
function pageLanguage() {
  return caches
    .open(PREFS)
    .then((cache) => cache.match(PREFS_LANG))
    .then((hit) => (hit ? hit.text() : ""))
    .catch(() => "");
}
/* The page's language, else the browser's, else English. */
function fallbackTitle(data, lang) {
  const slot = data.kind === "agent" ? (data.status === "done" ? "agentDone" : "agentQuestion") : "calendar";
  const browser = String((self.navigator && self.navigator.language) || "").toLowerCase().split("-")[0];
  for (const code of [lang, browser, "en"]) {
    const row = PUSH_TITLES[code];
    if (row && typeof row[slot] === "string" && row[slot]) return row[slot];
  }
  return ENGLISH_TITLES[slot];
}
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== "object") data = {};
  const title = typeof data.title === "string" && data.title
    ? Promise.resolve(data.title)
    : pageLanguage().then((lang) => fallbackTitle(data, lang));
  const body = typeof data.body === "string" ? data.body : "";
  const tag = typeof data.tag === "string" && OPAQUE_ID.test(data.tag) ? `tabtivity-${data.tag}` : undefined;
  const target = data.kind === "agent" && OPAQUE_ID.test(String(data.project)) && OPAQUE_ID.test(String(data.tab))
    ? { section: "projects", projectId: data.project, tabId: data.tab }
    : { section: data.kind === "agent" ? "projects" : "calendar" };
  event.waitUntil(title.then((text) => self.registration.showNotification(text, {
    body,
    tag,
    // A question replacing an older notice for the same tab must still ring.
    renotify: tag !== undefined,
    icon: "/icons/icon-192.png",
    data: target,
  })));
});
/* A tap opens where the notice points — the Calendar, or the agent's tab: an
 * open window is focused and told where to go; otherwise a fresh one starts
 * there. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const place = event.notification.data || {};
  const section = place.section === "projects" ? "projects" : "calendar";
  const params = new URLSearchParams({ open: section });
  if (typeof place.projectId === "string" && OPAQUE_ID.test(place.projectId)) params.set("project", place.projectId);
  if (params.has("project") && typeof place.tabId === "string" && OPAQUE_ID.test(place.tabId)) params.set("tab", place.tabId);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        client.postMessage({ type: "tabtivity-open", section, projectId: params.get("project") || undefined, tabId: params.get("tab") || undefined });
        return client.focus();
      }
      return self.clients.openWindow(`/?${params.toString()}`);
    }),
  );
});
