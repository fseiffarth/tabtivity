/**
 * The app's name — the ONE frontend place it is spelled. Display text reads
 * `BRAND.display` (the i18n dictionaries through their `{app}` placeholder),
 * and every name the frontend persists or shares with the backend is built
 * here, so a rename edits this file and its Rust twin
 * `src-tauri/src/brand.rs`, nothing else. The phone PWA imports this module
 * too.
 *
 * Each such name comes as a pair: `NAMES.x`, built from the current brand,
 * and `LEGACY_NAMES.x`, built from the old one (the name the app had before
 * it was renamed). Code that *writes* a name uses `NAMES`; code
 * that must still *find* something an older build wrote uses `LEGACY_NAMES`.
 * `BrandMirror.test.ts` holds the names shared with the backend to
 * `brand.rs`.
 */
export const BRAND = {
  /** The name as shown to the user. */
  display: "Tabtivity",
  /** Lowercase form for file names, storage keys and protocol names. */
  slug: "tabtivity",
  /** Uppercase form, for markers and environment variables. */
  upper: "TABTIVITY",
  /** Prefix of the app's environment variables. */
  envPrefix: "TABTIVITY_",
} as const;

/** The old brand: what builds before the rename wrote. */
export const LEGACY_BRAND = {
  display: "Eldrun",
  slug: "eldrun",
  upper: "ELDRUN",
  envPrefix: "ELDRUN_",
} as const;

/** The domain of the UID a calendar row without one is exported under
 *  (`<row id>@<domain>`). Pinned for good, a literal that belongs to no brand:
 *  the UID is what an importer and a CalDAV server know the event by, so a
 *  different domain would make every such event a new one on the next export
 *  or push. */
export const PINNED_ICS_UID_DOMAIN = "eldrun";

interface BrandForms {
  readonly display: string;
  readonly slug: string;
  readonly upper: string;
  readonly envPrefix: string;
}

/** Every persisted or shared name, for one brand. */
function namesFor(b: BrandForms) {
  return {
    // ── Shared with the backend (same constant in brand.rs) ────────────────
    /** Leaf of the state dir (`~/.local/share/<this>`). */
    stateDirName: b.slug,
    /** Leaf of the tree in the user's home that holds projects and boxes. */
    homeDirName: b.slug,
    /** The app's own folder in a project. */
    projectDir: `.${b.slug}`,
    /** Where files sent from the phone land, relative to the project root. */
    inboxDir: `.${b.slug}/inbox`,
    /** Where files for the phone are staged, relative to the project root. */
    outboxDir: `.${b.slug}/outbox`,
    /** Linked worktrees, relative to the project root. */
    worktreesDir: `.${b.slug}/worktrees`,
    /** Screenshots folder in a project. */
    screenshotsDir: `${b.slug}-screenshots`,
    /** Saved-mail folder in a project. */
    emailsDir: `${b.slug}-emails`,
    /** File extension of an exported project bundle (no dot). */
    exportExtension: `${b.slug}proj`,
    /** Backups of branches a sync moved. */
    gitRefBackup: `refs/${b.slug}/backup`,
    /** Where each peer's branch tips are tracked. */
    gitRefPeer: `refs/${b.slug}/peer`,
    /** Where fetched-but-not-adopted refs wait. */
    gitRefIncoming: `refs/${b.slug}/incoming`,
    /** What every tmux session the app owns starts with. */
    tmuxPrefix: `${b.slug}-`,
    /** The CLI an agent runs to put a file in front of the user. */
    sendCli: `${b.slug}-send`,
    /** The help MCP server. */
    mcpHelpServer: `${b.slug}-help`,
    /** WebSocket subprotocol of a phone terminal. */
    terminalProtocol: `${b.slug}-terminal.v1`,
    /** Custom-protocol request header: the file to serve. */
    filePathHeader: `x-${b.slug}-path`,
    /** Custom-protocol request header: the project the file belongs to. */
    fileProjectHeader: `x-${b.slug}-project`,
    /** Event: a native file drag ended. */
    fileDragEndedEvent: `${b.slug}:file-drag-ended`,
    /** Event: the phone asked the desktop for something. */
    mobileDesktopEvent: `${b.slug}-mobile-desktop-request`,
    /** Error prefix: the project must be trusted before this runs. */
    trustRequiredPrefix: `${b.slug}-trust-required:`,
    /** Error sentinel: native printing is not available here. */
    nativePrintUnsupported: `${b.slug}-native-print-unsupported`,
    /** What every built-in view's saved tab command starts with. */
    tabCommandPrefix: `__${b.slug}_`,
    /** Id of the app's own row in the time log. */
    appTimerId: `__${b.slug}__`,
    /** The session hook script in `<state>/hooks` (POSIX). */
    sessionHookSh: `${b.slug}_session_start.sh`,

    // ── Frontend only ──────────────────────────────────────────────────────
    /** Prefix of the dotted localStorage keys (`<slug>.todo.collapsed`). */
    storagePrefix: `${b.slug}.`,
    /** Prefix of the dashed localStorage keys (`<slug>-theme`). */
    storageDashPrefix: `${b.slug}-`,
    /** Prefix of the colon localStorage keys (`<slug>:new-tab-slots`). */
    storageColonPrefix: `${b.slug}:`,
    /** IndexedDB database holding the phone's device key. */
    mobileAuthDb: `${b.slug}-mobile-auth`,
    /** IndexedDB database holding the phone's unsaved PDF markup. */
    mobileMarkupDb: `${b.slug}-mobile-markup`,
    /** Prefix of the phone service worker's cache names. */
    mobileShellCachePrefix: `${b.slug}-mobile-shell-`,
    /** Message the phone service worker posts to an open window when a
     *  notification is tapped. */
    mobileOpenMessage: `${b.slug}-open`,
    /** Prefix of the phone's notification tags. */
    mobileNotificationTagPrefix: `${b.slug}-`,
  };
}

