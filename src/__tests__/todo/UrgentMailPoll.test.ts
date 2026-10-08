/**
 * The shared urgent-mail backstop (`stores/todo`'s retain/release).
 *
 * Its 60 s tick rides `lib/usePoll` and stops while the window is blurred —
 * right for the desktop rails and strips, wrong for the phone's Alerts screen,
 * which reads the same rows through `MobileBridgeHost` exactly while the
 * desktop window is in the background. A retainer that serves the phone
 * (`unfocused`) keeps the tick running unfocused; when it leaves, the desktop
 * surfaces quiesce again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { releaseUrgentMailPoll, retainUrgentMailPoll } from "../../stores/todo";
import { usePowerStore } from "../../stores/power";

const TICK_MS = 60_000;
const reads = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "mail_priority_page").length;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ items: [], total: 0 });
  usePowerStore.setState({ blurred: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("urgent-mail backstop poll", () => {
  it("stops while the window is blurred for desktop surfaces", async () => {
    retainUrgentMailPoll();
    await advance(0);
    invokeMock.mockClear();
    usePowerStore.setState({ blurred: true });
    await advance(TICK_MS * 3);
    expect(reads()).toBe(0);
    releaseUrgentMailPoll();
  });

  it("keeps ticking unfocused while the phone's feed holds it", async () => {
    retainUrgentMailPoll();
    retainUrgentMailPoll(true);
    await advance(0);
    invokeMock.mockClear();
    usePowerStore.setState({ blurred: true });
    await advance(TICK_MS);
    // One tick = the urgent and the important page.
    expect(reads()).toBe(2);

    // The phone retainer leaves: the desktop one quiesces again.
    releaseUrgentMailPoll(true);
    invokeMock.mockClear();
    await advance(TICK_MS * 3);
    expect(reads()).toBe(0);
    releaseUrgentMailPoll();
  });

  it("runs unfocused when the phone's feed is the only retainer", async () => {
    usePowerStore.setState({ blurred: true });
    retainUrgentMailPoll(true);
    await advance(0);
    invokeMock.mockClear();
    await advance(TICK_MS * 2);
    expect(reads()).toBe(4);
    releaseUrgentMailPoll(true);
    invokeMock.mockClear();
    await advance(TICK_MS * 2);
    expect(reads()).toBe(0);
  });
});
