/**
 * Reads an agent CLI's browser sign-in off the live screen, so the phone can
 * finish it: `/login` in Claude Code, Copilot's device code, Codex's
 * "Sign in with ChatGPT", Gemini's and Qwen's `/auth`, Antigravity's and
 * Cursor's launch-time sign-in.
 *
 * Every one of them prints a URL and then waits in one of four ways, and the
 * way is read off the URL and the lines around it — nothing per CLI:
 *
 *   - `device`   the page asks for a short code the CLI printed
 *                (`ABCD-1234`); the CLI polls until it is entered there.
 *   - `code`     the page ends on a code to paste back into the session
 *                (Claude's `Paste code here if prompted >`, Gemini's
 *                "Enter the authorization code").
 *   - `callback` the page redirects to `http://localhost:<port>/…` — the
 *                CLI's own listener on the desktop. On the phone that
 *                redirect fails, and the address it failed on is what the
 *                desktop relays to the listener (`sign_in.rs`).
 *   - `wait`     none of those: the CLI polls its provider until the page
 *                says yes.
 *
 * A CLI that sends its page to the desktop's browser and prints no link
 * (Mistral Vibe) hands it over when asked to copy it: `readHiddenSignIn`
 * finds the key to ask with, `copiedSignIn` reads the OSC 52 copy that
 * answers.
 *
 * Only a URL that carries an OAuth or device-login marker counts — a link in
 * an answer is not a sign-in — and only near the bottom of the screen, where
 * the CLI is waiting. The marker rule is the desktop's (`isSignInUrl` in
 * `src/lib/terminal/terminalUrls.ts`), so a link the desktop's sign-in card
 * offers is one the phone offers too. Nothing here sends keystrokes.
 */

import { signInLaunch } from "../../../src/lib/agents/signInLaunch";
import { isSignInUrl, saysSignedIn } from "../../../src/lib/terminal/terminalUrls";

export type SignInFlow = "device" | "code" | "callback" | "wait";

export interface SignIn {
  /** The page to open, rejoined across the rows the session wrapped it on. */
  url: string;
  /** The page's host, for the button. */
  site: string;
  flow: SignInFlow;
  /** The code a device-login page asks for, as printed. */
  userCode?: string;
}

interface SignInLineLike { text: string }

/** How far up from the bottom the URL may sit. The CLI draws its prompt, a
 * spinner and a footer under it, and at phone width a long line wraps. */
const SEARCH_WINDOW = 40;
/** Characters a URL may contain (RFC 3986), without the closing bracket and
 * quote a sentence wraps it in. */
const URL_CHARS = /[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]/u;
const URL_START = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/u;
/** A row that is nothing but more of the URL. */
const URL_ROW = /^[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+$/u;
/** A device code as the CLIs print them: `ABCD-1234`, `WDJB-MJHT`. */
const USER_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/u;
/** The CLI saying the sign-in went through. A CLI that prints this under the
 * link leaves the link on screen; it no longer leads anywhere. */
const SIGNED_IN = /\b(?:signed|logged) in\b|\blogin successful\b|\bsuccessfully (?:signed|logged|authenticated)\b|\bauthenticat(?:ed|ion) (?:successfully|successful|complete)\b/iu;
/** The CLI asking for a code to be pasted back into the session. */
const PASTE_PROMPT = /\b(?:paste|enter)\b[^.\n]{0,30}\b(?:authori[sz]ation\s+)?code\b/iu;

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(bare);
}

/** Whether the address a redirect points at is the CLI's own listener. */
function redirectsHome(url: URL): boolean {
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return false;
  try {
    const target = new URL(redirect);
    return target.protocol === "http:" && isLoopback(target.hostname);
  } catch {
    return false;
  }
}

/** The URL starting on `rows[index]`, with the rows the session wrapped it
 * onto: a row it fills to its end is continued by the next rows that are
 * nothing but URL. A TUI wraps a long line itself, with hard breaks, so
 * xterm's own soft-wrap join does not see them. */
