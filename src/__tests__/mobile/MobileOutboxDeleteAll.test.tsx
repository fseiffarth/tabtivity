/**
 * The gallery's Delete all frees the space the outbox takes: one confirm, one
 * `DELETE …/outbox`, and the whole folder goes — past the 40 the sidecar
 * lists too, which is why a full list shows its size with a "+".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutboxGallery } from "../../../mobile-web/src/components/OutboxGallery";
import { clearOutbox, type OutboxFile } from "../../../mobile-web/src/api";

const file = (i: number): OutboxFile => ({ name: `p${i}.txt`, kind: "text/plain", size: 1024 * 1024, modified: 1_770_000_000 + i });

function gallery(files: OutboxFile[], onDeleteAll: () => Promise<void>) {
  return render(<OutboxGallery scope={{ project: "p1" }} files={files} onOpen={() => {}} onDetails={() => {}} onDeleteAll={onDeleteAll} onClose={() => {}} />);
}

describe("Mobile outbox — Delete all", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks once, then clears; Keep clears nothing", async () => {
    const onDeleteAll = vi.fn(() => Promise.resolve());
    gallery([file(1), file(2)], onDeleteAll);

    fireEvent.click(screen.getByRole("button", { name: "Delete all (2.0 MB)" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onDeleteAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete all (2.0 MB)" }));
    expect(screen.getByRole("group", { name: "Delete every file in the outbox?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    await waitFor(() => expect(onDeleteAll).toHaveBeenCalledTimes(1));
  });

  it("marks a full listing's size as a floor, and says so when the delete fails", async () => {
    gallery(Array.from({ length: 40 }, (_, i) => file(i)), () => Promise.reject(new Error("delete_failed")));
    fireEvent.click(screen.getByRole("button", { name: "Delete all (40.0 MB+)" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The files could not be deleted.");
  });

  it("sends one DELETE to the scope's outbox", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ removed: 3, freed: 42 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(clearOutbox({ tab: "t 1" })).resolves.toEqual({ removed: 3, freed: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/tabs/t%201/outbox");
    expect(init.method).toBe("DELETE");
  });
});
