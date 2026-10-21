/**
 * What a click on a mail row does — and, mostly, what it must *not* do.
 *
 * Three rules of the list are pinned down here, and each of them was a
 * deliberate change of behaviour rather than a detail:
 *
 *  - **A right-click does not open the message.** It used to, so the menu and
 *    the message pane could not disagree about which mail was about to be
 *    filed — but opening a message marks it read and fetches its body, which is
 *    exactly what someone reaching for a menu on a row in the unread pile does
 *    not want. The row is *ticked* instead, which is the same guarantee.
 *  - **A modified click picks rows without opening any of them.** Building a
 *    selection of ten messages must not fetch ten bodies and mark ten read.
 *  - **The menu acts on the whole selection**, and says so — it names the count
 *    instead of one subject, and its delete row says where the mail is going,
 *    since "delete" means Trash for some rows and the server's own expunge for
 *    others and only one of the two can be taken back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { MailList, type MailCheckMode } from "../../components/mail/MailList";
import { translate, type TranslationKey } from "../../lib/i18n";
import type { MailHeader } from "../../types/mail";

const t = (key: string, vars?: Record<string, string | number>) =>
  translate("en", key as TranslationKey, vars);

function header(over: Partial<MailHeader> & { id: string }): MailHeader {
  return {
    account_id: "a1",
    folder_id: "a1|INBOX",
    uid: 1,
    subject: `subject ${over.id}`,
    from: { address: "sender@example.com" },
    to: [],
    cc: [],
    date: "2026-07-01T09:00:00Z",
    seen: true,
    flagged: false,
    answered: false,
    has_attachments: false,
    size: 10,
    preview: "",
    ...over,
  };
}

const HEADERS = ["m1", "m2", "m3"].map((id) => header({ id }));

interface Calls {
  opened: string[];
  checks: Array<{ id: string; mode: MailCheckMode }>;
  deleted: string[][];
  drags: Array<string[] | null>;
}

function renderList(over: { headers?: MailHeader[]; checkedIds?: string[]; purged?: number; query?: string; searchRemote?: boolean; searchPartial?: boolean } = {}) {
  const calls: Calls = { opened: [], checks: [], deleted: [], drags: [] };
  render(
    <MailList
      headers={over.headers ?? HEADERS}
      selectedId={null}
      checkedIds={over.checkedIds ?? []}
      loading={false}
      onOpen={(id) => calls.opened.push(id)}
      onCheck={(h, mode) => calls.checks.push({ id: h.id, mode })}
      onClearChecks={() => {}}
      onDragRows={(rows) => calls.drags.push(rows?.map((h) => h.id) ?? null)}
      onDelete={(rows) => calls.deleted.push(rows.map((h) => h.id))}
      deletePlan={(rows) => ({
        purged: over.purged ?? 0,
        trashed: rows.length - (over.purged ?? 0),
      })}
      onToggleFlag={() => {}}
      onToggleSeen={() => {}}
      onSetPriority={() => {}}
      sort="date"
      sortDesc
      onSort={() => {}}
      offset={0}
      pageSize={100}
      total={HEADERS.length}
      searchRemote={over.searchRemote}
      searchPartial={over.searchPartial}
      onPage={() => {}}
      query={over.query ?? ""}
      unreadOnly={false}
      onQuery={() => {}}
      onUnreadOnly={() => {}}
      onClearFilters={() => {}}
    />,
  );
  return calls;
}

/** The row carrying a message's subject. */
const row = (id: string) => screen.getByText(`subject ${id}`).closest(".mail-row") as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe("sender cell", () => {
  it("prints the name and, quieter, the addr-spec beside it", () => {
    renderList({
      headers: [header({ id: "m1", from: { name: "Ada Lovelace", address: "ada@example.com" } })],
    });
    const addr = screen.getByText("<ada@example.com>");
    expect(addr.className).toBe("mail-row-from-addr");
    expect(screen.getByText("Ada Lovelace").className).toBe("mail-row-from-name");
  });

  it("does not quieten the real address beside a name posing as one", () => {
    renderList({
      headers: [header({ id: "m1", from: { name: "support@bank.example", address: "a@evil.example" } })],
    });
    expect(screen.getByText("<a@evil.example>").className).toContain("loud");
  });

  it("badges the row with the sender's initial, coloured by address not name", () => {
    renderList({
      headers: [
        header({ id: "m1", from: { name: "PayPal", address: "service@paypal.example" } }),
        header({ id: "m2", from: { name: "PayPal", address: "a@evil.example" } }),
        header({ id: "m3", from: { name: "Someone else", address: "service@paypal.example" } }),
      ],
    });
    const badge = (id: string) => row(id).querySelector(".mail-row-badge") as HTMLElement;
    expect(badge("m1").textContent).toBe("P");
    expect(badge("m3").textContent).toBe("S");
    const color = (id: string) => badge(id).style.getPropertyValue("--sender-color");
    expect(color("m1")).toBe(color("m3"));
    expect(color("m1")).not.toBe(color("m2"));
  });

  it("prints a bare address once", () => {
    renderList();
    expect(row("m1").querySelector(".mail-row-from")?.textContent).toBe("sender@example.com");
  });
});

