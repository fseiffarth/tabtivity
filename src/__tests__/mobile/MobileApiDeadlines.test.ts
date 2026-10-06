/**
 * The phone's request deadlines against the budgets they wait on.
 *
 * `api()` gives up after 10 s unless told otherwise. Some routes may rightly
 * take longer on the far side — a mail open fetches over IMAP, a tab create
 * waits for the desktop and then for the catalog to list the new row — and at
 * the default the phone gave up first and said "Your desktop didn't answer"
 * about an action that then completed. Each such route has a named deadline
 * in `api.ts`; this reads the Rust budgets and holds the deadlines above them,
 * so changing one side without the other fails here.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_MESSAGE_TIMEOUT,
  MAIL_REPLY_TIMEOUT,
  SIGN_IN_CALLBACK_TIMEOUT,
  TAB_CREATE_TIMEOUT,
  LOCAL_MODELS_TIMEOUT,
  finishSignIn,
  getLocalModels,
  localModelAction,
  openSignInTab,
  reopenTab,
} from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

// vitest runs from the repo root, as the other source-reading tests assume.
const read = (path: string): string => readFileSync(path, "utf8");
const PROTOCOL = read("src-tauri/src/services/mobile_control/protocol.rs");
const HOST = read("src-tauri/src/services/mobile_control/host.rs");
const ADMIN = read("src-tauri/src/services/mobile_control/admin.rs");
const SIGN_IN = read("src-tauri/src/services/mobile_control/sign_in.rs");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`no longer contains ${start}`);
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`no ${end} after ${start}`);
  return source.slice(from, to);
}

/** Seconds the sidecar waits for the desktop's answer to `request`
 * (`DesktopRequest::response_timeout`), or the default arm's. */
function responseTimeout(request?: string): number {
  const body = between(PROTOCOL, "pub fn response_timeout(&self)", "pub fn desktop_timeout(&self)");
  const arm = request
    ? new RegExp(`Self::${request} \\{ \\.\\. \\}[^=]*=> (\\d+),`).exec(body)
    : /\n\s*_ => (\d+),/.exec(body);
  if (!arm) throw new Error(`response_timeout no longer names ${request ?? "a default"}`);
  return Number(arm[1]);
}

/** Seconds `admin::desktop_call` allows for reaching the desktop's socket. */
function connectTimeout(): number {
  const body = between(ADMIN, "pub async fn desktop_call(", "tokio::net::UnixStream::connect(socket)");
  const m = /Duration::from_secs\((\d+)\)/.exec(body);
  if (!m) throw new Error("desktop_call no longer bounds its connect");
  return Number(m[1]);
}

/** Seconds the sidecar may poll its catalog for a tab the desktop created. */
function createPoll(): number {
  const body = between(HOST, "async fn created_through_desktop(", "launch_pending");
  const rounds = /for _ in 0\.\.(\d+)/.exec(body);
  const pause = /Duration::from_millis\((\d+)\)/.exec(body);
  if (!rounds || !pause) throw new Error("created_through_desktop no longer polls the way this test reads");
  return (Number(rounds[1]) * Number(pause[1])) / 1000;
}

function callbackTimeout(): number {
  const m = /const CALLBACK_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/.exec(SIGN_IN);
  if (!m) throw new Error("sign_in.rs no longer defines CALLBACK_TIMEOUT");
  return Number(m[1]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(`${BRAND.display} Mobile request deadlines`, () => {
  it("waits longer for a tab than the desktop's answer plus the catalog poll can take", () => {
    const budget = connectTimeout() + responseTimeout() + createPoll();
    expect(budget).toBe(17);
    expect(TAB_CREATE_TIMEOUT / 1000).toBeGreaterThan(budget);
  });

  it("waits longer for a mail message, a flag write and a reply than the sidecar does", () => {
    expect(responseTimeout("MailMark")).toBe(responseTimeout("MailMessage"));
    expect(MAIL_MESSAGE_TIMEOUT / 1000).toBeGreaterThan(connectTimeout() + responseTimeout("MailMessage"));
    expect(MAIL_REPLY_TIMEOUT / 1000).toBeGreaterThan(connectTimeout() + responseTimeout("MailReply"));
  });

  it("waits longer for the local-models routes than the sidecar waits for the window", () => {
    // Neither request has an arm of its own: both ride the default.
    expect(PROTOCOL).not.toMatch(/Self::LocalModel(s|Mutate) \{ \.\. \}[^=]*=> \d+,/);
    expect(LOCAL_MODELS_TIMEOUT / 1000).toBeGreaterThan(connectTimeout() + responseTimeout());
  });

  it.each([
    ["reading the local models", () => getLocalModels()],
    ["loading a local model", () => localModelAction("load", "llama3")],
  ])("gives %s the local-models deadline", async (_name, call) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ server: "running", can_start: false, start_failed: false, models: [] }), { status: 200 })));
    const armed = vi.spyOn(AbortSignal, "timeout");
    await call();
    expect(armed.mock.calls).toEqual([[LOCAL_MODELS_TIMEOUT]]);
    armed.mockRestore();
  });

  it("waits longer for a sign-in callback than the sidecar waits for the CLI", () => {
    expect(SIGN_IN_CALLBACK_TIMEOUT / 1000).toBeGreaterThan(callbackTimeout());
  });

  it("is used by every caller the long routes have", () => {
    const project = read("mobile-web/src/screens/Project.tsx");
    const mail = read("mobile-web/src/screens/Mail.tsx");
    expect(project).toMatch(/\/tabs`, \{ method: "POST"[^\n]*\}, TAB_CREATE_TIMEOUT\);/);
    expect(mail).toMatch(/messages\/\$\{encodeURIComponent\(target\.id\)\}\?offset=\$\{folder\.offset\}`, undefined, MAIL_MESSAGE_TIMEOUT\)/);
    expect(mail.match(/MAIL_MESSAGE_TIMEOUT,\n/g)?.length).toBe(2);
    expect(mail.match(/MAIL_REPLY_TIMEOUT,\n/g)?.length).toBe(2);
  });

  it.each([
    ["reopening a tab", () => reopenTab("project-1", "closed-1"), TAB_CREATE_TIMEOUT],
    ["opening a sign-in tab", () => openSignInTab("tab-1", false, "0123456789abcdef"), TAB_CREATE_TIMEOUT],
    ["finishing a sign-in", () => finishSignIn("tab-1", "http://localhost:1455/cb?code=a&state=b"), SIGN_IN_CALLBACK_TIMEOUT],
  ])("gives %s its own deadline rather than the 10 s default", async (_name, call, deadline) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tab: {}, delivered: true }), { status: 200 })));
    const armed = vi.spyOn(AbortSignal, "timeout");
    await call();
    expect(armed.mock.calls).toEqual([[deadline]]);
    expect(deadline).toBeGreaterThan(10_000);
    armed.mockRestore();
  });
});