function urlAt(rows: string[], index: number): { url: string; end: number } | null {
  const match = URL_START.exec(rows[index]);
  if (!match) return null;
  let url = match[0];
  let end = index;
  let reachesEnd = rows[index].trimEnd().endsWith(match[0]);
  while (reachesEnd && end + 1 < rows.length) {
    const next = rows[end + 1].trim();
    // A box border or a gutter mark around the URL is the TUI's, not the URL's.
    const piece = next.replace(/^[│|]\s*/u, "").replace(/\s*[│|]$/u, "");
    if (!piece || !URL_ROW.test(piece)) break;
    url += piece;
    end += 1;
    reachesEnd = true;
  }
  // A sentence's full stop or a closing bracket is not part of the link.
  while (url.length > 0 && !URL_CHARS.test(url[url.length - 1])) url = url.slice(0, -1);
  url = url.replace(/[.,;:!?']+$/u, "");
  return { url, end };
}

/**
 * The sign-in the session is waiting on, or `null`. The newest sign-in URL in
 * the bottom window wins: a CLI that printed a first link and then a second
 * ("Browser didn't open? Use the url below") means the second.
 */
export function readSignIn(lines: readonly SignInLineLike[]): SignIn | null {
  const from = Math.max(0, lines.length - SEARCH_WINDOW);
  const rows = lines.slice(from).map((line) => line.text);
  let found: { url: URL; index: number; end: number } | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const hit = urlAt(rows, index);
    if (!hit) continue;
    const url = httpsUrl(hit.url);
    if (url && isSignInUrl(url)) found = { url, index, end: hit.end };
    index = hit.end;
  }
  if (!found) return null;
  const { url } = found;
  // A link the CLI's own page window cuts off is not the link: its query
  // ends where the window does (`readSignInPage` reads the rest).
  if (cutByPage(rows[found.end + 1])) return null;
  if (rows.slice(found.end + 1).some((row) => SIGNED_IN.test(row))) return null;
  // What the CLI printed around its link: the lines that introduce it, the
  // rest of its own line ("… and enter code ABCD-1234") and whatever it asks
  // under it — never the URL, whose query can hold anything.
  const around = rows.slice(Math.max(0, found.index - 3), found.index)
    .concat(rows[found.index].replace(URL_START, " "), rows.slice(found.end + 1))
    .join("\n");
  return signInFor(url, around);
}

/** The page of a vendor cloud session a cloud tab's CLI printed (`claude
 * --cloud "<task>"` prints `View: https://claude.ai/code/session_…` and
 * exits), or `null`. Any https link counts — the tab's own launch printed it —
 * and the newest one in the bottom window wins. */
export function readCloudLink(lines: readonly SignInLineLike[]): { url: string; site: string } | null {
  const from = Math.max(0, lines.length - SEARCH_WINDOW);
  const rows = lines.slice(from).map((line) => line.text);
  let found: URL | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const hit = urlAt(rows, index);
    if (!hit) continue;
    found = httpsUrl(hit.url) ?? found;
    index = hit.end;
  }
  return found ? { url: found.href, site: found.host } : null;
}

/** The `--teleport <session>` a cloud tab's CLI printed for taking its
 * session over (`Resume with: claude --teleport session_…`): the session id,
 * or `null`. The id is held to what may stand on a command line — the
 * desktop and the sidecar check it again. */
