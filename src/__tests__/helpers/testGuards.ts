/**
 * Loud, deterministic test failures for two things that otherwise pass on one
 * machine and fail on another.
 *
 * Unmocked calls. jsdom has no network and no Tauri runtime, so a component
 * that reaches `fetch` or `invoke` without a test mock talks to nothing. Left
 * alone that is a timing lottery: Node's real `fetch` rejects a relative URL at
 * once but tries a real connection for an absolute one, and whatever the
 * component does with the odd answer (a render error, a rejected promise) may
 * land inside the test, after it, or after the file. Instead every unmocked
 * call is recorded against the test that made it and rejected with an
 * `UnmockedCallError`, and a global `afterEach` fails that test by name,
 * listing each call — however the component handled the rejection. Tests that
 * mock `fetch` (`vi.stubGlobal`, `vi.spyOn`, assignment) or
 * `@tauri-apps/api/core` (`vi.mock`) never reach the guards;
 * `vi.unstubAllGlobals()` restores the guard, not the real fetch.
 *
 * Uncaught errors. Vitest reports an error nobody caught (a render error from
 * a mock's wrong-shaped answer — ci-cd #377 — or an unhandled rejection) once
 * for the whole run, attached to no test, so the run fails but no test file
 * does, and CI's failed-first list never names it. The guard also fails the
 * test that was running when the error was thrown, by name. Vitest's own
 * run-level report is kept.
 */
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, expect } from "vitest";

interface Strike {
  call: string;
  hint: string;
  test: string | undefined;
}

const strikes: Strike[] = [];

export class UnmockedCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnmockedCallError";
  }
}

function currentTest(): string | undefined {
  try {
    return expect.getState().currentTestName;
  } catch {
    return undefined;
  }
}

function record(call: string, hint: string): UnmockedCallError {
  strikes.push({ call, hint, test: currentTest() });
  return new UnmockedCallError(`${call} is not mocked in this test. ${hint}`);
}

function requestLabel(input: unknown, init: RequestInit | undefined): string {
  let url: string;
  let method = init?.method;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof input === "object" && "url" in input) {
    const request = input as { url: unknown; method?: unknown };
    url = String(request.url);
    method ??= typeof request.method === "string" ? request.method : undefined;
  } else url = String(input);
  return `fetch ${(method ?? "GET").toUpperCase()} ${url}`;
}

const FETCH_HINT =
  "Answer every request from the test's fetch mock (vi.stubGlobal(\"fetch\", ...)); a " +
  "catch-all fallback that returns some other route's body hides a miss the same way.";

/** The `fetch` every test starts with: records the call and rejects. */
export function unmockedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return Promise.reject(record(requestLabel(input, init), FETCH_HINT));
}

/** What the real `@tauri-apps/api` asks the runtime on its own, answered as
 * a jsdom page with no backend would be: event listeners and resource cleanup
 * succeed, and the page is the only window. The packages are external to
 * Vite, so their internal `./core.js` import never sees a test's
 * `vi.mock("@tauri-apps/api/core")` and lands here even in tests that mock
 * core — answering these is not the test's job. */
function plumbing(cmd: string): { answer: unknown } | undefined {
  if (cmd.startsWith("plugin:event|") || cmd === "plugin:resources|close") return { answer: null };
  if (cmd === "plugin:window|get_all_windows") return { answer: [] };
  return undefined;
}

const INVOKE_HINT =
  "Mock the backend: vi.mock(\"@tauri-apps/api/core\", () => ({ invoke: vi.fn(...) })).";

/** `window.__TAURI_INTERNALS__.invoke` for tests that do not mock
 * `@tauri-apps/api/core`: event plumbing resolves, any command is recorded and
 * rejected. */
export function unmockedInvoke(cmd: string): Promise<unknown> {
  const known = plumbing(cmd);
  if (known) return Promise.resolve(known.answer);
  return Promise.reject(record(`invoke("${cmd}")`, INVOKE_HINT));
}

/** Tests already failed for their unmocked calls. A call the code makes
 * after its test ended (a retry timer, a late poll) is noted against the test
 * it came from; once that test has failed for the same reason, reporting the
 * straggler again would only fail an innocent neighbour, depending on timing. */
