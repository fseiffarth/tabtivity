/**
 * Tests for dragging an image OUT of the app as an OS drop source (#53). Verifies
 * the exported `onImageDragStart` populates a (mock) DataTransfer with the
 * `file://` URI list and a DownloadURL entry. OS-level acceptance on WebKitGTK is
 * a manual concern; here we assert the testable dataTransfer wiring.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { onImageDragStart } from "../../components/embed/fileViewer/ImageView";

/** A minimal DataTransfer stand-in recording setData calls. */
class MockDataTransfer {
  store: Record<string, string> = {};
  effectAllowed = "";
  setData(type: string, value: string) {
    this.store[type] = value;
  }
  getData(type: string) {
    return this.store[type] ?? "";
  }
}

describe("onImageDragStart", () => {
  it("publishes a file:// uri-list and plain text for the image path", () => {
    const dt = new MockDataTransfer();
    onImageDragStart({ dataTransfer: dt as unknown as DataTransfer }, "/home/u/pics/cat.png");
    expect(dt.getData("text/uri-list")).toBe("file:///home/u/pics/cat.png");
    expect(dt.getData("text/plain")).toBe("file:///home/u/pics/cat.png");
  });

  it("publishes a DownloadURL with the file name and url", () => {
    const dt = new MockDataTransfer();
    onImageDragStart({ dataTransfer: dt as unknown as DataTransfer }, "/home/u/pics/cat.png");
    expect(dt.getData("DownloadURL")).toBe(":cat.png:file:///home/u/pics/cat.png");
    expect(dt.effectAllowed).toBe("copy");
  });

  it("percent-encodes path segments with spaces", () => {
    const dt = new MockDataTransfer();
    onImageDragStart({ dataTransfer: dt as unknown as DataTransfer }, "/home/u/my pics/a b.png");
    expect(dt.getData("text/uri-list")).toBe("file:///home/u/my%20pics/a%20b.png");
  });

  it("is a safe no-op when dataTransfer is null", () => {
    expect(() => onImageDragStart({ dataTransfer: null }, "/x.png")).not.toThrow();
  });
});