const TELEPORT_HINT = /--teleport\s+([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![A-Za-z0-9_-])/u;

export function readCloudSession(lines: readonly SignInLineLike[]): string | null {
  const from = Math.max(0, lines.length - SEARCH_WINDOW);
  for (let index = lines.length - 1; index >= from; index -= 1) {
    const hit = TELEPORT_HINT.exec(lines[index].text);
    if (hit) return hit[1];
  }
  return null;
}

/** The note under a page a CLI scrolls inside its own window, one line per
 * Shift+↓/↑: Antigravity's sign-in page in a pane too short for its link
 * (`(1–20 of 34 lines)` at 42×24). The rows straight above it are lines 1 to
 * 20 of the page; the link's `state=` and the paste prompt are further down. */
const PAGE_NOTE = /^\((\d{1,4})\s*[–-]\s*(\d{1,4}) of (\d{1,4}) lines\)$/u;
/** The longest page assembled; the cap only bounds a misread. */
const MAX_PAGE = 400;
const PAGE_DOWN = "\u001b[1;2B";
const PAGE_UP = "\u001b[1;2A";

interface PageWindow { first: number; last: number; total: number; rows: string[] }

function pageNote(text: string | undefined): { first: number; last: number; total: number } | null {
  const note = PAGE_NOTE.exec((text ?? "").trim());
  if (!note) return null;
  const [first, last, total] = note.slice(1).map(Number);
  if (first < 1 || last < first || total < last || total > MAX_PAGE) return null;
  return { first, last, total };
}

/** Whether the row under a link is a page note saying more lines follow. */
function cutByPage(below: string | undefined): boolean {
  const note = pageNote(below);
  return note !== null && note.last < note.total;
}

/** The lowest page window on screen: its note, and the rows it shows. */
function pageWindow(lines: readonly SignInLineLike[]): PageWindow | null {
  const rows = lines.slice(Math.max(0, lines.length - SEARCH_WINDOW)).map((line) => line.text);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const note = pageNote(rows[index]);
    if (!note) continue;
    const count = note.last - note.first + 1;
    return count <= index ? { ...note, rows: rows.slice(index - count, index) } : null;
  }
  return null;
}

/** A paged sign-in page as the frames have shown it so far. */
export interface SignInPage {
  /** The page's lines by number (index 0 is line 1); a hole is one no frame
   * has shown yet. */
  lines: (string | undefined)[];
  /** The lines the window on screen shows. */
  first: number;
  last: number;
}

/**
 * The paged sign-in page on screen, merged into what earlier frames showed of
 * it (`known`), or `null` once no page is on screen. A page is only started
 * where a sign-in link is cut by its window; a page whose lines disagree with
 * `known` is a new one (a retry printed a new link) and starts over.
 */
export function readSignInPage(lines: readonly SignInLineLike[], known: SignInPage | null): SignInPage | null {
  const view = pageWindow(lines);
  if (!view) return null;
  const continues = known !== null && known.lines.length === view.total
    && view.rows.every((row, at) => [undefined, row].includes(known.lines[view.first - 1 + at]));
  if (!continues) {
    const cut = view.rows.some((_, at) => {
      const hit = urlAt(view.rows, at);
      const url = hit && hit.end === view.rows.length - 1 ? httpsUrl(hit.url) : null;
      return url !== null && isSignInUrl(url);
    });
    if (!cut || view.last === view.total) return null;
  }
  const seen = continues ? known.lines : Array.from({ length: view.total }, (): string | undefined => undefined);
  const fresh = view.rows.some((_, at) => seen[view.first - 1 + at] === undefined);
  if (continues && !fresh && known.first === view.first && known.last === view.last) return known;
  const merged = [...seen];
  view.rows.forEach((row, at) => { merged[view.first - 1 + at] = row; });
  return { lines: merged, first: view.first, last: view.last };
}

/** The Shift+↓/↑ presses toward the page's unseen lines, at most a window's
 * height at once, so the next window still meets this one and no line is
 * skipped; none once every line has been seen. */
export function signInPageKeys(page: SignInPage): string[] {
  const hole = page.lines.findIndex((line) => line === undefined) + 1;
  if (hole === 0) return [];
  const size = page.last - page.first + 1;
  const [room, key] = hole < page.first ? [page.first - 1, PAGE_UP] : [page.lines.length - page.last, PAGE_DOWN];
  return Array.from({ length: Math.min(size, room) }, () => key);
}

