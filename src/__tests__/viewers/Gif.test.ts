import { describe, it, expect } from "vitest";
import {
  decodeGif,
  openGif,
  effectiveDelayMs,
  GifDecodeError,
  type GifData,
} from "../../lib/viewers/gif";

// ── Test-side GIF builder ─────────────────────────────────────────────────────
// A minimal GIF encoder so each case reads as "this picture, these frames"
// instead of a hex dump. The LZW half only ever emits literal codes, but it
// must mirror the decoder's dictionary growth exactly: the decoder adds an
// entry per code (after the first since a clear) whether or not the encoder
// uses them, and the CODE WIDTH grows when the dictionary fills it — so the
// encoder tracks the same counters to write each code at the width the decoder
// will read it.

function lzwEncodeLiterals(
  minCodeSize: number,
  indices: number[],
  clearEvery?: number,
): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dictSize = eoi + 1;
  let sinceClear = 0;
  const out: number[] = [];
  let acc = 0;
  let nbits = 0;
  const emit = (code: number) => {
    acc |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      out.push(acc & 0xff);
      acc >>= 8;
      nbits -= 8;
    }
  };
  emit(clear);
  for (const index of indices) {
    if (clearEvery && sinceClear === clearEvery) {
      emit(clear);
      codeSize = minCodeSize + 1;
      dictSize = eoi + 1;
      sinceClear = 0;
    }
    emit(index);
    // The decoder adds a dictionary entry for every code after the first since
    // the last clear, growing the code width when the dictionary fills it.
    if (sinceClear > 0 && dictSize < 4096) {
      dictSize++;
      if (dictSize === 1 << codeSize && codeSize < 12) codeSize++;
    }
    sinceClear++;
  }
  emit(eoi);
  if (nbits > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

type Rgb = [number, number, number];

interface TestFrame {
  /** [left, top, w, h]; defaults to the full logical screen. */
  rect?: [number, number, number, number];
  /** Palette indices in row-major FILE order (pre-interlace when `interlace`). */
  indices: number[];
  /** Local color table (overrides the global for this frame). */
  lct?: Rgb[];
  /** Graphic Control Extension; omitted = no GCE (delay 0, disposal 0). */
  gce?: { delay?: number; transparent?: number; disposal?: number };
  interlace?: boolean;
  /** Raw pre-encoded LZW payload (minCodeSize + data), for hand-built streams. */
  rawLzw?: { minCodeSize: number; data: number[] };
  clearEvery?: number;
}

function colorTable(colors: Rgb[]): { bytes: number[]; sizeField: number } {
  // Table length must be a power of two with at least 2 entries.
  let size = 2;
  while (size < colors.length) size *= 2;
  const bytes: number[] = [];
  for (let i = 0; i < size; i++) {
    const [r, g, b] = colors[i] ?? [0, 0, 0];
    bytes.push(r, g, b);
  }
  return { bytes, sizeField: Math.log2(size) - 1 };
}

function subBlocks(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

function buildGif({
  width,
  height,
  gct,
  frames,
  netscapeLoops,
  version = "GIF89a",
  trailer = true,
}: {
  width: number;
  height: number;
  gct?: Rgb[];
  frames: TestFrame[];
  /** Netscape iteration count (0 = forever). */
  netscapeLoops?: number;
  version?: string;
  trailer?: boolean;
}): Uint8Array {
  const out: number[] = [...version].map((ch) => ch.charCodeAt(0));
  out.push(width & 0xff, width >> 8, height & 0xff, height >> 8);
  if (gct) {
    const t = colorTable(gct);
    out.push(0x80 | t.sizeField, 0, 0, ...t.bytes);
  } else {
    out.push(0, 0, 0);
  }
  if (netscapeLoops !== undefined) {
    out.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((ch) => ch.charCodeAt(0)));
    out.push(3, 1, netscapeLoops & 0xff, netscapeLoops >> 8, 0);
  }
  for (const f of frames) {
    if (f.gce) {
      const disposal = f.gce.disposal ?? 0;
      const flags = (disposal << 2) | (f.gce.transparent !== undefined ? 1 : 0);
      const delay = f.gce.delay ?? 0;
      out.push(0x21, 0xf9, 4, flags, delay & 0xff, delay >> 8, f.gce.transparent ?? 0, 0);
    }
    const [left, top, w, h] = f.rect ?? [0, 0, width, height];
    let dFlags = f.interlace ? 0x40 : 0;
    let lctBytes: number[] = [];
    if (f.lct) {
      const t = colorTable(f.lct);
      dFlags |= 0x80 | t.sizeField;
      lctBytes = t.bytes;
    }
    out.push(0x2c, left & 0xff, left >> 8, top & 0xff, top >> 8, w & 0xff, w >> 8, h & 0xff, h >> 8, dFlags, ...lctBytes);
    if (f.rawLzw) {
      out.push(f.rawLzw.minCodeSize, ...subBlocks(Uint8Array.from(f.rawLzw.data)));
    } else {
      const tableLen = (f.lct ?? gct ?? []).length;
      const minCodeSize = Math.max(2, Math.ceil(Math.log2(Math.max(tableLen, 2))));
      out.push(minCodeSize, ...subBlocks(lzwEncodeLiterals(minCodeSize, f.indices, f.clearEvery)));
    }
  }
  if (trailer) out.push(0x3b);
  return Uint8Array.from(out);
}

// ── Pixel helpers ─────────────────────────────────────────────────────────────

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];

