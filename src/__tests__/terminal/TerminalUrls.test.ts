import { describe, expect, it } from "vitest";
import { joinedSelectionText, rowJoin, type LineLike } from "../../lib/terminal/terminalSelection";
import { findSignInRequest, findWrappedUrls, isSignInUrl } from "../../lib/terminal/terminalUrls";

const COLS = 100;

function row(text: string, isWrapped = false): LineLike {
  const cells = text.padEnd(COLS, " ").slice(0, COLS);
  return {
    isWrapped,
    getCell: (x) => (x < COLS ? { getChars: () => cells[x], getWidth: () => 1 } : undefined),
    translateToString: (trimRight, start = 0, end = COLS) => {
      const s = cells.slice(start, end);
      return trimRight ? s.replace(/\s+$/u, "") : s;
    },
  };
}

// Antigravity's sign-in screen at 100 columns, row for row as `agy` printed it:
// hard newlines, every URL row indented by one space.
const AGY_URL =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21l" +
  "cre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=UA033cxPzFba7aNu6J8hCRAf7P5yD5QiZ5R" +
  "yfjr1wPg&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2" +
  "Foauth-callback&response_type=code&scope=openid&state=QQDzOj0tnyaA1MTgQLZYvg";
const AGY_ROWS = [
  "Your browser should open automatically. If not:",
  "",
  ...AGY_URL.match(/.{1,98}/gu)!.map((piece) => " " + piece),
  "",
  " If you aren't automatically redirected, paste the authorization code below:",
  "",
  " authorization code...",
].map((text) => row(text));
const at = (rows: LineLike[]) => (y: number) => rows[y];

describe("findWrappedUrls", () => {
  it("follows a sign-in URL across the rows an agent CLI hard-wrapped it onto", () => {
    const urls = findWrappedUrls(at(AGY_ROWS), COLS, 0, AGY_ROWS.length - 1);
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe(AGY_URL);
    expect(new URL(urls[0].url).searchParams.get("redirect_uri")).toBe("https://antigravity.google/oauth-callback");
    expect(urls[0].start).toEqual({ x: 1, y: 2 });
    expect(urls[0].end).toEqual({ x: 1 + (AGY_URL.length % 98), y: 5 });
  });

  it("leaves a URL that fits one row to xterm unless asked", () => {
    const rows = [row("see https://example.com/docs.")];
    expect(findWrappedUrls(at(rows), COLS, 0, 0)).toEqual([]);
    expect(findWrappedUrls(at(rows), COLS, 0, 0, true)[0]).toEqual({
      url: "https://example.com/docs",
      start: { x: 4, y: 0 },
      end: { x: 28, y: 0 },
    });
  });

  it("does not glue a word-wrapped sentence onto a URL", () => {
    const head = "Read the docs at https://example.com/" + "a".repeat(COLS - 38);
    const rows = [row(head), row("and then continue with the setup.")];
    expect(findWrappedUrls(at(rows), COLS, 0, 1)).toEqual([]);
  });

  it("follows xterm's own soft wrap", () => {
    const rows = [row("x https://example.com/" + "a".repeat(COLS - 22)), row("bcd more", true)];
    expect(findWrappedUrls(at(rows), COLS, 0, 1)[0].url).toBe("https://example.com/" + "a".repeat(COLS - 22) + "bcd");
  });
});