describe("search coverage note", () => {
  it("says when older server matches may be missing", () => {
    renderList({ query: "invoice", searchRemote: true, searchPartial: true });
    expect(screen.getByText(t("mail.searchPartial"))).toBeTruthy();
    expect(screen.queryByText(t("mail.searchRemote"))).toBeNull();
  });
});

describe("clicking a row", () => {
  it("selects the message without opening or marking it read", async () => {
    const calls = renderList();
    await userEvent.click(row("m2"));
    expect(calls.opened).toEqual([]);
    expect(calls.checks).toEqual([{ id: "m2", mode: "only" }]);
  });

  it("opens once on double-click", async () => {
    const calls = renderList();
    await userEvent.dblClick(row("m2"));
    expect(calls.opened).toEqual(["m2"]);
  });

  it("does not open on a modified double-click", () => {
    const calls = renderList();
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey"]) {
      fireEvent.doubleClick(row("m2"), { [modifier]: true });
    }
    expect(calls.opened).toEqual([]);
  });

  it("Enter opens while Space only selects", () => {
    const calls = renderList();
    fireEvent.keyDown(row("m2"), { key: " " });
    expect(calls.opened).toEqual([]);
    expect(calls.checks).toEqual([{ id: "m2", mode: "only" }]);
    fireEvent.keyDown(row("m2"), { key: "Enter" });
    expect(calls.opened).toEqual(["m2"]);
  });

  it("Delete applies to the selected set", () => {
    const calls = renderList({ checkedIds: ["m1", "m3"] });
    fireEvent.keyDown(row("m3"), { key: "Delete" });
    expect(calls.deleted).toEqual([["m1", "m3"]]);
  });

  it("Delete uses the selection even when focus remains on a deselected row", () => {
    const calls = renderList({ checkedIds: ["m1", "m3"] });
    fireEvent.keyDown(row("m2"), { key: "Delete" });
    expect(calls.deleted).toEqual([["m1", "m3"]]);
  });

  it("embedded buttons never open the message on Enter or double-click", () => {
    const calls = renderList();
    const flag = row("m1").querySelector("button")!;
    fireEvent.keyDown(flag, { key: "Enter" });
    fireEvent.doubleClick(flag);
    expect(calls.opened).toEqual([]);
  });

  // `fireEvent` rather than `userEvent` for the modified clicks: the modifier
  // has to ride on the click event itself, and a separate `userEvent.keyboard`
  // call holds no key down for the next one.
  it("ctrl-click picks the row and opens nothing", () => {
    const calls = renderList();
    fireEvent.click(row("m2"), { ctrlKey: true });
    expect(calls.opened).toEqual([]);
    expect(calls.checks).toEqual([{ id: "m2", mode: "toggle" }]);
  });

  it("shift-click asks for a range and opens nothing", () => {
    const calls = renderList();
    fireEvent.click(row("m3"), { shiftKey: true });
    expect(calls.opened).toEqual([]);
    expect(calls.checks).toEqual([{ id: "m3", mode: "range" }]);
  });
});

describe("right-clicking a row", () => {
  it("does not open the message", async () => {
    const calls = renderList();
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m2") });
    expect(calls.opened).toEqual([]);
    // Ticked instead, so the menu visibly names what it will act on.
    expect(calls.checks).toEqual([{ id: "m2", mode: "only" }]);
  });

  it("leaves an existing selection alone when the row is part of it", async () => {
    const calls = renderList({ checkedIds: ["m1", "m2"] });
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m2") });
    expect(calls.checks).toEqual([]);
    expect(calls.opened).toEqual([]);
  });

  it("names one subject for one row", async () => {
    renderList();
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m2") });
    expect(screen.getByText("subject m2", { selector: ".context-menu-quote" })).toBeTruthy();
  });

  it("names the count when the menu covers the whole selection", async () => {
    renderList({ checkedIds: ["m1", "m2"] });
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m1") });
    // Scoped to the menu's own caption: the selection strip prints the same
    // count above the rows.
    expect(
      screen.getByText(t("mail.selectedCount", { count: 2 }), {
        selector: ".context-menu-quote",
      }),
    ).toBeTruthy();
  });
});

