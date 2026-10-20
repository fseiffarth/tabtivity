import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PromptPhoneChip } from "../../components/agents/PromptCard";
import type { SentAgentPrompt } from "../../stores/agents/agentPrompts";

const row: SentAgentPrompt = { id: "r", message: "fix it", created_at: "", sent_at: "", tab_label: "Claude", result: "delivered" };

describe("PromptPhoneChip", () => {
  afterEach(cleanup);

  it("names the phone a prompt came from, and says nothing for the desktop", () => {
    const view = render(<PromptPhoneChip row={{ ...row, phone_device: "phone-a", phone_name: "Pixel 9" }} />);
    expect(screen.getByTestId("prompt-phone-chip").textContent).toContain("Pixel 9");
    view.rerender(<PromptPhoneChip row={{ ...row, phone_device: "phone-gone" }} />);
    expect(screen.getByTestId("prompt-phone-chip").textContent).toContain("Unpaired phone");
    view.rerender(<PromptPhoneChip row={row} />);
    expect(screen.queryByTestId("prompt-phone-chip")).toBeNull();
  });
});
