/**
 * Settings → Updates · "Names from before the rename" (`LegacyNamesSummary`).
 *
 * Two things are worth holding:
 *  1. **It is invisible while the app's name is unchanged** — the backend
 *     answers `renamed: false` and the panel must not grow a section.
 *  2. After a rename it lists what the fallback log counted and which steps
 *     are not done, and says so plainly when the log is empty.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { LegacyNamesSummary, type LegacyNameStatus } from "../../components/layout/LegacyNamesSummary";
import { en } from "../../lib/i18n";

const invokeMock = vi.mocked(invoke);

function answer(status: LegacyNameStatus | null) {
  invokeMock.mockImplementation(((command: string) =>
    Promise.resolve(command === "legacy_name_status" ? status : null)) as typeof invoke);
}

describe("LegacyNamesSummary", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders nothing while the app's name is unchanged", async () => {
    answer({ renamed: false, hits: [], unfinished: [] });
    const { container } = render(<LegacyNamesSummary />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("legacy_name_status"));
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the backend has no answer", async () => {
    answer(null);
    const { container } = render(<LegacyNamesSummary />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("lists the counted lookups and the unfinished steps after a rename", async () => {
    answer({
      renamed: true,
      hits: [{ id: "tmux-prefix", count: 4, first: "2026-10-01T08:00:00+00:00", last: "2026-10-03T09:30:00+00:00" }],
      unfinished: [{ id: "mail-store", state: "pending", note: "waits for the mail store" }],
    });
    render(<LegacyNamesSummary />);
    expect(await screen.findByText(en["updates.legacyTitle"])).toBeTruthy();
    expect(screen.getByText(/tmux-prefix: 4 .*2026-10-03/)).toBeTruthy();
    expect(screen.getByText("mail-store: waits for the mail store")).toBeTruthy();
    expect(screen.queryByText(en["updates.legacyNone"])).toBeNull();
  });

  it("says so when nothing was found under the old name", async () => {
    answer({ renamed: true, hits: [], unfinished: [] });
    render(<LegacyNamesSummary />);
    expect(await screen.findByText(en["updates.legacyNone"])).toBeTruthy();
  });
});
