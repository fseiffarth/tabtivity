/**
 * A hold on one of a conversation's file cards — a tile of the Files list, a
 * post the agent sent, a card in a prompt or under an answer — opens that
 * file's menu: Save, Share, and Delete for what the agent or the phone sent,
 * which asks once more first. A tap still opens the file.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentFileHold, SentFilesGroups, useSentFileMenu, type SentFile } from "../../../mobile-web/src/components/SentFilesIndex";
import { OutboxPost } from "../../../mobile-web/src/components/OutboxPost";
import { InboxAlbum } from "../../../mobile-web/src/components/InboxPreview";
import type { OutboxFile } from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

const now = Math.floor(Date.now() / 1000);
const file = (name: string, kind: string): OutboxFile => ({ name, kind, size: 2048, modified: now - 60 } as OutboxFile);
const SENT: SentFile = { file: file("plot.png", "image/png"), from: "agent" };
const MINE: SentFile = { file: file("20261122-120117-photo.jpg", "image/jpeg"), from: "phone" };
const GUIDE = file("build_guide.pdf", "application/pdf");

const hold = (name: RegExp) => fireEvent.contextMenu(screen.getByRole("button", { name }));
const sheet = () => screen.getByRole("dialog");
const option = (name: string) => within(sheet()).queryByRole("button", { name });

/** The chat as `Terminal` draws it: the menu provided over its cards. */
function Chat({ onRemove, children }: { onRemove: (row: SentFile) => Promise<void>; children: React.ReactNode }) {
  const menu = useSentFileMenu({ tabId: "tab-7", project: "p1", onRemove });
  return <SentFileHold.Provider value={menu.hold}>{children}{menu.sheet}</SentFileHold.Provider>;
}

describe(`${BRAND.display} Mobile: a hold on a conversation's file asks what to do with it`, () => {
  afterEach(cleanup);

  it("offers Save and Delete for what the agent sent, asks once more, then removes it", async () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn(() => Promise.resolve());
    render(<SentFilesGroups tabId="tab-7" files={[SENT, MINE]} onOpen={onOpen} onRemove={onRemove} />);

    hold(/plot\.png/);
    expect(option("Save")).toBeTruthy();
    // A tap already opens it: the hold's menu does not offer it again.
    expect(option("Open")).toBeNull();
    fireEvent.click(option("Delete")!);
    // The same sheet asks; Keep goes back without deleting.
    expect(within(sheet()).getByText("Delete plot.png?")).toBeTruthy();
    fireEvent.click(option("Keep")!);
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(option("Delete")!);
    await act(async () => { fireEvent.click(option("Delete")!); });
    expect(onRemove).toHaveBeenCalledWith(SENT);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The hold itself never opened the file.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("deletes what the phone sent too, and a failed delete says so", async () => {
    const onRemove = vi.fn(() => Promise.reject(new Error("gone")));
    render(<SentFilesGroups tabId="tab-7" files={[SENT, MINE]} onOpen={() => {}} onRemove={onRemove} />);

    hold(/photo\.jpg/);
    fireEvent.click(option("Delete")!);
    await act(async () => { fireEvent.click(option("Delete")!); });
    expect(onRemove).toHaveBeenCalledWith(MINE);
    expect(within(sheet()).getByRole("alert").textContent).toBe("The file could not be deleted.");
  });

  it("still opens on a plain tap", () => {
    const onOpen = vi.fn();
    render(<SentFilesGroups tabId="tab-7" files={[SENT]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /plot\.png/ }));
    expect(onOpen).toHaveBeenCalledWith(SENT);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the same menu on a single card the agent sent in the chat", async () => {
    const onRemove = vi.fn(() => Promise.resolve());
    const onOpen = vi.fn();
    const post = { key: "p", files: [GUIDE] } as unknown as Parameters<typeof OutboxPost>[0]["post"];
    render(<Chat onRemove={onRemove}>
      <OutboxPost scope={{ tab: "tab-7" }} post={post} onOpen={onOpen} />
    </Chat>);

    hold(/build_guide\.pdf/);
    expect(within(sheet()).getByRole("heading", { name: "build_guide.pdf" })).toBeTruthy();
    expect(option("Save")).toBeTruthy();
    fireEvent.click(option("Delete")!);
    await act(async () => { fireEvent.click(option("Delete")!); });
    expect(onRemove).toHaveBeenCalledWith({ file: GUIDE, from: "agent" });
    expect(onOpen).not.toHaveBeenCalled();

    // A tap on the card still opens it.
    fireEvent.click(screen.getByRole("button", { name: /build_guide\.pdf/ }));
    expect(onOpen).toHaveBeenCalledWith(GUIDE);
  });

  it("a prompt's card hands its own file to the hold", () => {
    const onHold = vi.fn();
    render(<InboxAlbum tabId="tab-7" leaves={[MINE.file.name]} files={new Map([[MINE.file.name, MINE.file]])} onOpen={() => {}} onHold={onHold} />);
    hold(/photo\.jpg/);
    expect(onHold).toHaveBeenCalledWith(MINE.file);
  });
});
