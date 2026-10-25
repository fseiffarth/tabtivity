import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installNativeContextMenuGuard } from "../../lib/window/nativeContextMenuGuard";

function fire(target: EventTarget): Event {
  const e = new Event("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("installNativeContextMenuGuard", () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installNativeContextMenuGuard();
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
  });

  it("cancels a right-click nothing handled, so WebKit shows no Back/Reload menu", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    expect(fire(pane).defaultPrevented).toBe(true);
  });

  it("leaves editable targets their native Cut/Copy/Paste menu", () => {
    const field = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editor.appendChild(inner);
    document.body.append(field, editor);
    expect(fire(field).defaultPrevented).toBe(false);
    expect(fire(inner).defaultPrevented).toBe(false);
  });

  it("is a no-op once uninstalled", () => {
    uninstall();
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    expect(fire(pane).defaultPrevented).toBe(false);
    uninstall = installNativeContextMenuGuard();
  });
});
