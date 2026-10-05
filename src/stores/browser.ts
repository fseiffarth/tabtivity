import { create } from "zustand";
import {
  browserCapabilities,
  browserCheckUrl,
  browserCloseLive,
  browserClearData,
  browserDownloadDecide,
  browserListLive,
  browserOpenLive,
  browserReaderFetch,
} from "../lib/browser";
import type {
  BlockedNavigation,
  BrowserCapabilities,
  DownloadRequest,
  LiveWindowRef,
  LiveWindowState,
  ReaderPage,
} from "../types/browser";

/**
 * The in-app browser's store (TODO group J #61).
 *
 * Per-tab reader state plus a small amount of machine-global state (what this
 * build can do, which live windows exist, and the one download awaiting a
 * decision). Modeled on `stores/mail.ts`, and it inherits that store's three
 * rules, which matter more here than they did there:
 *
 *  1. **Nothing here reaches the network on its own.** Mounting a pane — the
 *     mount a *restored* tab performs at launch included — loads capabilities
 *     and nothing else. A restored tab shows its resume card; the only paths to
 *     an outbound request are `load` (a click or an Enter) and `openLive` (a
 *     click). Restoring six tabs must not be six automatic requests to whatever
 *     the user last had open, before they have looked at the screen.
 *  2. **Every action tolerates a rejected invoke.** The backend can be missing
 *     entirely (it lands in parallel with this file), the URL can be refused by
 *     policy, the host can be unreachable for a whole timeout — so a failure
 *     lands in the tab's `error` and clears `loading`, never as an unhandled
 *     rejection that leaves a pane spinning.
 *  3. **A download is refused by default.** `download` holds the one request
 *     awaiting a decision; nothing is written until {@link BrowserStore.decideDownload}
 *     is called with `accept: true`, and even then the *backend* raises the OS
 *     save dialog and the frontend never learns or names a path.
 *
 * There is deliberately **no** view-suppression refcount and **no** live-view
 * LRU here. Plan A specified both for a native child webview composited over the
 * pane; Plan C proved that view cannot exist on Linux, so the reader pane is
 * ordinary DOM and needs neither.
 */

/**
 * The gate's **third** outcome, parked until the user answers it.
 *
 * `browser_check_url` returns three states in two fields: `allowed: false` is a
 * refusal, and `allowed: true` *with* a `reason` means "reachable, but this is a
 * loopback / private / link-local / internal-name address and you should be told
 * before it is opened". Treating that second case as a plain allow is how a page
 * on your own machine — or, through a VPN tunnel Tabtivity is holding, on a network
 * your real browser cannot see — gets fetched with nobody deciding to.
 *
 * So it is parked here and rendered as a question with a real button. The
 * consent is a **user gesture**, it is scoped to one tab, it is remembered only
 * for that tab's session (see {@link BrowserTabState.approved}), and nothing —
 * no page, no redirect, no setting — can answer it.
 */
export interface PendingConfirm {
  url: string;
  display_url: string;
  /** The backend's token (`loopback`, `private-network`, …), turned into words
   *  by `lib/browser`'s `reasonPhrase` at render time. */
  reason: string;
  /** Which action the answer releases: the reader fetch, or the live window. */
  mode: "reader" | "live";
}

/** `host[:port]`, lowercased — the unit a confirmation is granted for. A
 *  different port on the same machine is a different service, so it asks
 *  again. Returns `""` for anything unparseable, which never matches. */
export function originKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** One browser tab's state, keyed by the tab's store key. */
export interface BrowserTabState {
  /** The committed URL — the last address that actually loaded, or the one a
   *  restored tab is waiting to load. Never the in-flight address-bar text. */
  url: string;
  page: ReaderPage | null;
  loading: boolean;
  error: string | null;
  /** The last navigation the policy refused, shown as a page state. */
  blocked: BlockedNavigation | null;
  /** A navigation the policy allows but wants confirmed first (see
   *  {@link PendingConfirm}). Mutually exclusive with `blocked`. */
  confirm: PendingConfirm | null;
  /**
   * Origins (`host[:port]`) the user has confirmed **for this tab, this
   * session**. In memory only, dropped with the tab: a grant that outlives the
   * thing it was given for is the shape of every "trusted sites" list, which
   * `docs/browser_plan_b.md` §10 refuses outright.
   */
  approved: string[];
  /**
   * True until this tab has loaded once. A restored tab starts here and shows
   * the resume card: nothing about a window being reopened is consent to dial
   * out (the rule `MAIL_TAB_CMD` states, applied to a browser).
   */
  needsResume: boolean;
  /** Whether this tab may offer the "Open live page" control at all. False for
   *  a URL that arrived from untrusted content (see `lib/linkTarget`). */
  allowLive: boolean;
}