function px(gif: GifData, frame: number, x: number, y: number): number[] {
  const p = (y * gif.width + x) * 4;
  return Array.from(gif.frames[frame].pixels.subarray(p, p + 4));
}

const opaque = (c: Rgb) => [...c, 255];
const CLEAR = [0, 0, 0, 0];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("decodeGif basics", () => {
  it("decodes a 2×2 single-frame GIF87a", () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [{ indices: [0, 1, 2, 3] }],
        version: "GIF87a",
      }),
    );
    expect(gif.width).toBe(2);
    expect(gif.height).toBe(2);
    expect(gif.frames).toHaveLength(1);
    expect(gif.loopCount).toBe(1); // no Netscape extension = play once
    expect(gif.truncated).toBe(false);
    expect(gif.frames[0].delayMs).toBe(0); // GIF87a has no GCE
    expect(px(gif, 0, 0, 0)).toEqual(opaque(RED));
    expect(px(gif, 0, 1, 0)).toEqual(opaque(GREEN));
    expect(px(gif, 0, 0, 1)).toEqual(opaque(BLUE));
    expect(px(gif, 0, 1, 1)).toEqual(opaque(WHITE));
  });

  it("carries the authored delay (hundredths × 10) and the Netscape loop count", () => {
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        gct: [RED, GREEN],
        netscapeLoops: 0, // loop forever
        frames: [
          { indices: [0], gce: { delay: 5 } },
          { indices: [1], gce: { delay: 200 } },
        ],
      }),
    );
    expect(gif.loopCount).toBe(0);
    expect(gif.frames[0].delayMs).toBe(50);
    expect(gif.frames[1].delayMs).toBe(2000);
  });

  it("rejects a non-GIF header", () => {
    expect(() => decodeGif(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(GifDecodeError);
    expect(() => decodeGif(new TextEncoder().encode("PNG89a xxxxxxxx"))).toThrow(/not a GIF/);
  });

  it("decodes the canonical 1×1 transparent GIF", () => {
    const bytes = Uint8Array.from(
      atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
      (ch) => ch.charCodeAt(0),
    );
    const gif = decodeGif(bytes);
    expect(gif.width).toBe(1);
    expect(gif.height).toBe(1);
    expect(gif.frames).toHaveLength(1);
    expect(px(gif, 0, 0, 0)).toEqual(CLEAR); // transparent index left the canvas clear
  });
});

