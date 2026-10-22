import { describe, expect, it } from "vitest";
import { moveHeaderItem, orderedHeaderIds, resetHeaderGroup } from "../../lib/headerPins";

describe("header icon order", () => {
  it("follows the built-in order until the user drags", () => {
    expect(orderedHeaderIds("apps", undefined)).toEqual(["mail", "calendar", "todo", "inbox"]);
  });

  it("moves an icon in front of another and keeps the rest", () => {
    const order = moveHeaderItem(undefined, "inbox", "mail");
    expect(order).toEqual(["inbox", "mail", "calendar", "todo"]);
    expect(orderedHeaderIds("apps", order)).toEqual(["inbox", "mail", "calendar", "todo"]);
  });

  it("drops an icon at the end of its group", () => {
    expect(orderedHeaderIds("menus", moveHeaderItem(undefined, "models", null))).toEqual(["help", "models"]);
  });

  it("leaves other groups' entries alone and ignores unknown ids", () => {
    const order = moveHeaderItem(["todo", "mail", "bogus"], "vpn", "alerts");
    expect(orderedHeaderIds("apps", order)).toEqual(["todo", "mail", "calendar", "inbox"]);
    expect(orderedHeaderIds("status", order)[0]).toBe("vpn");
  });

  it("resets one group", () => {
    const order = moveHeaderItem(moveHeaderItem(undefined, "inbox", "mail"), "vpn", "alerts");
    expect(orderedHeaderIds("apps", resetHeaderGroup(order, "apps"))).toEqual(["mail", "calendar", "todo", "inbox"]);
    expect(orderedHeaderIds("status", resetHeaderGroup(order, "apps"))[0]).toBe("vpn");
  });
});
