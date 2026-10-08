/**
 * Sleeping tabs (performance plan §5.3): an image tab sleeps when hidden long
 * enough, and sleeping unmounts the viewer. The annotator's drawing lives only
 * on its own canvas, so while it is open it must hold the pane awake
 * (`usePaneSleepHold`), and closing it releases the hold.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

import { ImageAnnotator } from "../../components/embed/ImageAnnotator";
import { PaneSleepHoldContext } from "../../lib/sleepWhenHidden";

describe("ImageAnnotator sleep hold", () => {
  it("holds the pane while open and releases it on close", () => {
    const held = new Set<object>();
    const report = (token: object, on: boolean) => {
      if (on) held.add(token);
      else held.delete(token);
    };
    const { unmount } = render(
      <PaneSleepHoldContext.Provider value={report}>
        <ImageAnnotator src="blob:x" path="/p/a.png" fileName="a.png" onClose={() => {}} />
      </PaneSleepHoldContext.Provider>,
    );
    expect(held.size).toBe(1);
    unmount();
    expect(held.size).toBe(0);
  });
});
