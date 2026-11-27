import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const invoke = vi.fn((..._a: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { LinkOpenHost } from "../../components/common/LinkOpenHost";
import { openExternalUrl, useLinkAsks } from "../../lib/externalLinks";

const URL = "https://llmrun.dev/device/amd-ryzen-ai-9-hx-370-strix-point";
const opened = () => invoke.mock.calls.filter((c) => c[0] === "open_external_url");

afterEach(() => {
  cleanup();
  invoke.mockClear();
  useLinkAsks.setState({ asks: [] });
});

describe("LinkOpenHost", () => {
  it("shows the exact address and opens nothing until Open link", async () => {
    render(<LinkOpenHost />);
    let result!: Promise<boolean>;
    act(() => {
      result = openExternalUrl(URL);
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(URL);
    expect(dialog.textContent).toContain("llmrun.dev");
    expect(opened()).toHaveLength(0);
    await act(async () => within(dialog).getByRole("button", { name: "Open link" }).click());
    await expect(result).resolves.toBe(true);
    expect(opened()).toEqual([["open_external_url", { url: URL }]]);
  });

  it("Cancel opens nothing", async () => {
    render(<LinkOpenHost />);
    let result!: Promise<boolean>;
    act(() => {
      result = openExternalUrl(URL);
    });
    await act(async () => within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }).click());
    await expect(result).resolves.toBe(false);
    expect(opened()).toHaveLength(0);
  });

  it("asks for a target=_blank link no handler took, and leaves a handled one alone", () => {
    const { container } = render(
      <>
        <LinkOpenHost />
        <a href={URL} target="_blank" rel="noreferrer">doc</a>
        <a href="https://example.org/x" target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>
          handled
        </a>
        <a href="https://example.org/self">same window</a>
      </>,
    );
    const [blank, handled, plain] = Array.from(container.querySelectorAll("a"));
    fireEvent.click(handled);
    fireEvent.click(plain);
    expect(useLinkAsks.getState().asks).toHaveLength(0);
    act(() => {
      fireEvent.click(blank);
    });
    expect(useLinkAsks.getState().asks.map((a) => a.url)).toEqual([URL]);
    expect(opened()).toHaveLength(0);
  });
});