/** The sign-in a paged page holds, once every line of it has been seen. */
export function readPagedSignIn(page: SignInPage): SignIn | null {
  if (page.lines.some((line) => line === undefined)) return null;
  return readSignIn(page.lines.map((text) => ({ text: text ?? "" })));
}

/** The flow a sign-in link is in, from the link and what the CLI printed
 * around it. */
function signInFor(url: URL, around: string): SignIn {
  const userCode = url.searchParams.get("user_code") ?? USER_CODE.exec(around)?.[1] ?? undefined;
  let flow: SignInFlow;
  if (userCode && !url.searchParams.has("redirect_uri")) flow = "device";
  else if (PASTE_PROMPT.test(around)) flow = "code";
  else if (redirectsHome(url)) flow = "callback";
  else if (url.searchParams.has("redirect_uri")) flow = "code";
  else flow = "wait";
  return { url: url.toString(), site: url.hostname, flow, ...(userCode ? { userCode } : {}) };
}

/** A CLI saying it sent the sign-in page to a browser — on the desktop, where
 * the fence's display reaches, not on the phone. */
const BROWSER_LAUNCH = /\bbrowser (?:should|will) open\b|\bbrowser (?:has been )?opened\b|\bopening (?:your |the )?browser\b/iu;
/** The CLI's own offer to hand that link over: Vibe's "If your browser did
 * not open, copy this URL (press c)". */
const REVEAL_HINT = /\b(?:copy|show|print)\b[^()]{0,30}\b(?:url|link)\b[^()]{0,10}\(press ([a-z])\)/iu;
/** The same key for a CLI whose hint a short screen clips away: a TUI that
 * lays out its sign-in page for a desktop window scrolls the bottom off a
 * phone-sized one. */
const REVEAL_KEYS: Record<string, string> = {
  vibe: "c",
};

/** A sign-in whose link went to the desktop's browser and is not on screen. */
export interface HiddenSignIn {
  /** The key that makes the CLI hand the link over — as a clipboard copy
   * (OSC 52, `osc52Text`), which reaches the phone even where the screen
   * is too short to show the link. */
  key: string;
}

/**
 * A CLI that opened its sign-in page on the desktop and prints no link, or
 * `null`. Mistral Vibe does this: it polls its provider, and shows the link
 * only once asked to copy it. Only a CLI that offers such a key counts — on
 * screen, or as `REVEAL_KEYS` knows it.
 */
export function readHiddenSignIn(lines: readonly SignInLineLike[], cli: string): HiddenSignIn | null {
  const rows = lines.slice(Math.max(0, lines.length - SEARCH_WINDOW)).map((line) => line.text);
  let launch = -1;
  rows.forEach((row, index) => { if (BROWSER_LAUNCH.test(row)) launch = index; });
  if (launch < 0) return null;
  const below = rows.slice(launch + 1);
  if (below.some((row) => SIGNED_IN.test(row))) return null;
  // The hint wraps like any sentence; read it as one.
  const hint = REVEAL_HINT.exec(below.map((row) => row.trim()).join(" "))?.[1];
  const key = hint ?? REVEAL_KEYS[cli];
  return key ? { key } : null;
}

/** The text an OSC 52 clipboard write carries (`c;<base64>`), or `null` for
 * a clipboard query or a payload that is not UTF-8 text. */