describe("compositing and disposal", () => {
  it("disposal 1 (keep): the next frame composites over this one", () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [
          { indices: [0, 0, 0, 0], gce: { disposal: 1 } },
          // Right column only.
          { rect: [1, 0, 1, 2], indices: [2, 2] },
        ],
      }),
    );
    expect(px(gif, 1, 0, 0)).toEqual(opaque(RED)); // left column survives
    expect(px(gif, 1, 1, 0)).toEqual(opaque(BLUE));
    expect(px(gif, 1, 1, 1)).toEqual(opaque(BLUE));
  });

  it("the transparent index leaves the underlying pixel", () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 1,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [
          { indices: [0, 1], gce: { disposal: 1 } },
          // Index 3 is transparent: only the second pixel changes.
          { indices: [3, 2], gce: { transparent: 3 } },
        ],
      }),
    );
    expect(px(gif, 1, 0, 0)).toEqual(opaque(RED));
    expect(px(gif, 1, 1, 0)).toEqual(opaque(BLUE));
  });

  it("disposal 2 clears the frame's rect to TRANSPARENT (browser behavior, not spec background)", () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [
          { indices: [0, 0, 0, 0], gce: { disposal: 2 } },
          { rect: [0, 0, 1, 1], indices: [2] },
        ],
      }),
    );
    // Frame 1 itself shows normally…
    expect(px(gif, 0, 0, 0)).toEqual(opaque(RED));
    // …but frame 2 starts from a cleared canvas: only its own pixel is set.
    expect(px(gif, 1, 0, 0)).toEqual(opaque(BLUE));
    expect(px(gif, 1, 1, 0)).toEqual(CLEAR);
    expect(px(gif, 1, 0, 1)).toEqual(CLEAR);
    expect(px(gif, 1, 1, 1)).toEqual(CLEAR);
  });

  it("disposal 3 restores the canvas from before the frame drew", () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 1,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [
          { indices: [0, 0], gce: { disposal: 1 } },
          { indices: [2, 2], gce: { disposal: 3 } }, // full blue, then restore
          { rect: [0, 0, 1, 1], indices: [1] },
        ],
      }),
    );
    expect(px(gif, 1, 0, 0)).toEqual(opaque(BLUE)); // frame 2 shows its own draw
    expect(px(gif, 2, 0, 0)).toEqual(opaque(GREEN)); // frame 3's own pixel
    expect(px(gif, 2, 1, 0)).toEqual(opaque(RED)); // restored, not blue
  });

  it("a local color table overrides the global one", () => {
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 1,
        gct: [RED, GREEN],
        frames: [{ indices: [0], lct: [BLUE, WHITE] }],
      }),
    );
    expect(px(gif, 0, 0, 0)).toEqual(opaque(BLUE));
  });

  it("reorders interlaced rows into display order", () => {
    // 1×8: file rows land on display rows 0,4,2,6,1,3,5,7 (the 4-pass scheme).
    const shades: Rgb[] = Array.from({ length: 8 }, (_, i) => [i * 30, i * 30, i * 30]);
    const gif = decodeGif(
      buildGif({
        width: 1,
        height: 8,
        gct: shades,
        frames: [{ indices: [0, 1, 2, 3, 4, 5, 6, 7], interlace: true }],
      }),
    );
    const fileOrderOfRow = [0, 4, 2, 5, 1, 6, 3, 7]; // inverse of [0,4,2,6,1,3,5,7]
    for (let y = 0; y < 8; y++) {
      expect(px(gif, 0, 0, y)).toEqual(opaque(shades[fileOrderOfRow[y]]));
    }
  });
});

describe("LZW", () => {
  it("round-trips a stream long enough to grow the code width", () => {
    const w = 10;
    const h = 10;
    const indices = Array.from({ length: w * h }, (_, i) => (i * 7) % 16);
    const palette: Rgb[] = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, i]);
    const gif = decodeGif(buildGif({ width: w, height: h, gct: palette, frames: [{ indices }] }));
    for (let i = 0; i < indices.length; i++) {
      expect(px(gif, 0, i % w, Math.floor(i / w))).toEqual(opaque(palette[indices[i]]));
    }
  });

  it("handles mid-stream clear codes", () => {
    const indices = Array.from({ length: 64 }, (_, i) => i % 4);
    const gif = decodeGif(
      buildGif({
        width: 8,
        height: 8,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [{ indices, clearEvery: 7 }],
      }),
    );
    expect(px(gif, 0, 0, 0)).toEqual(opaque(RED));
    expect(px(gif, 0, 5, 3)).toEqual(opaque(GREEN)); // index (3*8+5)%4 = 1
    expect(px(gif, 0, 7, 7)).toEqual(opaque(WHITE));
  });

  it("decodes the KwKwK case (a code that IS the next dictionary slot)", () => {
    // Hand-packed stream for "aaaa" with minCodeSize 2:
    // clear(4), 0, 6 ← the KwKwK code, 0, eoi(5) — widths 3,3,3,3,4 bits.
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        gct: [RED, GREEN, BLUE, WHITE],
        frames: [{ indices: [], rawLzw: { minCodeSize: 2, data: [0x84, 0x51] } }],
      }),
    );
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      expect(px(gif, 0, x, y)).toEqual(opaque(RED));
    }
  });
});

