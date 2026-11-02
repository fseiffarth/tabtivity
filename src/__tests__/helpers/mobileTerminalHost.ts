/**
 * The phone's Terminal screen talks to the desktop on two channels: the
 * terminal socket the tests drive (a `FakeWebSocket`), and a handful of HTTP
 * requests it makes on its own — the composer's status chip, the Focus view's
 * transcript, the Commit chip's uncommitted count, the outbox, PDF-markup
 * questions, the model sheet's remembered rows and launch defaults, and the fire-and-forget
 * reports of a sent prompt and of a model list read. Tests about the socket answer those as an unreachable
 * desktop would, with the network error a browser gives, so the screen takes
 * its offline path; any other request still fails the test as unmocked.
 * A test that cares about one of those routes stubs `fetch` itself.
 */
import { act } from "@testing-library/react";
import { vi } from "vitest";
import { unmockedFetch } from "./testGuards";

const SIDE_READS = /^\/api\/v1\/tabs\/[^/?]+\/(status|transcript|uncommitted|outbox|markup\/questions|model-rows|launch-defaults)(\?|$)/;
const PROMPT_REPORT = /^\/api\/v1\/tabs\/[^/?]+\/(prompt|model-rows)$/;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Stub `fetch` so the Terminal screen's own side requests meet an
 * unreachable desktop. Call from `beforeEach`; `vi.unstubAllGlobals()`
 * undoes it. */
export function stubTerminalSideChannels(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if ((method === "GET" && SIDE_READS.test(url)) || (method === "POST" && PROMPT_REPORT.test(url))) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return unmockedFetch(input, init);
  });
}

const wait = async (ms: number) => {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
};

/** The keystrokes `sent()` holds once `count` of them have gone out. Waits
 * `ms` as before, then on until the count is reached (up to 5 s): the screen
 * sends agent keys `AGENT_KEY_GAP` apart, and a slow CI runner (Windows)
 * stretches those timers past a fixed wait. A short tail after a late arrival
 * keeps one key too many visible. */
export async function keysSent(sent: () => string[], count: number, ms: number): Promise<string[]> {
  await wait(ms);
  if (sent().length >= count) return sent();
  for (let waited = 0; sent().length < count && waited < 5000; waited += 50) await wait(50);
  await wait(200);
  return sent();
}
