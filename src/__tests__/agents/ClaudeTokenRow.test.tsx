/**
 * Settings → Manage CLIs → Claude's long-lived token (`ClaudeTokenRow`,
 * backend `claude_token_*`).
 *
 * What has to hold:
 *
 *  1. **Two places, one state.** The row sits in Accounts & keys and, without
 *     its title line, in Claude's card. A save in one re-reads the other, so
 *     the two never disagree about whether a token is saved.
 *  2. **The card copy keeps the explanation.** Without the title line (and its
 *     "?" tooltip) the help shows as a line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { ClaudeTokenRow } from "../../components/settings/ClaudeTokenRow";
import { enSource as en } from "../../lib/i18n/en";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);
// Placeholder words only: never a real-looking token shape.
const FAKE_TOKEN = "fake-token-words";

let saved = false;

beforeEach(() => {
  saved = false;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "claude_token_status") {
      return Promise.resolve({ saved, inUse: saved, remote: false, revision: saved ? 1 : 0 });
    }
    if (cmd === "claude_token_save") {
      saved = true;
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
});

afterEach(cleanup);

describe("ClaudeTokenRow", () => {
  it("a save in one copy re-reads the other", async () => {
    render(
      <>
        <ClaudeTokenRow />
        <ClaudeTokenRow heading={false} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText(en["settings.claudeTokenNone"])).toHaveLength(2));

    const [field] = screen.getAllByLabelText(en["settings.claudeTokenPaste"]);
    fireEvent.change(field, { target: { value: FAKE_TOKEN } });
    fireEvent.click(screen.getAllByRole("button", { name: en["settings.claudeTokenSave"] })[0]);

    await waitFor(() => expect(screen.getAllByText(en["settings.claudeTokenInUse"])).toHaveLength(2));
    expect(screen.queryByText(en["settings.claudeTokenNone"])).toBeNull();
  });

  it("without the title line the help shows as a line", async () => {
    render(<ClaudeTokenRow heading={false} />);
    await waitFor(() => expect(screen.getByText(en["settings.claudeTokenNone"])).toBeTruthy());
    expect(screen.queryByText(en["settings.claudeToken"])).toBeNull();
    expect(screen.getByText(en["settings.claudeTokenHelp"].replace("{app}", BRAND.display), { exact: false })).toBeTruthy();
  });
});
