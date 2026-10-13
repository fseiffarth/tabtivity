/**
 * URLs a program printed across several terminal rows, and the sign-in links
 * among them.
 *
 * Agent CLIs cut a long URL into pane-wide rows with hard newlines (see
 * `urlContinuation`), so xterm's own link detection, which only follows rows
 * *it* wrapped, sees a truncated link. The login flows are where that hurts:
 * Antigravity's Google sign-in URL spans eight rows, and a click (or a copy)
 * handed Google a cut-off `redirect_uri` — "Error 400: redirect_uri_mismatch".
 */
import { urlContinuation, type LineLike } from "./terminalSelection";

/** A URL and the cells it covers: 0-based, `end` exclusive on its row. */
export interface WrappedUrl {
  url: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

const URL_START = /https?:\/\/[^\s"'<>`]+/gu;
// Sentence punctuation that ends a line of prose, not the URL before it.
const TRAILING_PUNCT = /[.,:;!?'")\]]+$/u;
/** The most rows one URL is followed across — a sign-in URL runs to ~10. */
const MAX_ROWS = 40;

/** The cell column where string index `index` of `line`'s text starts. Wide
 *  glyphs take two cells but one character, so the two drift apart. */
export function cellAt(line: LineLike, cols: number, index: number): number {
  let chars = 0;
  for (let x = 0; x < cols; x++) {
    if (chars >= index) return x;
    chars += line.getCell(x)?.getChars().length ?? 0;
  }
  return cols;
}

/**
 * Every URL that starts on a row in `[fromY, toY]`, followed across the rows
 * it was wrapped onto. Only URLs spanning more than one row are reported
 * unless `singleRow` is set — a one-row URL is already xterm's to handle.
 */
export function findWrappedUrls(
  getLine: (y: number) => LineLike | undefined,
  cols: number,
  fromY: number,
  toY: number,
  singleRow = false,
): WrappedUrl[] {
  const found: WrappedUrl[] = [];
  for (let y = Math.max(0, fromY); y <= toY; y++) {
    const line = getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    for (const m of text.matchAll(URL_START)) {
      let url = m[0];
      const startX = cellAt(line, cols, m.index);
      let endY = y;
      let endX = cellAt(line, cols, m.index + url.length);
      // Only a URL that runs to the end of its row can go on below.
      if (m.index + url.length === text.length) {
        let prev = line;
        for (let next = getLine(endY + 1); next && endY - y < MAX_ROWS; next = getLine(endY + 1)) {
          const piece = urlContinuation(prev, next, cols);
          if (piece === null) break;
          const nextText = next.translateToString(true);
          const at = nextText.indexOf(piece);
          url += piece;
          endY += 1;
          endX = cellAt(next, cols, at + piece.length);
          prev = next;
          if (at + piece.length !== nextText.length) break;
        }
      }
      const trimmed = url.replace(TRAILING_PUNCT, "");
      endX -= url.length - trimmed.length;
      if (endY === y && !singleRow) continue;
      found.push({ url: trimmed, start: { x: startX, y }, end: { x: endX, y: endY } });
    }
  }
  return found;
}

/** Query keys only a sign-in request carries on their own: an OAuth response
 *  type, a PKCE challenge, a device code (`verification_uri_complete` —
 *  Qwen's `/authorize?user_code=`), and Cursor's `loginDeepControl?challenge=`. */
const SIGN_IN_KEYS = ["response_type", "code_challenge", "user_code", "challenge"];
/** Device-login pages, which take their code on the page: GitHub's
 *  `/login/device`, Microsoft's `/devicelogin`, and the generic `/device` and
 *  `/activate` other providers use — as a whole path segment, so `/devices`
 *  or `/activated` are not. */
const DEVICE_PATH = /\/(?:login\/device|devicelogin|device|activate)(?:\/|$)/iu;

/**
 * Whether `url` is a page that signs the user in to a program — the one rule
 * the desktop's sign-in card (`findSignInRequest`) and the phone's sign-in
 * sheet (`mobile-web/src/terminal/signIn.ts`) both read a link by:
 *
 *  - an OAuth authorization request: a `client_id` with a redirect, a
 *    response type, a PKCE challenge or an `oauth`/`authorize` path (Google,
 *    Anthropic, OpenAI and GitHub all look like this). A `client_id` alone is
 *    not enough — the CLI's own `localhost` callback carries one too;
 *  - any URL with one of `SIGN_IN_KEYS`;
 *  - a device-login page (`DEVICE_PATH`).
 *
 * `http:` is accepted (a dev server's sign-in); the phone keeps its own
 * https-only rule on top.
 */
export function isSignInUrl(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const q = parsed.searchParams;
  if (SIGN_IN_KEYS.some((key) => q.has(key))) return true;
  if (q.has("client_id") && (q.has("redirect_uri") || /oauth|authorize/iu.test(parsed.pathname))) return true;
  return DEVICE_PATH.test(parsed.pathname);
}

/** A sign-in request on screen: the link, and whether the program then waits
 *  for the user to paste back the code the sign-in page shows. */
export interface SignInRequest {
  url: string;
  wantsCode: boolean;
}

/** Rows after the link read for a "paste the code" prompt. */
const CODE_PROMPT_ROWS = 12;
const CODE_PROMPT = /\b(paste|enter)\b.*\bcode\b|\bauthori[sz]ation code\b/iu;

/**
 * The last sign-in link on rows `[fromY, toY]`, or null. `wantsCode` is only
 * ever set for an OAuth link (a device login shows a code the user types *into
 * the browser*, never back into the terminal).
 */
export function findSignInRequest(
  getLine: (y: number) => LineLike | undefined,
  cols: number,
  fromY: number,
  toY: number,
): SignInRequest | null {
  const urls = findWrappedUrls(getLine, cols, fromY, toY, true).filter((u) => isSignInUrl(u.url));
  const last = urls[urls.length - 1];
  if (!last) return null;
  let after = "";
  for (let y = last.end.y + 1; y <= Math.min(toY, last.end.y + CODE_PROMPT_ROWS); y++) {
    after += " " + (getLine(y)?.translateToString(true) ?? "");
  }
  const oauth = new URL(last.url).searchParams.has("client_id");
  return { url: last.url, wantsCode: oauth && CODE_PROMPT.test(after) };
}
