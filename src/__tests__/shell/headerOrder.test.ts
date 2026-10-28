import { describe, expect, it } from "vitest";
import { isHeaderPinned, moveHeaderItem, orderedHeaderIds, placedGroupOf, resetHeaderGroup, setHeaderPin } from "../../lib/headerPins";

describe("header icon order", () => {
  it("follows the built-in order until the user drags", () => {
    expect(orderedHeaderIds("apps", undefined)).toEqual(["mail", "calendar", "todo", "inbox", "models", "help", "settings"]);
  });

  it("moves an icon in front of another and keeps the rest", () => {
    const order = moveHeaderItem(undefined, "inbox", "mail");
    expect(order.slice(0, 4)).toEqual(["inbox", "mail", "calendar", "todo"]);
    expect(orderedHeaderIds("apps", order).slice(0, 4)).toEqual(["inbox", "mail", "calendar", "todo"]);
  });

  it("drops an icon at the end of its group", () => {
    expect(orderedHeaderIds("apps", moveHeaderItem(undefined, "models", null)).pop()).toBe("models");
  });

  it("leaves other groups' entries alone and ignores unknown ids", () => {
    const order = moveHeaderItem(["todo", "mail", "bogus"], "vpn", "alerts");
    expect(orderedHeaderIds("apps", order)).toEqual(["todo", "mail", "calendar", "inbox", "models", "help", "settings"]);
    expect(orderedHeaderIds("status", order)[0]).toBe("vpn");
  });

  it("resets one group", () => {
    const order = moveHeaderItem(moveHeaderItem(undefined, "inbox", "mail"), "vpn", "alerts");
    expect(orderedHeaderIds("apps", resetHeaderGroup(order, "apps"))).toEqual(["mail", "calendar", "todo", "inbox", "models", "help", "settings"]);
    expect(orderedHeaderIds("status", resetHeaderGroup(order, "apps"))[0]).toBe("vpn");
  });

  it("moves an icon across groups and back", () => {
    const order = moveHeaderItem(undefined, "vpn", "mail", "apps");
    expect(orderedHeaderIds("apps", order)[0]).toBe("vpn");
    expect(orderedHeaderIds("status", order)).not.toContain("vpn");
    expect(placedGroupOf("vpn", order)).toBe("apps");
    const back = moveHeaderItem(order, "vpn", null, "status");
    expect(orderedHeaderIds("status", back).pop()).toBe("vpn");
    expect(orderedHeaderIds("apps", back)).not.toContain("vpn");
  });

  it("reset takes a dragged-in icon back to its own group", () => {
    const order = moveHeaderItem(undefined, "mail", "alerts", "status");
    expect(orderedHeaderIds("status", order)[0]).toBe("mail");
    expect(orderedHeaderIds("status", resetHeaderGroup(order, "status"))).not.toContain("mail");
    expect(orderedHeaderIds("apps", resetHeaderGroup(order, "status"))[0]).toBe("mail");
  });

  it("keeps the connection and battery readouts out of the apps run", () => {
    const order = moveHeaderItem(undefined, "battery", "mail", "apps");
    expect(orderedHeaderIds("apps", order)).not.toContain("battery");
    expect(placedGroupOf("battery", order)).toBe("status");
    // An order saved by a build that let them across reads back in status.
    expect(placedGroupOf("conn", ["apps:conn"])).toBe("status");
    expect(orderedHeaderIds("status", ["apps:conn"])[0]).toBe("conn");
  });

  it("folds the settings gear like any other icon", () => {
    expect(isHeaderPinned(undefined, "settings")).toBe(true);
    expect(isHeaderPinned(setHeaderPin(undefined, "settings", false), "settings")).toBe(false);
  });

  it("setHeaderPin only changes what differs", () => {
    expect(setHeaderPin(undefined, "battery", false)).toEqual({});
    expect(setHeaderPin(undefined, "battery", true)).toEqual({ battery: true });
    expect(setHeaderPin({ battery: true }, "battery", false)).toEqual({});
  });
});
