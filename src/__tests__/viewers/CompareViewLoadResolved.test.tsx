/**
 * The sync resolver's "Load resolved": the agent's file becomes the Result at
 * once over an untouched merge, and only after a confirm over the user's own
 * hand edits or picks (loading replaces them for good).
 */
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("../../stores/projects", () => {
  const state = { projects: [], activeId: null };
  return {
    useProjectsStore: Object.assign((sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state), {
      getState: () => state,
    }),
  };
});
vi.mock("../../lib/window/unsavedWork", () => ({ useUnsavedWork: () => {} }));

import { CompareView } from "../../components/embed/CompareView";

function view(loadResult: { text: string; nonce: number } | null) {
  return (
    <CompareView
      path="/m/train.py"
      left={{ text: "a\nlocal\nc", title: "Local (mirror)" }}
      rightText={"a\nremote\nc"}
      rightTitle="Remote (host)"
      onApply={() => {}}
      onClose={() => {}}
      loadResult={loadResult}
    />
  );
}

const result = () => document.querySelector<HTMLTextAreaElement>(".file-viewer-compare-result")!;

describe("CompareView Load resolved", () => {
  it("loads straight into an untouched Result", () => {
    const { rerender } = render(view(null));
    rerender(view({ text: "a\nAGENT\nc", nonce: 1 }));
    expect(result().value).toBe("a\nAGENT\nc");
    expect(screen.queryByText("Replace your merge?")).toBeNull();
  });

  it("asks before replacing the user's own edits, and keeps them on Cancel", async () => {
    const { rerender } = render(view(null));
    fireEvent.change(result(), { target: { value: "a\nMINE\nc" } });
    rerender(view({ text: "a\nAGENT\nc", nonce: 1 }));
    expect(await screen.findByText("Replace your merge?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(result().value).toBe("a\nMINE\nc");

    rerender(view({ text: "a\nAGENT\nc", nonce: 2 }));
    await screen.findByText("Replace your merge?");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    });
    expect(result().value).toBe("a\nAGENT\nc");
  });
});
