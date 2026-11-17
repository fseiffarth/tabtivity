import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useChatLinks } from "../../../mobile-web/src/components/LinkSheet";
import { ArtifactSheet } from "../../../mobile-web/src/components/ArtifactSheet";
import { answerHtml, artifactTargetOf } from "../../../mobile-web/src/terminal/answerMarkdown";
import * as api from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

// The line Antigravity 1.5 wrote into a conversation's transcript (captured
// from a real chat): a plan it saved in its own `brain/<conversation>/` folder.
const ID = "ddb72054-fb3d-493d-8ddb-e7f6c32bb591";
const TARGET = `file:///home/user/.gemini/antigravity-cli/brain/${ID}/improve_antigravity_chat_mode.md`;
const ANSWER = `I have created a detailed implementation plan artifact:\n\n[improve_antigravity_chat_mode.md](${TARGET})\n`;

function Chat({ text, open }: { text: string; open?: (target: string) => void }) {
  const { links } = useChatLinks(undefined, open);
  return <div data-testid="bubble" {...links} dangerouslySetInnerHTML={{ __html: answerHtml(text) }} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe(`${BRAND.display} Mobile Antigravity document links`, () => {
  it("recognises only a file link into a chat's brain folder", () => {
    expect(artifactTargetOf(TARGET)).toBe(TARGET);
    for (const other of [
      "file:///home/user/project/plan.md",
      `https://example.com/brain/${ID}/plan.md`,
      "file:///home/user/.gemini/antigravity-cli/brain/",
      `/home/user/.gemini/antigravity-cli/brain/${ID}/plan.md`,
      "", null, undefined,
    ]) expect(artifactTargetOf(other)).toBeNull();
  });

  it("marks the plan link a tap can open, and no address", () => {
    render(<Chat text={ANSWER} />);
    const link = screen.getByText("improve_antigravity_chat_mode.md");
    expect(link.getAttribute("data-artifact")).toBe(TARGET);
    expect(link.hasAttribute("data-href")).toBe(false);
  });

  it("leaves a link that goes nowhere unmarked", () => {
    render(<Chat text="See [the file](file:///home/user/project/plan.md) and [a bare one](nowhere)." />);
    for (const label of ["the file", "a bare one"]) {
      const link = screen.getByText(label);
      expect(link.hasAttribute("data-artifact")).toBe(false);
      expect(link.hasAttribute("data-href")).toBe(false);
      expect(link.hasAttribute("tabindex")).toBe(false);
    }
  });

  it("opens the document on a tap, with the target as written", () => {
    const open = vi.fn();
    render(<Chat text={ANSWER} open={open} />);
    fireEvent.click(screen.getByText("improve_antigravity_chat_mode.md"));
    expect(open).toHaveBeenCalledWith(TARGET);
  });

  it("does nothing on a tap where no document opener is wired", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Chat text={ANSWER} />);
    fireEvent.click(screen.getByText("improve_antigravity_chat_mode.md"));
    expect(open).not.toHaveBeenCalled();
  });
});

describe(`${BRAND.display} Mobile Antigravity document sheet`, () => {
  it("shows the document's text as formatted Markdown", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue({ name: "plan.md", text: "# Plan\n\n- one\n- two\n" });
    render(<ArtifactSheet tabId="tab1" target={TARGET} onClose={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(api.getArtifact).toHaveBeenCalledWith("tab1", TARGET, expect.anything());
    expect(screen.getByRole("dialog", { name: "plan.md" })).toBeTruthy();
  });

  it("says so when the document cannot be opened", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(null);
    render(<ArtifactSheet tabId="tab1" target={TARGET} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/could not be opened/u));
  });
});
