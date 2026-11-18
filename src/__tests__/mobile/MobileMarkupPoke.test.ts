// The Mobile host's `refresh` poke for the `markup` slice (a tab it spawned
// asked or ticked, `docs/headless_mcp_plan.md` phase 1b) must reach the
// window's markup views the way its own listener's change does: as
// `markup-mcp-changed`, which `usePdfMarkup` and the cockpit re-read on.
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("../../components/files/useAlertsFeed", () => ({ useAlertsFeed: () => ({ enabled: false, items: [] }) }));

import { emitMarkupChanged } from "../../components/mobile/MobileBridgeHost";
import { MARKUP_MCP_CHANGED } from "../../lib/viewers/markupQuestions";

describe("the markup poke", () => {
  afterEach(() => vi.restoreAllMocks());

  it("broadcasts the event the markup views listen for", async () => {
    vi.mocked(emit).mockResolvedValue(undefined);
    await emitMarkupChanged();
    expect(emit).toHaveBeenCalledWith(MARKUP_MCP_CHANGED);
    expect(MARKUP_MCP_CHANGED).toBe("markup-mcp-changed");
  });

  it("never throws when the event cannot be sent", async () => {
    vi.mocked(emit).mockRejectedValue(new Error("no IPC"));
    await expect(emitMarkupChanged()).resolves.toBeUndefined();
  });
});