describe("copying a hard-wrapped URL", () => {
  it("rejoins its rows without their indent", () => {
    const text = joinedSelectionText(at(AGY_ROWS), COLS, {
      start: { x: 1, y: 2 },
      end: { x: COLS, y: 5 },
    });
    expect(text).toBe(AGY_URL);
  });

  it("rejoins a URL folded inside a box narrower than the pane", () => {
    // Mistral Vibe's revealed sign-in link: a 68-column text box centred in
    // the pane; Rich puts the URL on rows of its own, the box's width each,
    // and goes on with the sentence after the last piece.
    const url =
      "https://console.mistral.ai/cli-auth?process=6f1c2a9e-8d34-4b7a-9e21-3c5d7f0b1a42&code_challenge=" +
      "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghi&redirect=1";
    const pad = " ".repeat(16);
    const pieces = url.match(/.{1,68}/gu)!;
    const last = pieces.pop()!;
    const rows = [
      pad + "If copying to the clipboard was not successful, copy the following",
      pad + "URL:",
      ...pieces.map((piece) => pad + piece),
      pad + last + ". If paste fails, hold Shift (Option",
      pad + "in iTerm2, Fn in Terminal.app) while selecting for native copy.",
    ].map((text) => row(text));
    const first = 2;
    const end = first + pieces.length;
    expect(joinedSelectionText(at(rows), COLS, { start: { x: 16, y: first }, end: { x: 16 + last.length, y: end } })).toBe(url);
    expect(findWrappedUrls(at(rows), COLS, 0, rows.length - 1).map((found) => found.url)).toEqual([url]);
  });

  it("keeps a path under a listed link apart from it", () => {
    const rows = [row("  https://github.com/example/project/blob/main/src/lib/a.ts"), row("  src/lib/b.ts")];
    expect(rowJoin(rows[0], rows[1], COLS)).toBeNull();
    expect(findWrappedUrls(at(rows), COLS, 0, 1)).toEqual([]);
  });

  it("keeps prose that ends in a path apart from the next row", () => {
    const prev = "  I changed " + "x".repeat(COLS - 30) + " src/lib/a.ts";
    expect(rowJoin(row(prev.padEnd(COLS - 1, " ").slice(0, COLS - 1)), row("  for details"), COLS)).not.toBe("url");
  });
});

describe("isSignInUrl", () => {
  it("knows the agent CLIs' OAuth and device-login pages", () => {
    expect(isSignInUrl(AGY_URL)).toBe(true);
    expect(isSignInUrl("https://claude.ai/oauth/authorize?code=true&client_id=abc&response_type=code")).toBe(true);
    expect(isSignInUrl("https://auth.openai.com/oauth/authorize?client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455")).toBe(true);
    expect(isSignInUrl("https://github.com/login/device")).toBe(true);
  });

  it("knows every link the phone's sign-in sheet knows (one shared rule)", () => {
    // Qwen's device page carries its code; Cursor's polling page a challenge.
    expect(isSignInUrl("https://chat.qwen.ai/authorize?user_code=K7QX-P2MD&client=qwen-code")).toBe(true);
    expect(isSignInUrl("https://cursor.com/loginDeepControl?challenge=abc&uuid=u1&mode=login")).toBe(true);
    expect(isSignInUrl("https://example.com/start?code_challenge=x&code_challenge_method=S256")).toBe(true);
    expect(isSignInUrl("https://example.com/device")).toBe(true);
    expect(isSignInUrl("https://example.com/activate/")).toBe(true);
    expect(isSignInUrl("https://microsoft.com/devicelogin")).toBe(true);
    expect(isSignInUrl(new URL("https://github.com/login/device"))).toBe(true);
  });

  it("ignores ordinary links", () => {
    // A `client_id` alone is the CLI's own callback, not a page to sign in on.
    expect(isSignInUrl("http://localhost:1455/auth/callback?client_id=x")).toBe(false);
    expect(isSignInUrl("https://example.com/devices")).toBe(false);
    expect(isSignInUrl("https://example.com/activated")).toBe(false);
    expect(isSignInUrl("ftp://example.com/login/device")).toBe(false);
    expect(isSignInUrl("https://antigravity.google/docs/cli/install/")).toBe(false);
    expect(isSignInUrl("https://example.com/?client=1")).toBe(false);
    expect(isSignInUrl("not a url")).toBe(false);
  });
});

describe("findSignInRequest", () => {
  it("finds the link and the paste-the-code prompt under it", () => {
    expect(findSignInRequest(at(AGY_ROWS), COLS, 0, AGY_ROWS.length - 1)).toEqual({ url: AGY_URL, wantsCode: true });
  });

  it("asks for no code when the program does not", () => {
    const rows = [row("Opening https://claude.ai/oauth/authorize?client_id=abc&response_type=code in your browser")];
    expect(findSignInRequest(at(rows), COLS, 0, 0)?.wantsCode).toBe(false);
  });

  it("never asks a device login for a code back", () => {
    const rows = [row("Open https://github.com/login/device and enter the code ABCD-1234")];
    expect(findSignInRequest(at(rows), COLS, 0, 0)).toEqual({ url: "https://github.com/login/device", wantsCode: false });
  });

  it("is null without a sign-in link", () => {
    expect(findSignInRequest(at([row("hello https://example.com")]), COLS, 0, 0)).toBeNull();
  });
});
