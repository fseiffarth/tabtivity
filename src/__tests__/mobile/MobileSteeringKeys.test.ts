/**
 * The phone's steering keys (`mobile-web/src/steering/phoneSteeringKeys`): the
 * table by level, its tie to the desktop defaults, and the helpers that decide
 * which keydowns the engine may act on (entry chords, ignored keys, the first
 * hardware key).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PHONE_LEVELS,
  PHONE_STEERING_BINDINGS,
  acceptsRepeat,
  findPhoneSteeringConflicts,
  isEntryChord,
  isHardwareKeydown,
  isIgnoredKey,
  isSpace,
  isTypingTarget,
  phoneActionKeys,
  phoneDigit,
  phoneKeys,
  phoneRowKeys,
  phoneSteeringActionFor,
  type PhoneLevel,
} from "../../../mobile-web/src/steering/phoneSteeringKeys";
import { steeringKeys } from "../../lib/shortcuts/steeringBindings";
import { isLoneModifier, normalizeKey } from "../../lib/shortcuts/keyNames";
import { isLoneModifier as reLone, normalizeKey as reNorm } from "../../lib/shortcuts/shortcuts";
import { codeFor, keyInit } from "../helpers/mobileSteering";

const ev = (key: string, code = codeFor(key)) => ({ key, code });
const kb = (key: string, mods: Parameters<typeof keyInit>[1] = {}) => new KeyboardEvent("keydown", keyInit(key, mods));
const act = (key: string, level: PhoneLevel) => phoneSteeringActionFor(ev(key), level, null);

function field(tag: "input" | "textarea", value = "", type?: string): HTMLElement {
  const el = document.createElement(tag);
  if (type) (el as HTMLInputElement).type = type;
  (el as HTMLInputElement).value = value;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("shared key names", () => {
  it("shortcuts.ts re-exports the moved helpers", () => {
    expect(reNorm).toBe(normalizeKey);
    expect(reLone).toBe(isLoneModifier);
    expect(normalizeKey("W")).toBe("w");
    expect(isLoneModifier("Shift")).toBe(true);
    expect(isLoneModifier("a")).toBe(false);
  });
});

describe("phone steering table", () => {
  it("resolves the walking keys on every level", () => {
    // The desktop's exit key, whatever it is (Space at HEAD); Escape is covered below.
    const exitKey = steeringKeys("exit", null).find((k) => k !== "Escape");
    for (const level of PHONE_LEVELS) {
      expect(act("e", level)).toBe("up");
      expect(act("ArrowUp", level)).toBe("up");
      expect(act("d", level)).toBe("down");
      expect(act("ArrowDown", level)).toBe("down");
      expect(act("s", level)).toBe("back");
      expect(act("ArrowLeft", level)).toBe("back");
      if (exitKey) expect(act(exitKey, level)).toBe("exit");
    }
  });

  it("F, the right arrow and Enter open on lists and sheets, F jumps to the latest inside", () => {
    for (const level of ["projects", "tabs", "section", "region"] as const) {
      expect(act("f", level)).toBe("open");
      expect(act("ArrowRight", level)).toBe("open");
      expect(act("Enter", level)).toBe("open");
    }
    expect(act("f", "inside")).toBe("latest");
    expect(act("ArrowRight", "inside")).toBe("latest");
    expect(act("Enter", "inside")).toBeNull();
  });

  it("Escape leaves the mode except over a sheet, where it is Back", () => {
    for (const level of ["projects", "tabs", "inside", "section"] as const) expect(act("Escape", level)).toBe("exit");
    expect(act("Escape", "region")).toBe("back");
    expect(phoneActionKeys("exit", "region", null)).not.toContain("Escape");
    expect(phoneActionKeys("back", "region", null)).toContain("Escape");
  });

  it("puts the status, section and search keys on every level but a sheet", () => {
    for (const level of ["projects", "tabs", "inside", "section"] as const) {
      expect(act("q", level)).toBe("nextDecision");
      expect(act("r", level)).toBe("nextWorking");
      expect(act("x", level)).toBe("nextDone");
      expect(act("Backspace", level)).toBe("jumpBack");
      expect(act("m", level)).toBe("mail");
      expect(act("c", level)).toBe("calendar");
      expect(act("t", level)).toBe("todo");
      expect(act(",", level)).toBe("search");
      expect(act("h", level)).toBe("legend");
    }
    for (const key of ["q", "r", "x", "m", "c", "t", ",", "h", "Backspace"]) expect(act(key, "region"), key).toBeNull();
  });

  it("gives each level its own acts", () => {
    expect(act("n", "projects")).toBe("newProject");
    expect(act("n", "tabs")).toBe("newTab");
    expect(act("+", "tabs")).toBe("newTab");
    expect(act("=", "tabs")).toBe("newTab");
    expect(act("w", "tabs")).toBe("closeTab");
    expect(act(".", "tabs")).toBe("menu");
    expect(act("ContextMenu", "tabs")).toBe("menu");
    expect(act("i", "inside")).toBe("type");
    expect(act("y", "region")).toBe("confirm");
    expect(act("n", "inside")).toBeNull();
    expect(act("w", "projects")).toBeNull();
    expect(act("y", "tabs")).toBeNull();
  });

  it("reads digits as row N on Home, an answer inside a tab, and nothing elsewhere", () => {
    expect(act("3", "projects")).toBe("openRow");
    expect(act("3", "inside")).toBe("answer");
    expect(act("3", "tabs")).toBeNull();
    expect(act("3", "region")).toBeNull();
    expect(phoneDigit(ev("3"), null)).toBe(3);
    expect(phoneDigit(ev("9"), null)).toBe(9);
    expect(phoneDigit(ev("0"), null)).toBeNull();
    expect(phoneDigit(ev("a"), null)).toBeNull();
  });

  it("reads a digit by its physical key on AZERTY, but a letter keeps its character", () => {
    expect(phoneSteeringActionFor({ key: "&", code: "Digit1" }, "projects", null)).toBe("openRow");
    expect(phoneDigit({ key: "&", code: "Digit1" }, null)).toBe(1);
    expect(phoneDigit({ key: "é", code: "Digit2" }, null)).toBe(2);
    expect(phoneDigit({ key: "1", code: "Numpad1" }, null)).toBe(1);
    expect(phoneSteeringActionFor({ key: "e", code: "KeyE" }, "inside", null)).toBe("up");
  });

  it("does not look at Shift: Q backwards is still the Q row", () => {
    expect(phoneSteeringActionFor({ key: "Q", code: "KeyQ" }, "tabs", null)).toBe("nextDecision");
  });

  it("takes the desktop's user keys through the overrides argument", () => {
    expect(phoneSteeringActionFor(ev("j"), "projects", { down: ["j"] })).toBe("down");
    expect(phoneSteeringActionFor(ev("d"), "projects", { down: ["j"] })).toBeNull();
    expect(phoneSteeringActionFor(ev("Enter"), "projects", { right: [] })).toBe("open");
  });

  it("only up and down accept a held key", () => {
    expect(acceptsRepeat("up")).toBe(true);
    expect(acceptsRepeat("down")).toBe(true);
    for (const row of PHONE_STEERING_BINDINGS) {
      if (row.action !== "up" && row.action !== "down") expect(acceptsRepeat(row.action)).toBe(false);
    }
  });
});

describe("tie to the desktop table", () => {
  it("rows that name a desktop action answer to exactly its keys", () => {
    for (const row of PHONE_STEERING_BINDINGS) {
      if (typeof row.desktop !== "string") continue;
      const own = row.keys ?? [];
      const except = row.except ?? [];
      const wanted = [...steeringKeys(row.desktop, null), ...own.filter((k) => !steeringKeys(row.desktop as never, null).includes(k))]
        .filter((k) => !except.includes(k));
      expect(phoneKeys(row, null), row.action).toEqual(wanted);
    }
  });

  it("the walking rows carry the desktop defaults at HEAD", () => {
    expect(phoneActionKeys("up", "tabs", null)).toEqual(steeringKeys("up", null));
    expect(phoneActionKeys("back", "tabs", null)).toEqual(steeringKeys("left", null));
    expect(phoneActionKeys("nextDone", "inside", null)).toEqual(steeringKeys("nextDone", null));
    expect(phoneActionKeys("newTab", "tabs", null)).toEqual([...steeringKeys("newShell", null), ...steeringKeys("newTabMenu", null)]);
  });

  it("follows a changed desktop key without edits to the table", () => {
    expect(phoneActionKeys("nextDone", "tabs", { nextDone: ["z"] })).toEqual(["z"]);
  });

  it("an unbound desktop action leaves the row's own keys", () => {
    expect(phoneActionKeys("open", "tabs", { right: [] })).toEqual(["Enter"]);
  });

  it("has no conflicting keys on any level", () => {
    expect(findPhoneSteeringConflicts(null).size).toBe(0);
  });

  it("keeps Escape as Back over a sheet and I as the type key whatever the desktop's exit and prompt keys are", () => {
    // The desktop rework's defaults: Escape exits, Space opens the prompt box.
    const rework = { exit: ["Escape"], agentPrompt: [" "] };
    expect(findPhoneSteeringConflicts(rework).size).toBe(0);
    expect(phoneSteeringActionFor(new KeyboardEvent("keydown", keyInit("Escape")), "region", rework)).toBe("back");
    expect(phoneSteeringActionFor(new KeyboardEvent("keydown", keyInit("Escape")), "tabs", rework)).toBe("exit");
    expect(phoneSteeringActionFor(new KeyboardEvent("keydown", keyInit("i")), "inside", rework)).toBe("type");
    expect(phoneSteeringActionFor(new KeyboardEvent("keydown", keyInit(" ")), "inside", rework)).toBe("type");
  });

  it("reports a conflict when two live actions share a key", () => {
    const conflicts = findPhoneSteeringConflicts({ nextDone: ["m"] });
    expect(conflicts.get("nextDone")).toContain("mail");
    expect(conflicts.get("mail")).toContain("nextDone");
  });

  it("builds legend text from the key labels", () => {
    const up = PHONE_STEERING_BINDINGS.find((r) => r.action === "up" && r.levels.includes("tabs"))!;
    expect(phoneRowKeys(up)).toBe("E / ↑");
    const open = PHONE_STEERING_BINDINGS.find((r) => r.action === "open")!;
    expect(phoneRowKeys(open)).toBe("F / → / Enter");
    expect(phoneRowKeys(PHONE_STEERING_BINDINGS.find((r) => r.action === "openRow")!)).toBe("1–9");
    expect(phoneRowKeys(PHONE_STEERING_BINDINGS.find((r) => r.action === "jumpBack")!)).toBe("Backspace");
    expect(phoneRowKeys(open, { right: [], })).toBe("Enter");
    expect(phoneRowKeys({ ...open, keys: [] }, { right: [] })).toBe("—");
  });
});

describe("isSpace", () => {
  it("matches by code, by character and by the no-break space", () => {
    expect(isSpace({ key: " ", code: "" })).toBe(true);
    expect(isSpace({ key: "Unidentified", code: "Space" })).toBe(true);
    expect(isSpace({ key: " ", code: "" })).toBe(true);
    expect(isSpace({ key: "a", code: "KeyA" })).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("knows text fields, textareas, selects and contenteditable", () => {
    expect(isTypingTarget(field("input", "", "text"))).toBe(true);
    expect(isTypingTarget(field("input", "", "search"))).toBe(true);
    expect(isTypingTarget(field("textarea"))).toBe(true);
    const select = document.createElement("select");
    document.body.append(select);
    expect(isTypingTarget(select)).toBe(true);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    expect(isTypingTarget(editable)).toBe(true);
  });

  it("hands a focused slider its native arrows", () => {
    const range = field("input", "50", "range");
    expect(isTypingTarget(range)).toBe(true);
    expect(isEntryChord(kb(" ", { shift: true }), range)).toBe(true);
  });

  it("ignores buttons and the non-text inputs", () => {
    for (const type of ["button", "checkbox", "radio", "file", "color", "submit", "image", "reset"]) {
      expect(isTypingTarget(field("input", "", type)), type).toBe(false);
    }
    const button = document.createElement("button");
    document.body.append(button);
    expect(isTypingTarget(button)).toBe(false);
  });

  it("also reads the focused element when the event is fired on window", () => {
    const input = field("input", "", "text") as HTMLInputElement;
    expect(isTypingTarget(window)).toBe(false);
    input.focus();
    expect(isTypingTarget(window)).toBe(true);
    expect(isTypingTarget(document)).toBe(true);
    expect(isTypingTarget(null)).toBe(true);
    input.blur();
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("isEntryChord", () => {
  it("Shift+Space enters from the page, a button and an empty field", () => {
    expect(isEntryChord(kb(" ", { shift: true }), document.body)).toBe(true);
    expect(isEntryChord(kb(" ", { shift: true }), window)).toBe(true);
    const button = document.createElement("button");
    document.body.append(button);
    expect(isEntryChord(kb(" ", { shift: true }), button)).toBe(true);
    expect(isEntryChord(kb(" ", { shift: true }), field("textarea", ""))).toBe(true);
  });

  it("Shift+Space in a non-empty field types a space", () => {
    expect(isEntryChord(kb(" ", { shift: true }), field("textarea", "hello"))).toBe(false);
    expect(isEntryChord(kb(" ", { shift: true }), field("input", "x", "text"))).toBe(false);
  });

  it("Alt+Space enters from anywhere, a non-empty field included", () => {
    expect(isEntryChord(kb(" ", { alt: true }), field("textarea", "hello"))).toBe(true);
    expect(isEntryChord(kb(" ", { alt: true }), document.body)).toBe(true);
  });

  it("Alt+Space whose key is the no-break space still enters", () => {
    expect(isEntryChord(kb(" ", { alt: true, code: "Space" }), document.body)).toBe(true);
    expect(isEntryChord(kb(" ", { alt: true, code: "" }), document.body)).toBe(true);
  });

  it("an IME that sends no code still enters on the character", () => {
    expect(isEntryChord(kb(" ", { shift: true, code: "" }), document.body)).toBe(true);
  });

  it("ignores Ctrl and Meta with Space, Shift+Alt+Space, plain Space and other keys", () => {
    expect(isEntryChord(kb(" ", { shift: true, ctrl: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" ", { alt: true, ctrl: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" ", { shift: true, meta: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" ", { alt: true, meta: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" ", { shift: true, alt: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" "), document.body)).toBe(false);
    expect(isEntryChord(kb("a", { shift: true }), document.body)).toBe(false);
  });

  it("ignores a held chord", () => {
    expect(isEntryChord(kb(" ", { shift: true, repeat: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" ", { alt: true, repeat: true }), document.body)).toBe(false);
  });

  it("ignores composing events and keyCode 229", () => {
    expect(isEntryChord(kb(" ", { shift: true, isComposing: true }), document.body)).toBe(false);
    expect(isEntryChord(kb(" ", { shift: true, keyCode: 229 }), document.body)).toBe(false);
    expect(isEntryChord(kb("Process", { shift: true, code: "Space" }), document.body)).toBe(false);
  });

  it("a lone Shift is no chord", () => {
    expect(isEntryChord(kb("Shift", { shift: true, code: "ShiftLeft" }), document.body)).toBe(false);
  });
});

describe("isIgnoredKey", () => {
  it("drops Ctrl, Meta and Alt combinations, but not the Alt+Space chord", () => {
    expect(isIgnoredKey(kb("e", { ctrl: true }))).toBe(true);
    expect(isIgnoredKey(kb("e", { meta: true }))).toBe(true);
    expect(isIgnoredKey(kb("ArrowLeft", { alt: true }))).toBe(true);
    expect(isIgnoredKey(kb("e", { alt: true }))).toBe(true);
    expect(isIgnoredKey(kb(" ", { alt: true }))).toBe(false);
    expect(isIgnoredKey(kb(" ", { alt: true }))).toBe(false);
    expect(isIgnoredKey(kb(" ", { alt: true, shift: true }))).toBe(true);
    expect(isIgnoredKey(kb(" ", { ctrl: true }))).toBe(true);
  });

  it("drops IME steps, dead keys and lone modifiers", () => {
    expect(isIgnoredKey(kb("a", { isComposing: true }))).toBe(true);
    expect(isIgnoredKey(kb("a", { keyCode: 229 }))).toBe(true);
    for (const key of ["Unidentified", "Process", "Dead"]) expect(isIgnoredKey(kb(key)), key).toBe(true);
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]) expect(isIgnoredKey(kb(key)), key).toBe(true);
  });

  it("lets Shift letters and plain keys through", () => {
    expect(isIgnoredKey(kb("Q", { shift: true }))).toBe(false);
    expect(isIgnoredKey(kb("ArrowDown"))).toBe(false);
    expect(isIgnoredKey(kb(" ", { shift: true }))).toBe(false);
    expect(isIgnoredKey(kb("Tab"))).toBe(false);
  });
});

describe("isHardwareKeydown", () => {
  it("counts a key pressed with no text field focused", () => {
    expect(isHardwareKeydown(kb("a"), document.body)).toBe(true);
    expect(isHardwareKeydown(kb("a"), window)).toBe(true);
  });

  it("does not count ordinary typing in a field", () => {
    const input = field("textarea", "hi");
    expect(isHardwareKeydown(kb("a"), input)).toBe(false);
    expect(isHardwareKeydown(kb(" "), input)).toBe(false);
    expect(isHardwareKeydown(kb("Backspace"), input)).toBe(false);
  });

  it("counts Alt, arrows, Escape, Tab and F-keys even in a field", () => {
    const input = field("textarea", "hi");
    expect(isHardwareKeydown(kb("a", { alt: true }), input)).toBe(true);
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Tab", "F1", "F12"]) {
      expect(isHardwareKeydown(kb(key), input), key).toBe(true);
    }
    expect(isHardwareKeydown(kb("Fn"), input)).toBe(false);
  });

  it("never counts composing, 229, Unidentified, Process or Dead", () => {
    expect(isHardwareKeydown(kb("a", { isComposing: true }), document.body)).toBe(false);
    expect(isHardwareKeydown(kb("a", { keyCode: 229 }), document.body)).toBe(false);
    for (const key of ["Unidentified", "Process", "Dead"]) expect(isHardwareKeydown(kb(key), document.body), key).toBe(false);
  });
});
