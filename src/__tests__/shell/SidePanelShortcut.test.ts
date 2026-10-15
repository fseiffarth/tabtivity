/**
 * Ctrl+B / ⌘B shows and hides the side panel (`toggleSidePanel`). Typed into a
 * pane terminal Ctrl+B stays the terminal's (tmux prefix, readline); only an Alt
 * chord — Alt+1, off macOS — reaches the window from there.
 */
import { describe, it, expect } from "vitest";
import { actionChords, actionMatches, resolveChord } from "../../lib/shortcuts/shortcuts";
import { terminalMayTakeChord, terminalYieldsChord } from "../../lib/shortcuts/terminalTabChord";
import { editorMayTakeChord } from "../../hooks/useKeyboard";

function key(init: KeyboardEventInit, target?: HTMLElement): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (target) Object.defineProperty(e, "target", { value: target });
  return e;
}
function xterm(): HTMLElement {
  const el = document.createElement("textarea");
  el.className = "xterm-helper-textarea";
  document.body.appendChild(el);
  return el;
}

describe("toggleSidePanel", () => {
  it("defaults to Ctrl+B, with Alt+1 as an alias off macOS", () => {
    expect(resolveChord("toggleSidePanel", null)).toEqual({ key: "b", ctrl: true });
    const chords = actionChords("toggleSidePanel", null);
    expect(chords[0]).toEqual({ key: "b", ctrl: true });
    expect(chords).toContainEqual({ key: "1", alt: true });
    expect(actionMatches("toggleSidePanel", null, key({ key: "b", ctrlKey: true }))).toBe(true);
    expect(actionMatches("toggleSidePanel", null, key({ key: "1", altKey: true }))).toBe(true);
  });

  it("a rebind replaces the alias", () => {
    const overrides = { toggleSidePanel: { key: "j", ctrl: true } };
    expect(actionChords("toggleSidePanel", overrides)).toEqual([{ key: "j", ctrl: true }]);
    expect(actionMatches("toggleSidePanel", overrides, key({ key: "1", altKey: true }))).toBe(false);
  });

  it("a pane terminal keeps Ctrl+B but hands Alt+1 to the window", () => {
    const t = xterm();
    const ctrlB = key({ key: "b", ctrlKey: true }, t);
    const alt1 = key({ key: "1", altKey: true }, t);
    expect(terminalMayTakeChord("toggleSidePanel", ctrlB)).toBe(false);
    expect(terminalYieldsChord(ctrlB, null)).toBe(false);
    expect(terminalMayTakeChord("toggleSidePanel", alt1)).toBe(true);
    expect(terminalYieldsChord(alt1, null)).toBe(true);
  });

  it("an input never hands the window Ctrl+B", () => {
    const input = document.createElement("input");
    const ctrlB = key({ key: "b", ctrlKey: true }, input);
    expect(terminalMayTakeChord("toggleSidePanel", ctrlB)).toBe(false);
    expect(editorMayTakeChord("toggleSidePanel", ctrlB)).toBe(false);
  });
});
