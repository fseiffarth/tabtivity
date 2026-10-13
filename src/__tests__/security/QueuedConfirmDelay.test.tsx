/**
 * Follow-up step 10 (step 9 review): with the trust and open-external question
 * queues, a question that waited appears the instant the one before it is
 * answered — often under the same pointer. A fast double click on "Run it" or
 * "Open" must not answer the next question unseen: its confirm button ignores
 * activation for a short delay after it appears, while Cancel and Escape act
 * at once. A question shown on its own is armed from the start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { ExecTrustHost } from "../../components/common/ExecTrustHost";
import { OpenExternalHost } from "../../components/common/OpenExternalHost";
import { QUEUED_CONFIRM_DELAY_MS } from "../../components/common/PromptDialogs";
import { useExecTrustStore } from "../../stores/execTrust";
import { useOpenExternalStore } from "../../stores/openExternal";
import type { TrustRequest } from "../../lib/execTrust";

const request = (dir: string): TrustRequest => ({
  kind: "latexmkrc",
  dir,
  fingerprint: dir,
  changed: false,
  items: [{ label: "latexmkrc", preview: "$pdf_mode = 1;", truncated: false }],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useExecTrustStore.setState({ pending: null, queue: [], answeredAt: 0 });
  useOpenExternalStore.setState({ pending: null, queue: [], answeredAt: 0 });
});

describe("a queued trust question arms its Run button after a delay", () => {
  it("the second click of a double click does not answer the next question", async () => {
    render(<ExecTrustHost />);
    const answers: boolean[] = [];
    act(() => {
      void useExecTrustStore.getState().ask(request("/p/one")).then((a) => answers.push(a));
      void useExecTrustStore.getState().ask(request("/p/two")).then((a) => answers.push(a));
    });
    // The first question is armed at once.
    expect(screen.getByText("/p/one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    // The second is on screen the same instant; the double click's second
    // click lands on its Run button and is ignored.
    expect(screen.getByText("/p/two")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([true]);
    expect(useExecTrustStore.getState().pending?.request.dir).toBe("/p/two");

    // After the delay a deliberate click answers it.
    act(() => vi.advanceTimersByTime(QUEUED_CONFIRM_DELAY_MS));
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([true, true]);
    expect(useExecTrustStore.getState().pending).toBeNull();
  });

  it("Don't run and Escape act at once on a queued question", async () => {
    render(<ExecTrustHost />);
    const answers: boolean[] = [];
    act(() => {
      for (const dir of ["/p/a", "/p/b", "/p/c"]) {
        void useExecTrustStore.getState().ask(request(dir)).then((a) => answers.push(a));
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't run" }));
    expect(screen.getByText("/p/c")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {});
    expect(answers).toEqual([true, false, false]);
  });

  it("Enter on the Run button of a fresh queued question does nothing", async () => {
    render(<ExecTrustHost />);
    const answers: boolean[] = [];
    act(() => {
      void useExecTrustStore.getState().ask(request("/p/one")).then((a) => answers.push(a));
      void useExecTrustStore.getState().ask(request("/p/two")).then((a) => answers.push(a));
    });
    fireEvent.click(screen.getByRole("button", { name: "Don't run" }));
    const run = screen.getByRole("button", { name: "Run it" });
    run.focus();
    // A browser turns Enter on a focused button into a click.
    fireEvent.keyDown(run, { key: "Enter" });
    fireEvent.click(run);
    await act(async () => {});
    expect(answers).toEqual([false]);
    act(() => vi.advanceTimersByTime(QUEUED_CONFIRM_DELAY_MS - 1));
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([false]);
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([false, true]);
  });
});

describe("a question asked right after an answer counts as queued", () => {
  it("the next gate of the same action does not take the double click's second click", async () => {
    // `withExecTrust` asks again right after an approval when the action
    // passes a second gate (or the file changed): nothing waited in the queue,
    // but the new question appears under the same pointer all the same.
    render(<ExecTrustHost />);
    const answers: boolean[] = [];
    act(() => {
      void useExecTrustStore.getState().ask(request("/p/hooks")).then((a) => answers.push(a));
    });
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([true]);
    act(() => {
      void useExecTrustStore.getState().ask(request("/p/prettier")).then((a) => answers.push(a));
    });
    expect(useExecTrustStore.getState().pending?.queued).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([true]);
    act(() => vi.advanceTimersByTime(QUEUED_CONFIRM_DELAY_MS));
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await act(async () => {});
    expect(answers).toEqual([true, true]);
  });

  it("an open-external question asked well after the last answer is armed at once", async () => {
    render(<OpenExternalHost />);
    const answers: boolean[] = [];
    const ask = (name: string) =>
      act(() => {
        void useOpenExternalStore
          .getState()
          .ask({ kind: "confirm", name, path: `/p/${name}` })
          .then((a) => answers.push(a));
      });
    ask("a.xyz");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    ask("b.xyz");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(answers).toEqual([true]);
    act(() => vi.advanceTimersByTime(QUEUED_CONFIRM_DELAY_MS));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(answers).toEqual([true, true]);
    // Long after: a question on its own again.
    act(() => vi.advanceTimersByTime(QUEUED_CONFIRM_DELAY_MS));
    ask("c.xyz");
    expect(useOpenExternalStore.getState().pending?.queued).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(answers).toEqual([true, true, true]);
  });
});

describe("a queued open-external question arms its Open button after a delay", () => {
  it("ignores the double click's second click, then opens on a deliberate one", async () => {
    render(<OpenExternalHost />);
    const answers: boolean[] = [];
    act(() => {
      for (const name of ["a.xyz", "b.xyz"]) {
        void useOpenExternalStore
          .getState()
          .ask({ kind: "confirm", name, path: `/p/${name}` })
          .then((a) => answers.push(a));
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("/p/b.xyz")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(answers).toEqual([true]);
    // Cancel needs no delay.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(answers).toEqual([true, false]);
  });

  it("a question shown on its own is armed at once", async () => {
    render(<OpenExternalHost />);
    let answer: boolean | null = null;
    act(() => {
      void useOpenExternalStore
        .getState()
        .ask({ kind: "confirm", name: "a.xyz", path: "/p/a.xyz" })
        .then((a) => (answer = a));
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(answer).toBe(true);
  });
});