const reported = new Set<string>();

function unmockedReport(when: string): string | undefined {
  if (strikes.length === 0) return undefined;
  const here = currentTest();
  const fresh = strikes.splice(0).filter(({ test }) => !(test && test !== here && reported.has(test)));
  if (fresh.length === 0) return undefined;
  for (const { test } of fresh) if (test) reported.add(test);
  const lines = fresh.map(({ call, test }) =>
    test && test !== here ? `  ${call}   (made during "${test}")` : `  ${call}`,
  );
  const hints = [...new Set(fresh.map(({ hint }) => hint))];
  return (
    `Unmocked call${lines.length === 1 ? "" : "s"} ${when}:\n${lines.join("\n")}\n` +
    `Each was rejected with an UnmockedCallError. ${hints.join(" ")}`
  );
}

interface Escape {
  kind: string;
  error: unknown;
  test: string | undefined;
}

const escapes: Escape[] = [];

/** The sink the process hook feeds; each test file's setup run replaces it,
 * so a worker process reused across files reports into the current file. */
const SINK = Symbol.for("testGuards.uncaught");

type EmitHost = {
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  [SINK]?: (kind: string, error: unknown) => void;
  [key: symbol]: unknown;
};

/** Observe every uncaught exception and unhandled rejection without adding a
 * process listener: Vitest treats any extra listener as user code handling
 * the error and stops reporting it. Node, and Vitest's own jsdom error
 * bridge, deliver both through `process.emit`, so a pass-through wrapper sees
 * them and changes nothing. */
function observeUncaught(): void {
  const host = (globalThis as unknown as { process?: EmitHost }).process;
  if (!host) return;
  host[SINK] = (kind, error) => escapes.push({ kind, error, test: currentTest() });
  const WRAPPED = Symbol.for("testGuards.emitWrapped");
  if (host[WRAPPED]) return;
  host[WRAPPED] = true;
  const emit = host.emit;
  host.emit = function (this: EmitHost, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "uncaughtException" || event === "unhandledRejection") {
      try {
        host[SINK]?.(event === "uncaughtException" ? "Uncaught exception" : "Unhandled rejection", args[0]);
      } catch {
        /* observing must never change what Vitest sees */
      }
    }
    return emit.call(this, event, ...args);
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function escapeReport(): string | undefined {
  if (escapes.length === 0) return undefined;
  const here = currentTest();
  // An error thrown after its test ended stays Vitest's run-level report;
  // failing whichever test runs next would depend on timing.
  const mine = escapes.splice(0).filter(({ test }) => !test || test === here);
  if (mine.length === 0) return undefined;
  return (
    `${mine.length} error${mine.length === 1 ? "" : "s"} escaped this test uncaught ` +
    "(Vitest also lists them under Unhandled Errors):\n" +
    mine.map(({ kind, error }) => `${kind}: ${describeError(error)}`).join("\n\n")
  );
}

export class UncaughtInTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncaughtInTestError";
  }
}

/** Register the per-test and per-file checks. Call once from the setup file. */
export function installTestGuards(): void {
  observeUncaught();
  // Runs after the test file's own `afterEach` hooks. Deliberately no
  // waiting here for the test's pending work to finish: a file's hooks often
  // restore `fetch` before the tree unmounts, and a timer that fired in that
  // gap would be a call charged by timing, not by the test.
  afterEach(() => {
    // Unmount before reporting: a throwing hook skips the hooks after it,
    // Testing Library's own cleanup among them, and a still-mounted tree would
    // leak its DOM and timers into the next test (and past the file's
    // teardown). Calls made while unmounting count too. Cleaning twice is a
    // no-op.
    cleanup();
    const unmocked = unmockedReport("during this test");
    const escaped = escapeReport();
    if (unmocked) throw new UnmockedCallError(escaped ? `${unmocked}\n\n${escaped}` : unmocked);
    if (escaped) throw new UncaughtInTestError(escaped);
  });
  afterAll(() => {
    const unmocked = unmockedReport("after this file's last test finished");
    if (unmocked) throw new UnmockedCallError(unmocked);
  });
}
