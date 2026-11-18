import { afterEach, describe, expect, it, vi } from "vitest";
import { focusDocumentEditor, focusDocumentEditorWhenReady } from "../../lib/shortcuts/documentScroll";

function pane(html: string) {
  const host = document.createElement("div");
  host.className = "center-pane";
  host.dataset.tabKey = "file";
  host.dataset.scopeKey = "project";
  host.getBoundingClientRect = () => ({ width: 600, height: 400 }) as DOMRect;
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

const editorHtml = '<textarea class="file-viewer-editor">selected source</textarea>';

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Work focus in a document", () => {
  it.each(['style="display:none"', 'hidden', 'inert', 'style="visibility:hidden"'])(
    "skips a retained TeX workspace source under %s and focuses the shown source",
    (hidden) => {
      const host = pane(`<div ${hidden}>${editorHtml}</div><div>${editorHtml}</div>`);
      const shown = host.querySelectorAll("textarea")[1];
      shown.setSelectionRange(3, 8);
      expect(focusDocumentEditor("project", "file")).toBe(true);
      expect(document.activeElement).toBe(shown);
      expect([shown.selectionStart, shown.selectionEnd]).toEqual([3, 8]);
    },
  );

  it("skips read-only and disabled editors", () => {
    const host = pane('<textarea class="file-viewer-editor" readonly></textarea><textarea class="file-viewer-editor" disabled></textarea>' + editorHtml);
    expect(focusDocumentEditor("project", "file")).toBe(true);
    expect(document.activeElement).toBe(host.querySelectorAll("textarea")[2]);
  });

  it("hands the caret to a file that finishes loading after Work", () => {
    vi.useFakeTimers();
    const host = pane('<div class="file-viewer-loading">Loading</div>');
    focusDocumentEditorWhenReady("project", "file", () => true);
    host.innerHTML = editorHtml;
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    vi.advanceTimersByTime(1); // The DOM schedules its selection event on focus.
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["navigation", "keydown", "pointerdown"])("does not steal focus after %s", (reason) => {
    vi.useFakeTimers();
    const host = pane('<div class="file-viewer-loading">Loading</div>');
    let current = true;
    focusDocumentEditorWhenReady("project", "file", () => current);
    if (reason === "navigation") current = false;
    else document.dispatchEvent(new Event(reason, { bubbles: true }));
    host.innerHTML = editorHtml;
    vi.advanceTimersByTime(1000);
    expect(document.activeElement).not.toBe(host.querySelector("textarea"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a PDF, a preview, or an unrelated hidden loading pane", () => {
    vi.useFakeTimers();
    pane('<div class="pdf-viewer"></div><div style="display:none"><div class="file-viewer-loading">Loading</div></div>');
    focusDocumentEditorWhenReady("project", "file", () => true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting after one second", () => {
    vi.useFakeTimers();
    const host = pane('<div class="file-viewer-loading">Loading</div>');
    focusDocumentEditorWhenReady("project", "file", () => true);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    host.innerHTML = editorHtml;
    vi.advanceTimersByTime(1000);
    expect(document.activeElement).not.toBe(host.querySelector("textarea"));
  });
});
