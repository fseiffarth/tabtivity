/**
 * The glyph(s) leading a tab's label (`TabStatusMark`). One mark per thing the
 * tab is doing: the agent's own turn in the status green, a command it is
 * running in the shell colour — and BOTH when an agent works with a shell of
 * its own going (`services::agent_turn`'s `job` flag), which is the one state
 * the single-colour ring cannot say on its own.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TabStatusMark } from "../../components/tabs/TabLocalityBadges";

// Both working glyphs are drawn, not typed: as a character, a popout's font
// fallback reached the colour emoji font (even pinned with U+FE0E), which
// ignores the ring's colour. An agent's turn is "•••" (three `.working-dot`s a
// light walks through); a command is ▶.
const DOTS = "dots";
const PLAY = "play";

function glyphOf(el: Element): string | null {
  const svg = el.querySelector("svg");
  if (!svg) return el.textContent;
  const drawn = svg.querySelectorAll(".working-dot").length === 3 ? DOTS : PLAY;
  return el.textContent ? `${drawn}+${el.textContent}` : drawn;
}

function marks(stateClass: string) {
  const { container } = render(<TabStatusMark stateClass={stateClass} />);
  return [...container.querySelectorAll(".tab-status-mark")].map((el) => ({
    glyph: glyphOf(el),
    shell: el.classList.contains("shell"),
  }));
}

describe("TabStatusMark", () => {
  it("marks an agent's own turn once, with walking dots in the agent's colour", () => {
    expect(marks(" working")).toEqual([{ glyph: DOTS, shell: false }]);
  });

  it("marks a tab that is only running a command in the shell colour", () => {
    expect(marks(" working shell")).toEqual([{ glyph: PLAY, shell: true }]);
  });

  it("marks an agent working with a command of its own with both marks", () => {
    expect(marks(" working job")).toEqual([
      { glyph: DOTS, shell: false },
      { glyph: PLAY, shell: true },
    ]);
  });

  it("keeps a tab strip's mark cells fixed, so no mark coming, going or swapping resizes the tab", () => {
    // What a cell holds, per cell; `""` is an empty cell.
    const cells = (stateClass: string, slots: 1 | 2) =>
      [...render(<TabStatusMark stateClass={stateClass} slots={slots} />).container.querySelectorAll(".tab-status-slot")].map(
        (cell) => {
          const mark = cell.querySelector(".tab-status-mark");
          return mark ? (mark.classList.contains("shell") ? "cmd" : (mark.textContent || "dots")) : "";
        },
      );
    // An agent tab: its turn in the first cell, a command of its own always in
    // the second — idle, asking, working, working with a command, or only the
    // command left running after the turn ended.
    expect(cells("", 2)).toEqual(["", ""]);
    expect(cells(" needs-decision", 2)).toEqual(["?", ""]);
    expect(cells(" working", 2)).toEqual(["dots", ""]);
    expect(cells(" working job", 2)).toEqual(["dots", "cmd"]);
    expect(cells(" working shell", 2)).toEqual(["", "cmd"]);
    expect(cells(" finished", 2)).toEqual(["✓", ""]);
    // A shell tab: one cell, kept while it is idle too.
    expect(cells("", 1)).toEqual([""]);
    expect(cells(" working shell", 1)).toEqual(["cmd"]);
  });

  it("draws nothing for an idle tab outside a tab strip", () => {
    expect(render(<TabStatusMark stateClass="" />).container.innerHTML).toBe("");
  });

  it("keeps the other two states one mark each", () => {
    expect(marks(" needs-decision")).toEqual([{ glyph: "?", shell: false }]);
    expect(marks(" finished")).toEqual([{ glyph: "✓", shell: false }]);
    expect(marks("")).toEqual([]);
  });
});
