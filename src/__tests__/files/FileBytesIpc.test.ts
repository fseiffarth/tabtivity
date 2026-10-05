/**
 * How a file's bytes cross the IPC bridge (`components/embed/fileAccess`).
 *
 * This is the difference between a large PDF opening and the window locking up, so
 * the shape is pinned here rather than left to be discovered by a 130 MB thesis. The
 * bytes ride as a **raw** body — an `ArrayBuffer` out, a `Uint8Array` in — instead of
 * a JSON array with one decimal literal per byte, which costs roughly three bytes of
 * text per byte of file in each direction and lands in the renderer as a number array
 * that then has to be copied.
 *
 * A write's two scalars therefore ride in headers: an invoke carries one raw body, so
 * there is nowhere else for them to go.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NAMES } from "../../lib/brand";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { readFileBytes, writeFileBytes } = await import("../../components/embed/fileAccess");

beforeEach(() => {
  invoke.mockReset();
});

describe("readFileBytes", () => {
  it("takes the raw ArrayBuffer the command answers with, without copying it again", async () => {
    const buf = new Uint8Array([37, 80, 68, 70]).buffer;
    invoke.mockResolvedValueOnce(buf);

    const out = await readFileBytes("/p/thesis.pdf", "proj");

    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([37, 80, 68, 70]);
    // The view owns the answered buffer: nothing between the bridge and pdf.js.
    expect(out.buffer).toBe(buf);
    expect(invoke).toHaveBeenCalledWith("read_file_bytes", {
      path: "/p/thesis.pdf",
      projectId: "proj",
    });
  });

  it("still accepts a number array, so an older backend keeps working", async () => {
    invoke.mockResolvedValueOnce([1, 2, 3]);
    expect(Array.from(await readFileBytes("/p/a.pdf", null))).toEqual([1, 2, 3]);
  });
});

describe("writeFileBytes", () => {
  it("sends the bytes as the raw body, with the path and scope in headers", async () => {
    invoke.mockResolvedValueOnce(null);
    const bytes = new Uint8Array([1, 2, 3]);

    await writeFileBytes("/p/thesis.pdf", bytes, "proj");

    const [cmd, body, options] = invoke.mock.calls[0];
    expect(cmd).toBe("write_file_bytes");
    // The very thing this transport exists to avoid: no array, no JSON payload.
    expect(body).toBe(bytes);
    expect(Array.isArray(body)).toBe(false);
    expect(options).toEqual({
      headers: {
        [NAMES.filePathHeader]: "%2Fp%2Fthesis.pdf",
        [NAMES.fileProjectHeader]: "proj",
      },
    });
  });

  it("percent-encodes a path a header could not otherwise carry", async () => {
    invoke.mockResolvedValueOnce(null);
    await writeFileBytes("/p/Übung/a b.pdf", new Uint8Array([0]), null);

    const headers = invoke.mock.calls[0][2].headers as Record<string, string>;
    expect(decodeURIComponent(headers[NAMES.filePathHeader])).toBe("/p/Übung/a b.pdf");
    // The root scope is the empty string, never the word "null".
    expect(headers[NAMES.fileProjectHeader]).toBe("");
  });
});