function freshTab(url: string, allowLive: boolean): BrowserTabState {
  return {
    url,
    page: null,
    loading: false,
    error: null,
    blocked: null,
    confirm: null,
    approved: [],
    needsResume: !!url,
    allowLive,
  };
}

interface BrowserStore {
  byTab: Record<string, BrowserTabState>;
  capabilities: BrowserCapabilities | null;
  capabilitiesLoaded: boolean;
  live: LiveWindowRef[];
  /** Live windows' last reported state, keyed by window label. */
  liveState: Record<string, LiveWindowState>;
  /** The one download awaiting a decision. Refused by default until answered. */
  download: DownloadRequest | null;
  /** The outcome note of the last decided download, for a one-line strip. */
  downloadNote: string | null;
  /**
   * A live-page window's refused navigation, keyed by its window label.
   *
   * Kept apart from any tab's state on purpose. Every `browser:blocked` event
   * comes from a live window, which is a *separate OS window* with its own
   * address; folding it into a reader tab's `blocked` would replace whatever
   * page that tab was showing with a refusal it had nothing to do with. The
   * reader's own refusals never travel as events — they are `browser_check_url`'s
   * return value, handled inline in {@link BrowserStore.load}.
   */
  liveBlocked: Record<string, BlockedNavigation>;
  /**
   * The tab that most recently asked for a navigation.
   *
   * The fallback for a `browser:blocked` that names **no** window. No emitter
   * produces one today (the backend attaches `window_label` at both sites, and
   * `commands::browser`'s `every_blocked_event_names_its_window` keeps that
   * true), so this is a defence against a future emitter rather than the normal
   * path — but if one appears, attributing it to the tab that last asked for a
   * load is the only honest reading available.
   */
  lastActiveKey: string | null;

  /** Register a tab (idempotent). Does not load anything. */
  ensureTab: (key: string, url: string, allowLive: boolean) => void;
  dropTab: (key: string) => void;
  setAllowLive: (key: string, allowLive: boolean) => void;

  /** Read what this build can do. Safe to call repeatedly and on every mount. */
  loadCapabilities: (force?: boolean) => Promise<void>;

  /**
   * THE network action. Checks the URL with the backend policy first, then
   * fetches and sanitizes. Never called from a launch, restore or render path.
   *
   * A URL the gate merely *wants confirmed* (a loopback or private address)
   * stops here as a {@link PendingConfirm}: no request is made until
   * {@link BrowserStore.acceptConfirm} runs off a user gesture.
   */
  load: (key: string, url: string) => Promise<void>;
  /** Clear a tab's page, error, block and pending confirmation without touching
   *  its committed URL. */
  clearError: (key: string) => void;

  /** Answer the parked confirmation with **yes**, and release the action it was
   *  holding. Only ever called from a click. */
  acceptConfirm: (key: string) => Promise<void>;
  /** Answer it with **no**: nothing is requested and nothing is remembered. */
  cancelConfirm: (key: string) => void;

  /**
   * Ask for a live window, going through the same gate a reader load does — so
   * a private address is confirmed once per tab whichever surface asks for it,
   * rather than the live path being the way around the question.
   *
   * Resolves to an error string the caller should show, or `null`.
   */
  requestLive: (key: string, url: string) => Promise<string | null>;
  /** Open a separate hardened live window. Prefer {@link BrowserStore.requestLive},
   *  which gates it; this is the unconditional verb underneath. Resolves to an
   *  error string when the backend refused, else `null`. */
  openLive: (url: string) => Promise<string | null>;
  closeLive: (label: string) => Promise<void>;
  refreshLive: () => Promise<void>;
  applyLiveState: (state: LiveWindowState) => void;
  applyLiveClosed: (label: string) => void;

  /**
   * Adopt a `browser:blocked` event, routing it by where it came from: a
   * payload naming a `window_label` belongs to that **live window** and never to
   * a tab; one naming none falls back to {@link BrowserStore.lastActiveKey}.
   */
  applyBlocked: (blocked: BlockedNavigation) => void;
  /** Dismiss a live window's refusal notice. */
  dismissLiveBlocked: (label: string) => void;
  applyDownloadRequest: (request: DownloadRequest) => void;
  decideDownload: (accept: boolean) => Promise<void>;
  setDownloadNote: (note: string | null) => void;

  clearData: () => Promise<void>;
}