describe("the menu's delete", () => {
  it("offers a move to Trash, and says the mail is recoverable", async () => {
    renderList();
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m1") });
    expect(screen.getByText(t("mail.moveToTrash"))).toBeTruthy();
    expect(screen.getByText(t("mail.deleteGoesToTrash"))).toBeTruthy();
    expect(document.querySelector(".context-menu-danger-zone")).toBeNull();
  });

  it("says permanent, in the danger zone, when there is no Trash to fall back on", async () => {
    renderList({ purged: 1 });
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m1") });
    expect(screen.getByText(t("mail.deleteForever"))).toBeTruthy();
    expect(screen.getByText(t("mail.deleteIsForever"))).toBeTruthy();
    expect(document.querySelector(".context-menu-danger-zone")).toBeTruthy();
  });

  it("names how many of a mixed set cannot be taken back", async () => {
    renderList({ checkedIds: ["m1", "m2"], purged: 1 });
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m1") });
    expect(screen.getByText(t("mail.deleteMixed", { count: 2 }))).toBeTruthy();
    expect(screen.getByText(t("mail.deleteMixedNote", { count: 1 }))).toBeTruthy();
  });

  it("deletes the whole selection, not the row under the cursor", async () => {
    const calls = renderList({ checkedIds: ["m1", "m3"] });
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m1") });
    await userEvent.click(screen.getByText(t("mail.moveToTrash")));
    expect(calls.deleted).toEqual([["m1", "m3"]]);
  });

  it("deletes one row when the menu was opened outside the selection", async () => {
    const calls = renderList({ checkedIds: ["m1", "m3"] });
    await userEvent.pointer({ keys: "[MouseRight]", target: row("m2") });
    await userEvent.click(screen.getByText(t("mail.moveToTrash")));
    expect(calls.deleted).toEqual([["m2"]]);
  });
});

describe("the selection strip", () => {
  it("appears only once more than one row is ticked", () => {
    renderList({ checkedIds: ["m1"] });
    expect(document.querySelector(".mail-list-selection")).toBeNull();
  });

  it("counts the ticked rows that are actually on this page", () => {
    renderList({ checkedIds: ["m1", "m2", "gone"] });
    expect(screen.getByText(t("mail.selectedCount", { count: 2 }))).toBeTruthy();
  });
});

describe("the row's ✕", () => {
  const deleteBtn = (id: string) => row(id).querySelector(".mail-delete-btn") as HTMLElement;

  it("deletes that row and opens nothing", async () => {
    const calls = renderList();
    await userEvent.click(deleteBtn("m2"));
    expect(calls.deleted).toEqual([["m2"]]);
    expect(calls.opened).toEqual([]);
    expect(calls.checks).toEqual([]);
  });

  it("deletes only its own row even inside a ticked set", async () => {
    const calls = renderList({ checkedIds: ["m1", "m2", "m3"] });
    await userEvent.click(deleteBtn("m2"));
    expect(calls.deleted).toEqual([["m2"]]);
  });

  it("says in its tooltip whether the delete is permanent", () => {
    renderList({ purged: 1 });
    expect(deleteBtn("m1").title).toBe(t("mail.deleteForever"));
  });

  it("says Trash when there is one", () => {
    renderList();
    expect(deleteBtn("m1").title).toBe(t("mail.moveToTrash"));
  });
});

describe("dragging rows", () => {
  // Pointer-driven (no HTML5 DnD on WebKitGTK), so the gesture is plain
  // pointer events on the row and the window.
  const pointer = (type: string, x: number, el: EventTarget = window) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, { clientX: x, clientY: 10, button: 0, pointerId: 1 });
    act(() => {
      el.dispatchEvent(ev);
    });
  };
  const savedEFP = document.elementFromPoint;
  beforeEach(() => {
    document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  });
  afterEach(() => {
    document.elementFromPoint = savedEFP;
  });

  it("carries the whole selection without opening it or changing the selection", () => {
    const calls = renderList({ checkedIds: ["m1", "m3"] });
    pointer("pointerdown", 10, row("m3"));
    pointer("pointermove", 60);
    expect(calls.drags).toEqual([["m1", "m3"]]);
    pointer("pointerup", 60);
    fireEvent.click(row("m3"));
    expect(calls.checks).toEqual([]);
    expect(calls.opened).toEqual([]);
    expect(calls.drags).toEqual([["m1", "m3"], null]);
    // A later ordinary click still replaces the selection.
    pointer("pointerdown", 10, row("m2"));
    pointer("pointerup", 10);
    fireEvent.click(row("m2"));
    expect(calls.checks).toEqual([{ id: "m2", mode: "only" }]);
  });

  it("dragging outside the selection carries only the dragged row", () => {
    const calls = renderList({ checkedIds: ["m1", "m3"] });
    pointer("pointerdown", 10, row("m2"));
    pointer("pointermove", 60);
    pointer("pointerup", 60);
    expect(calls.drags).toEqual([["m2"], null]);
    expect(calls.checks).toEqual([{ id: "m2", mode: "only" }]);
    expect(calls.opened).toEqual([]);
  });

  it("cannot start a row drag from an embedded button", () => {
    const calls = renderList();
    pointer("pointerdown", 10, row("m1").querySelector("button")!);
    pointer("pointermove", 60);
    pointer("pointerup", 60);
    expect(calls.drags).toEqual([]);
  });
});