export function osc52Text(data: string): string | null {
  const payload = data.slice(data.indexOf(";") + 1);
  if (!data.includes(";") || !payload || payload === "?") return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The sign-in link a CLI copied when asked (`readHiddenSignIn`): one https
 * URL and nothing else. It needs no OAuth marker — the phone asked for this
 * copy, and takes only the one that answers it. */
export function copiedSignIn(copied: string): SignIn | null {
  const text = copied.trim();
  if (/\s/u.test(text)) return null;
  const url = httpsUrl(text);
  return url ? signInFor(url, "") : null;
}

/**
 * What the reader pasted back, told apart: the address a `localhost`
 * redirect failed on — which only the desktop can deliver — or anything else,
 * which the session reads as typed text. An address is accepted only in the
 * shape the desktop will take (`sign_in.rs`), so a refusal there is rare.
 */
export function pastedCallback(pasted: string): string | null {
  const text = pasted.trim();
  if (!/^http:\/\//iu.test(text)) return null;
  try {
    const url = new URL(text);
    if (!isLoopback(url.hostname) || !url.port) return null;
    return url.searchParams.get("state") && (url.searchParams.get("code") || url.searchParams.get("error")) ? text : null;
  } catch {
    return null;
  }
}

/** The slash command that starts a sign-in in each CLI's own session, where
 * its docs name one. A CLI missing here signs in when it starts (Antigravity,
 * Codex, Cursor) or has no command the phone is sure of; the screen reader
 * above still catches its link. */
const SIGN_IN_COMMANDS: Record<string, string> = {
  claude: "/login",
  copilot: "/login",
  gemini: "/auth",
  qwen: "/auth",
};

export function signInCommand(cli: string): string | null {
  return SIGN_IN_COMMANDS[cli] ?? null;
}

/** The command a phone CLI key (`slashCli`) runs as, where the two differ. */
const CLI_COMMANDS: Record<string, string> = { cursor: "cursor-agent", antigravity: "agy" };

/** Whether the desktop opens a sign-in tab of its own for this CLI: one that
 * runs its login command in the flow a phone can finish, and ends with it
 * (`src/lib/agents/signInLaunch.ts`). A CLI without one signs in as it starts,
 * or through its slash command in the session. */
export function hasSignInTab(cli: string): boolean {
  return signInLaunch(CLI_COMMANDS[cli] ?? cli).exits;
}

/** The CLI's other way in, when its sign-in tab has one. */
export function signInAlternate(cli: string): "console" | "browser" | undefined {
  return signInLaunch(CLI_COMMANDS[cli] ?? cli).alternate?.kind;
}

/** Whether the bottom of the screen says the sign-in went through. */
export function signInDone(lines: readonly SignInLineLike[]): boolean {
  return lines.slice(Math.max(0, lines.length - SEARCH_WINDOW))
    .some(({ text }) => saysSignedIn(text));
}

/** How far up a CLI's "you need to sign in" may sit: it is the last thing it
 * printed, under the prompt that failed or on its start screen. */
const SIGNED_OUT_WINDOW = 15;
/** What the CLIs print when a turn fails for want of a login, or when they
 * open on their own sign-in choice. */
const SIGNED_OUT = [
  /\bnot (?:signed|logged) in\b/iu,
  /\bplease run \/(?:login|auth)\b/iu,
  /\binvalid api key\b/iu,
  /\b(?:oauth |access |auth )?token (?:has )?expired\b/iu,
  /\bauthentication (?:is )?required\b/iu,
  // Antigravity 1.3.3, mid-session: "Authentication expired. Please log back in."
  /\bauthentication expired\b/iu,
  /\b(?:please|you need to|you must) (?:log ?in|sign ?in)\b/iu,
  /\bselect login method\b/iu,
  /\bhow would you like to authenticate\b/iu,
];

/** Whether the session at the bottom of the screen is asking for a sign-in:
 * the phone then offers one. Once the screen says it went through, it is not. */
export function readSignedOut(lines: readonly SignInLineLike[]): boolean {
  const rows = lines.slice(Math.max(0, lines.length - SIGNED_OUT_WINDOW));
  if (rows.some(({ text }) => saysSignedIn(text))) return false;
  return rows.some(({ text }) => SIGNED_OUT.some((pattern) => pattern.test(text)));
}
