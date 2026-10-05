/**
 * `RenameSheet` on its own (the Project screen's rename flow is covered by
 * MobileTabRename). What lives here is the sheet's own contract: the length
 * cap that mirrors the desktop's catalog truncation, Enter as Save, the
 * desktop-closed failure named as such, and that a cancel sends nothing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_TAB_LABEL, type TabRow } from "../../../mobile-web/src/api";
import { RenameSheet } from "../../../mobile-web/src/screens/RenameSheet";
import { BRAND } from "../../lib/brand";

const tab: TabRow = { id: "t/agent 1", label: "Claude", kind: "agent", available: true, viewer_busy: false };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const puts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");

describe("Mobile rename sheet", () => {
  it("PUTs the trimmed label against the URL-encoded tab id and hands back the stored label", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tab: { ...tab, label: "Stored" } }), { status: 200 }));
    const onRenamed = vi.fn();
    render(<RenameSheet tab={tab} onClose={() => {}} onRenamed={onRenamed} />);
    fireEvent.change(screen.getByLabelText("Tab name"), { target: { value: "  Review  " } });
    fireEvent.keyDown(screen.getByLabelText("Tab name"), { key: "Enter" });
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Stored"));
    const [url, init] = puts()[0];
    expect(String(url)).toBe("/api/v1/tabs/t%2Fagent%201");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ label: "Review" });
  });

  it("falls back to the typed label when the desktop answers without one", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const onRenamed = vi.fn();
    render(<RenameSheet tab={tab} onClose={() => {}} onRenamed={onRenamed} />);
    fireEvent.change(screen.getByLabelText("Tab name"), { target: { value: "Plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Plain"));
  });

  it("refuses a label past the desktop's cap without a request, counting code points", () => {
    render(<RenameSheet tab={tab} onClose={() => {}} onRenamed={() => {}} />);
    const field = screen.getByLabelText("Tab name") as HTMLInputElement;
    expect(field.maxLength).toBe(MAX_TAB_LABEL);
    // An emoji is one character to the reader and two UTF-16 units to `.length`;
    // the cap counts the former, so this exactly-at-cap label is accepted...
    fireEvent.change(field, { target: { value: "🙂".repeat(MAX_TAB_LABEL) } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.queryByRole("alert")).toBeNull();
    // ...and one more is not.
    fireEvent.change(field, { target: { value: "🙂".repeat(MAX_TAB_LABEL + 1) } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain(`${MAX_TAB_LABEL} characters`);
    expect(puts().filter(([, init]) => JSON.parse(String((init as RequestInit).body)).label.length > MAX_TAB_LABEL * 2)).toHaveLength(0);
  });

  it(`says to open desktop ${BRAND.display} on a 503, and something generic on any other failure`, async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    render(<RenameSheet tab={tab} onClose={() => {}} onRenamed={() => {}} />);
    fireEvent.change(screen.getByLabelText("Tab name"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(`Open desktop ${BRAND.display} to rename a tab.`);
    // The form is usable again afterwards.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The tab could not be renamed."));
  });

  it("closes on Cancel, ✕ and the backdrop — but not on a tap inside the sheet — and sends nothing", () => {
    const onClose = vi.fn();
    render(<RenameSheet tab={tab} onClose={onClose} onRenamed={() => {}} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
