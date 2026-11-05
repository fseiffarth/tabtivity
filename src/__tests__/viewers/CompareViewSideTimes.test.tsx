/**
 * The sync resolver's time cues in the three-column CompareView: each column
 * header carries its side's modified time (the newer one a badge), each change's
 * Take button its own side's time, and the numbered chip an arrow at the newer
 * column with both sides' times in its tooltip.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
import type { BlameEntry, SideTimes } from "../../lib/viewers/syncSideTimes";

const NOW = Math.floor(Date.now() / 1000);
const ZERO = "0".repeat(40);
const commit = (line_no: number, secs: number): BlameEntry => ({
  line_no,
  hash: "ab".repeat(20),
  short: "abababab",
  author: "Ada",
  author_time: secs,
  summary: "tune lr",
});

function setup(sideTimes?: SideTimes) {
  render(
    <CompareView
      path="/m/train.py"
      left={{ text: "a\nlocal\nc", title: "Local (mirror)" }}
      rightText={"a\nremote\nc"}
      rightTitle="Remote (host)"
      onApply={() => {}}
      onClose={() => {}}
      sideTimes={sideTimes}
    />,
  );
}

describe("CompareView side times", () => {
  it("shows nothing extra without sideTimes", () => {
    setup();
    expect(screen.queryByText("newer")).toBeNull();
  });

  it("stamps each header and badges the newer side once", () => {
    setup({
      left: { mtime: NOW - 3 * 86400, blame: new Map([[2, commit(2, NOW - 3 * 86400)]]) },
      right: { mtime: NOW - 3600, blame: new Map([[2, { ...commit(2, 0), hash: ZERO }]]) },
      newer: "right",
      newerBasis: "time",
    });
    expect(screen.getByText(/modified 3 days ago/)).toBeTruthy();
    expect(screen.getByText(/modified 1 hour ago/)).toBeTruthy();
    // header badge (right) + the Take pill's "newer" on the right (uncommitted vs commit)
    expect(screen.getAllByText("newer").length).toBeGreaterThanOrEqual(2);
  });

  it("dates the change per side in the chip tooltip and the Take pill", () => {
    setup({
      left: { mtime: NOW - 3 * 86400, blame: new Map([[2, commit(2, NOW - 3 * 86400)]]) },
      right: { mtime: NOW - 3600, blame: new Map([[2, { ...commit(2, 0), hash: ZERO }]]) },
      newer: "right",
      newerBasis: "time",
    });
    const chip = document.querySelector(".file-viewer-compare-chip") as HTMLElement;
    expect(chip.title).toContain("Local: committed");
    expect(chip.title).toContain("abababab tune lr");
    expect(chip.title).toContain("Remote: not committed · file saved");
    expect(chip.title).toContain("Remote is newer");
    expect(chip.querySelector(".file-viewer-compare-chip-newer.right")).not.toBeNull();
    expect(document.querySelectorAll(".file-viewer-compare-take-when").length).toBe(2);
  });

  it("leaves per-change times off when a side's blame is unavailable", () => {
    setup({
      left: { mtime: NOW - 86400, blame: null },
      right: { mtime: NOW - 3600, blame: null },
      newer: "right",
      newerBasis: "sync",
    });
    expect(document.querySelectorAll(".file-viewer-compare-take-when").length).toBe(0);
    expect(document.querySelector(".file-viewer-compare-chip-newer")).toBeNull();
    expect(screen.getByText(/modified yesterday/)).toBeTruthy();
  });
});