describe("truncation and caps", () => {
  it("returns the complete frames of a truncated file with truncated: true", () => {
    const whole = buildGif({
      width: 2,
      height: 2,
      gct: [RED, GREEN, BLUE, WHITE],
      frames: [
        { indices: [0, 0, 0, 0], gce: { delay: 10 } },
        { indices: [1, 1, 1, 1], gce: { delay: 10 } },
      ],
    });
    // Cut into frame 2's data (also drops the trailer).
    const gif = decodeGif(whole.subarray(0, whole.length - 4));
    expect(gif.frames).toHaveLength(1);
    expect(gif.truncated).toBe(true);
    expect(px(gif, 0, 0, 0)).toEqual(opaque(RED));
  });

  it("throws when not even one frame decodes", () => {
    const whole = buildGif({
      width: 2,
      height: 2,
      gct: [RED, GREEN],
      frames: [{ indices: [0, 0, 0, 0] }],
    });
    expect(() => decodeGif(whole.subarray(0, 20))).toThrow(GifDecodeError);
  });

  it("stops at maxPixelBytes and marks the result truncated", () => {
    const bytes = buildGif({
      width: 2,
      height: 2,
      gct: [RED, GREEN],
      frames: [
        { indices: [0, 0, 0, 0] },
        { indices: [1, 1, 1, 1] },
      ],
    });
    // One 2×2 RGBA frame = 16 bytes: the cap admits exactly one frame.
    const gif = decodeGif(bytes, { maxPixelBytes: 16 });
    expect(gif.frames).toHaveLength(1);
    expect(gif.truncated).toBe(true);
    // Untouched, both frames decode.
    expect(decodeGif(bytes).frames).toHaveLength(2);
  });

  it("refuses a huge claimed screen before allocating its canvas (row 41)", () => {
    // A complete GIF that claims a 65535×65535 screen: 16 GiB of RGBA. Allocating
    // that canvas would throw a RangeError (or take the renderer down); the
    // refusal is a GifDecodeError, so the size check ran first.
    const bomb = buildGif({ width: 65535, height: 65535, gct: [RED, GREEN], frames: [{ rect: [0, 0, 1, 1], indices: [0] }] });
    expect(bomb.length).toBeLessThan(64);
    expect(() => openGif(bomb)).toThrow(GifDecodeError);
    expect(() => openGif(bomb)).toThrow(/screen too large/);
    // The same check honours a caller's cap.
    const small = buildGif({ width: 4, height: 4, gct: [RED, GREEN], frames: [{ indices: Array(16).fill(0) }] });
    expect(() => openGif(small, { maxPixelBytes: 63 })).toThrow(/screen too large/);
    expect(decodeGif(small, { maxPixelBytes: 64 }).frames).toHaveLength(1);
  });

  it("refuses a frame claiming a huge size before decoding it (row 41)", () => {
    // A 2×2 screen whose frame claims 65535×65535: `lzwDecode` would size its
    // index buffer from the frame's own w*h (4 GiB). A GifDecodeError, not a
    // RangeError, so the check ran before any allocation.
    const huge = buildGif({
      width: 2,
      height: 2,
      gct: [RED, GREEN],
      frames: [{ rect: [0, 0, 65535, 65535], indices: [0] }],
    });
    expect(() => decodeGif(huge)).toThrow(GifDecodeError);
    expect(() => decodeGif(huge)).toThrow(/frame too large/);
    // After a good frame, a frame past the budget ends the stream as truncated.
    const tail = buildGif({
      width: 2,
      height: 2,
      gct: [RED, GREEN],
      frames: [{ indices: [0, 0, 0, 0] }, { rect: [0, 0, 3, 2], indices: [1, 1, 1, 1, 1, 1] }],
    });
    const capped = decodeGif(tail, { maxPixelBytes: 20 });
    expect(capped.frames).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("animates a frame wider than the screen, drawn clipped", () => {
    // Out of spec but real: a 3×2 frame on a 2×2 screen. Within the memory
    // budget it decodes, and the column past the edge is clipped.
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        gct: [RED, GREEN],
        frames: [{ indices: [0, 0, 0, 0] }, { rect: [0, 0, 3, 2], indices: [1, 1, 1, 1, 1, 1] }],
      }),
    );
    expect(gif.frames).toHaveLength(2);
    expect(gif.truncated).toBe(false);
    expect(px(gif, 0, 1, 1)).toEqual(opaque(RED));
    expect(px(gif, 1, 0, 0)).toEqual(opaque(GREEN));
    expect(px(gif, 1, 1, 1)).toEqual(opaque(GREEN));
  });

  it("streams frames one at a time via openGif", () => {
    const stream = openGif(
      buildGif({
        width: 1,
        height: 1,
        gct: [RED, GREEN],
        frames: [{ indices: [0] }, { indices: [1] }],
      }),
    );
    expect(stream.width).toBe(1);
    const f1 = stream.nextFrame();
    const f2 = stream.nextFrame();
    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(stream.nextFrame()).toBeNull();
    expect(stream.nextFrame()).toBeNull(); // stays done
    expect(stream.truncated).toBe(false);
  });
});

describe("effectiveDelayMs", () => {
  it("bumps sub-20ms authored delays to the 100ms browser convention", () => {
    expect(effectiveDelayMs(0)).toBe(100);
    expect(effectiveDelayMs(10)).toBe(100);
  });
  it("honors 20ms and above exactly", () => {
    expect(effectiveDelayMs(20)).toBe(20);
    expect(effectiveDelayMs(500)).toBe(500);
  });
});
