/**
 * The annotator's text tool asks for its words in the app's own prompt
 * (`useDialogs`), not `window.prompt` — which WebKitGTK draws as a bare
 * origin-titled box. While the prompt is open, Escape cancels the text and
 * nothing else: the overlay's own capture-phase Escape ("discard and close")
 * would otherwise throw the whole drawing away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

import { ImageAnnotator } from "../../components/embed/ImageAnnotator";
import { translate } from "../../lib/i18n";

/** The prompt's title, by key: the wording is the dictionary's to change. */
const TITLE = translate("en", "imageAnnotator.annotationTextTitle");

const fillText = vi.fn();

beforeEach(() => {
  fillText.mockReset();
  vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("window.prompt must not be used"); });
  // jsdom has neither image decoding nor a 2D canvas: an image that loads at
  // once, and a context that records the one call this test is about.
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 40;
    naturalHeight = 30;
    width = 40;
    height = 30;
    set src(_: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({})),
    putImageData: vi.fn(),
    fillText,
  }) as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountOnText() {
  const onClose = vi.fn();
  const r = render(<ImageAnnotator src="blob:x" path="/p/a.png" fileName="a.png" onClose={onClose} />);
  await act(async () => {});
  fireEvent.click(screen.getByTitle("Text"));
  const overlay = r.container.querySelector(".image-annotator__canvas--overlay") as HTMLCanvasElement;
  await waitFor(() => expect(r.container.querySelector(".image-annotator__loading")).toBeNull());
  fireEvent.pointerDown(overlay, { clientX: 5, clientY: 5, pointerId: 1 });
  return { onClose };
}

describe("ImageAnnotator text tool", () => {
  it("asks for the text in the app's prompt and draws what was typed", async () => {
    const user = userEvent.setup();
    await mountOnText();
    const asked = await screen.findByRole("dialog", { name: TITLE });
    await user.type(within(asked).getByRole("textbox"), "look here");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fillText).toHaveBeenCalledTimes(1));
    expect(fillText.mock.calls[0][0]).toBe("look here");
  });

  it("Escape cancels the prompt and keeps the annotator open", async () => {
    const user = userEvent.setup();
    const { onClose } = await mountOnText();
    await screen.findByRole("dialog", { name: TITLE });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: TITLE })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(fillText).not.toHaveBeenCalled();
    // With the prompt gone, Escape is the overlay's again.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