/** The names this build writes and looks up first. */
export const NAMES = namesFor(BRAND);
/** The names older builds wrote. */
export const LEGACY_NAMES = namesFor(LEGACY_BRAND);

/** Settings key of the phone host's settings. A literal type, so it can key
 *  an interface: `{ [MOBILE_HOST_KEY]?: … }`. */
export const MOBILE_HOST_KEY = `${BRAND.slug}_mobile_host` as const;
export const LEGACY_MOBILE_HOST_KEY = `${LEGACY_BRAND.slug}_mobile_host` as const;
/** Project / box key that opens it to the phone. A literal type, as above. */
export const MOBILE_ACCESS_KEY = `${BRAND.slug}_mobile_access` as const;
export const LEGACY_MOBILE_ACCESS_KEY = `${LEGACY_BRAND.slug}_mobile_access` as const;
/** Project / box key listing the paired phones that may open it (absent: every phone). */
export const MOBILE_DEVICES_KEY = `${BRAND.slug}_mobile_devices` as const;

/** A dotted localStorage key: `storageKey("todo.collapsed")`. */
export function storageKey(name: string): string {
  return `${NAMES.storagePrefix}${name}`;
}

/** A dashed localStorage key: `storageDashKey("theme")`. */
export function storageDashKey(name: string): string {
  return `${NAMES.storageDashPrefix}${name}`;
}

/** A colon localStorage key: `storageColonKey("new-tab-slots")`. */
export function storageColonKey(name: string): string {
  return `${NAMES.storageColonPrefix}${name}`;
}

/** One of the app's environment variables: `envName("TAB_UID")`. */
export function envName(name: string): string {
  return `${BRAND.envPrefix}${name}`;
}

/** The command a saved tab of a built-in view carries: `tabCommand("mail")`. */
export function tabCommand(view: string): string {
  return `${NAMES.tabCommandPrefix}${view}__`;
}

const PLACEHOLDER = /\{(app|slug)\}/g;

/** Fill a dictionary's brand placeholders: `{app}` with the display name and
 *  `{slug}` with the lowercase form (paths and file names the text mentions).
 *  Done once where a dictionary is loaded, so `translate()` never has to
 *  know. */
export function fillBrand<T extends Record<string, string | undefined>>(
  dict: T,
): { [K in keyof T]: string } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    if (value === undefined) continue;
    out[key] =
      value.includes("{app}") || value.includes("{slug}")
        ? value.replace(PLACEHOLDER, (_, which: string) =>
            which === "app" ? BRAND.display : BRAND.slug,
          )
        : value;
  }
  return out as { [K in keyof T]: string };
}