/** A rejected invoke's message, as a string the UI can show. */
function reason(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  byTab: {},
  capabilities: null,
  capabilitiesLoaded: false,
  live: [],
  liveState: {},
  download: null,
  downloadNote: null,
  liveBlocked: {},
  lastActiveKey: null,

  ensureTab: (key, url, allowLive) =>
    set((s) => (s.byTab[key] ? {} : { byTab: { ...s.byTab, [key]: freshTab(url, allowLive) } })),

  dropTab: (key) =>
    set((s) => {
      if (!s.byTab[key]) return {};
      const next = { ...s.byTab };
      delete next[key];
      return { byTab: next };
    }),

  setAllowLive: (key, allowLive) =>
    set((s) => {
      const tab = s.byTab[key];
      if (!tab || tab.allowLive === allowLive) return {};
      return { byTab: { ...s.byTab, [key]: { ...tab, allowLive } } };
    }),

  loadCapabilities: async (force = false) => {
    if (get().capabilitiesLoaded && !force) return;
    // `browserCapabilities` resolves rather than rejects when the command is
    // missing, so a frontend built ahead of its backend still lands in a
    // definite "nothing is supported" state instead of never loading.
    const capabilities = await browserCapabilities();
    set({ capabilities, capabilitiesLoaded: true });
  },

  load: async (key, url) => {
    const existing = get().byTab[key];
    set((s) => ({
      lastActiveKey: key,
      byTab: {
        ...s.byTab,
        [key]: {
          ...(s.byTab[key] ?? freshTab(url, existing?.allowLive ?? false)),
          url,
          loading: true,
          error: null,
          blocked: null,
          confirm: null,
          needsResume: false,
        },
      },
    }));

    const finish = (patch: Partial<BrowserTabState>) =>
      set((s) => {
        const tab = s.byTab[key];
        // A slower answer for a URL the tab has already navigated away from must
        // not overwrite what is now on screen.
        if (!tab || tab.url !== url) return {};
        return { byTab: { ...s.byTab, [key]: { ...tab, loading: false, ...patch } } };
      });

    // The policy gate runs in the backend, before anything is fetched. Asking
    // first costs one cheap round trip and means a refused URL never becomes a
    // request at all.
    const verdict = await browserCheckUrl(url).catch((err) => ({ error: reason(err) }) as const);
    if ("error" in verdict) {
      finish({ error: verdict.error });
      return;
    }
    if (!verdict.allowed) {
      finish({
        blocked: { display_url: verdict.display_url, reason: verdict.reason ?? "" },
      });
      return;
    }
    // The gate's third outcome: reachable, but say so first. Nothing is
    // requested — the fetch below is only reached once a click answers this.
    if (verdict.reason && !get().byTab[key]?.approved.includes(originKey(url))) {
      finish({
        confirm: {
          url,
          display_url: verdict.display_url,
          reason: verdict.reason,
          mode: "reader",
        },
      });
      return;
    }

    const page = await browserReaderFetch(url).catch((err) => ({ error: reason(err) }) as const);
    if ("error" in page) {
      finish({ error: page.error });
      return;
    }
    finish({ page });
  },

  clearError: (key) =>
    set((s) => {
      const tab = s.byTab[key];
      if (!tab) return {};
      return {
        byTab: { ...s.byTab, [key]: { ...tab, error: null, blocked: null, confirm: null } },
      };
    }),

  acceptConfirm: async (key) => {
    const pending = get().byTab[key]?.confirm;
    if (!pending) return;
    // Remember the answer for this tab only, so a dev server is not re-asked on
    // every reload — and forget it with the tab, because a grant that outlives
    // what it was given for is a trusted-sites list by another name.
    set((s) => {
      const tab = s.byTab[key];
      if (!tab) return {};
      const origin = originKey(pending.url);
      return {
        byTab: {
          ...s.byTab,
          [key]: {
            ...tab,
            confirm: null,
            approved:
              origin && !tab.approved.includes(origin)
                ? [...tab.approved, origin]
                : tab.approved,
          },
        },
      };
    });
    if (pending.mode === "live") {
      const err = await get().openLive(pending.url);
      if (err) {
        set((s) => {
          const tab = s.byTab[key];
          return tab ? { byTab: { ...s.byTab, [key]: { ...tab, error: err } } } : {};
        });
      }
      return;
    }
    await get().load(key, pending.url);
  },

  cancelConfirm: (key) =>
    set((s) => {
      const tab = s.byTab[key];
      if (!tab?.confirm) return {};
      return { byTab: { ...s.byTab, [key]: { ...tab, confirm: null } } };
    }),

  requestLive: async (key, url) => {
    if (!url) return null;
    set({ lastActiveKey: key });
    const verdict = await browserCheckUrl(url).catch((err) => ({ error: reason(err) }) as const);
    if ("error" in verdict) return verdict.error;
    if (!verdict.allowed) {
      set((s) => {
        const tab = s.byTab[key];
        if (!tab) return {};
        return {
          byTab: {
            ...s.byTab,
            [key]: {
              ...tab,
              blocked: { display_url: verdict.display_url, reason: verdict.reason ?? "" },
            },
          },
        };
      });
      return null;
    }
    // Same question, same answer, whichever surface asked — otherwise "Open live
    // page" would be the way around the confirmation the reader path enforces.
    if (verdict.reason && !get().byTab[key]?.approved.includes(originKey(url))) {
      set((s) => {
        const tab = s.byTab[key];
        if (!tab) return {};
        return {
          byTab: {
            ...s.byTab,
            [key]: {
              ...tab,
              confirm: {
                url,
                display_url: verdict.display_url,
                reason: verdict.reason ?? "",
                mode: "live",
              },
            },
          },
        };
      });
      return null;
    }
    return get().openLive(url);
  },

  /**
   * Spawn the separate hardened live window. Returns the failure as a string
   * rather than throwing: the caller is a click handler, and the pane that asked
   * is the surface that should carry the message.
   */
  openLive: async (url) => {
    const ref = await browserOpenLive(url).catch((err) => ({ error: reason(err) }) as const);
    if ("error" in ref) return ref.error;
    set((s) => ({
      live: s.live.some((w) => w.label === ref.label) ? s.live : [...s.live, ref],
    }));
    return null;
  },

  closeLive: async (label) => {
    await browserCloseLive(label).catch(() => {});
    get().applyLiveClosed(label);
  },

  refreshLive: async () => {
    const live = await browserListLive().catch(() => null);
    if (live) set({ live });
  },

  applyLiveState: (state) =>
    set((s) => ({
      liveState: { ...s.liveState, [state.label]: state },
      live: s.live.some((w) => w.label === state.label)
        ? s.live.map((w) =>
            w.label === state.label ? { ...w, display_url: state.display_url } : w,
          )
        : [...s.live, { label: state.label, display_url: state.display_url }],
    })),

  applyLiveClosed: (label) =>
    set((s) => {
      const liveState = { ...s.liveState };
      delete liveState[label];
      const liveBlocked = { ...s.liveBlocked };
      delete liveBlocked[label];
      return { live: s.live.filter((w) => w.label !== label), liveState, liveBlocked };
    }),

  applyBlocked: (blocked) =>
    set((s) => {
      // A live window's refusal belongs to that window. Folding it into a reader
      // tab would replace a page that tab loaded successfully with a block it
      // had no part in — which is worse than saying nothing.
      if (blocked.window_label) {
        return { liveBlocked: { ...s.liveBlocked, [blocked.window_label]: blocked } };
      }
      const target = s.lastActiveKey;
      if (!target || !s.byTab[target]) return {};
      return {
        byTab: {
          ...s.byTab,
          [target]: { ...s.byTab[target], blocked, loading: false },
        },
      };
    }),

  dismissLiveBlocked: (label) =>
    set((s) => {
      if (!s.liveBlocked[label]) return {};
      const next = { ...s.liveBlocked };
      delete next[label];
      return { liveBlocked: next };
    }),

  // A second request while one is pending does not silently replace it — the
  // first is still quarantined in the backend and still needs an answer, so the
  // newcomer waits rather than being lost.
  applyDownloadRequest: (request) =>
    set((s) => (s.download ? {} : { download: request, downloadNote: null })),

  decideDownload: async (accept) => {
    const request = get().download;
    if (!request) return;
    set({ download: null });
    const outcome = await browserDownloadDecide(request.download_id, accept).catch(
      (err) => ({ error: reason(err) }) as const,
    );
    if ("error" in outcome) {
      set({ downloadNote: outcome.error });
      return;
    }
    // A rejection must never be handed on as if it were a saved file: the pane
    // reports what the backend actually did, and a cancelled dialog wrote
    // nothing at all.
    set({
      downloadNote: outcome.saved ? (outcome.file_name ?? "") : null,
    });
  },

  setDownloadNote: (note) => set({ downloadNote: note }),

  clearData: async () => {
    await browserClearData().catch(() => {});
    set({ live: [], liveState: {}, liveBlocked: {}, download: null, downloadNote: null });
  },
}));

/** The state a pane renders for a tab that has not registered yet (the render
 *  that races `ensureTab`'s effect). Never a live object — a shared constant
 *  keeps the selector's reference stable. */
export const EMPTY_BROWSER_TAB: BrowserTabState = Object.freeze({
  url: "",
  page: null,
  loading: false,
  error: null,
  blocked: null,
  confirm: null,
  approved: Object.freeze([]) as unknown as string[],
  needsResume: false,
  allowLive: false,
});
