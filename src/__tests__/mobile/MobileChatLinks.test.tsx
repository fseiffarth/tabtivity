import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useChatLinks } from "../../../mobile-web/src/components/LinkSheet";
import { answerHtml, chatLinkUrl } from "../../../mobile-web/src/terminal/answerMarkdown";
import { BRAND } from "../../lib/brand";

function Chat({ text }: { text: string }) {
  const { links, sheet } = useChatLinks();
  return <><div data-testid="bubble" {...links} dangerouslySetInnerHTML={{ __html: answerHtml(text) }} />{sheet}</>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe(`${BRAND.display} Mobile chat links`, () => {
  it("accepts only absolute http(s) addresses without credentials", () => {
    expect(chatLinkUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(chatLinkUrl("http://example.com")).toBe("http://example.com/");
    expect(chatLinkUrl("https://bücher.example/")).toBe("https://xn--bcher-kva.example/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:a@b.c",
      "/relative", "example.com", "https://user:pw@example.com/", "https://bank.example@evil.example/", "", null]) {
      expect(chatLinkUrl(bad)).toBeNull();
    }
  });

  it("asks before opening a tapped link, and opens only on Open", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Chat text="See [the docs](https://example.com/docs?a=1)." />);
    fireEvent.click(screen.getByText("the docs"));
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("link-sheet-url").textContent).toBe("https://example.com/docs?a=1");
    fireEvent.click(screen.getByText("Open link"));
    expect(open).toHaveBeenCalledWith("https://example.com/docs?a=1", "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the real address, not the label, and closing opens nothing", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Chat text="[https://bank.example](https://evil.example/login)" />);
    // The label is autolinked inside the link; only the outer target counts.
    expect(document.querySelectorAll("[data-href]")).toHaveLength(1);
    fireEvent.click(screen.getByText("https://bank.example"));
    expect(screen.getByTestId("link-sheet-url").textContent).toBe("https://evil.example/login");
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves a file link and plain text alone", () => {
    render(<Chat text="[a file](src/a.ts) and words" />);
    fireEvent.click(screen.getByText("a file"));
    fireEvent.click(screen.getByText(/and words/));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
