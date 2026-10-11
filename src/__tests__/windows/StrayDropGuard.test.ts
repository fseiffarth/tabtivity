import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installStrayDropGuard } from "../../lib/window/strayDropGuard";

function fire(target: EventTarget, type: string): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("installStrayDropGuard", () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installStrayDropGuard();
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  it("cancels a drop nothing handled, so WebKit cannot navigate to the file", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    for (const type of ["dragenter", "dragover", "drop"]) {
      expect(fire(pane, type).defaultPrevented).toBe(true);
    }
  });

  it("leaves drops onto editable targets to the editor", () => {
    const field = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editor.appendChild(inner);
    document.body.append(field, editor);
    expect(fire(field, "drop").defaultPrevented).toBe(false);
    expect(fire(inner, "dragover").defaultPrevented).toBe(false);
  });

  it("is a no-op once uninstalled", () => {
    uninstall();
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    expect(fire(pane, "drop").defaultPrevented).toBe(false);
    uninstall = installStrayDropGuard();
  });
});
