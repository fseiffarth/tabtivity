/**
 * Pure GIF decoder backing the native GIF viewer. All pure — the decoder takes
 * a `Uint8Array` and never touches the fs (same bargain as `yaml.ts`/`table.ts`).
 * WebKitGTK has no `ImageDecoder` API, so frame-level control (pause, step,
 * scrub) means decoding GIF's LZW + compositing ourselves. GIF89a is a frozen
 * spec, so hand-rolling costs no maintenance tail.
 *
 * Two load-bearing ideas:
 *
 * 1. **Every frame is composited to a full-canvas RGBA buffer.** A GIF frame is
 *    a rect patched onto the previous state (plus a disposal method), so frame N
 *    is only meaningful given N−1 — GIF has no keyframes. Decoding upfront to
 *    full frames is what makes scrubbing and prev-step O(1); the memory cost
 *    (`w*h*4*frames`) is bounded by `maxPixelBytes` — when the next frame would
 *    exceed it, decoding stops and the result says `truncated`.
 *
 * 2. **Delays are stored as authored, played as convention.** GIFs in the wild
 *    authored with a 0 or 1 hundredth delay were authored *against* the browser
 *    clamp (every engine renders <2 hundredths as 100ms); honoring 0ms literally
 *    would strobe them. `effectiveDelayMs` applies the convention at playback
 *    (<20ms → 100ms, everything else exact) while `GifFrame.delayMs` keeps the
 *    authored value for the readout.
 *
 * Disposal 2 ("restore to background") clears the frame rect to *transparent*,
 * not the logical-screen background color — the spec says background, every
 * browser ever shipped says transparent, and files are authored against the
 * browsers. Pinned by a test.
 *
 * Error policy: an unreadable header throws `GifDecodeError`; corruption or EOF
 * after at least one complete frame returns what decoded cleanly with
 * `truncated: true` (browsers render a truncated GIF the same way).
 */

export interface GifFrame {
  /** Full-canvas RGBA pixels (width*height*4), already composited. Typed over
   *  a plain ArrayBuffer so it feeds `new ImageData(...)` without a cast. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Authored delay in ms (raw GCE hundredths × 10). 0 is preserved as 0;
   *  playback applies {@link effectiveDelayMs}. */
  delayMs: number;
  /** Raw GCE disposal method 0–3, kept for tests/debug readouts. */
  disposal: number;
}

export interface GifData {
  /** Logical screen size — every frame's `pixels` buffer is this size. */
  width: number;
  height: number;
  /** At least one; a GIF with zero decodable frames throws instead. */
  frames: GifFrame[];
  /** Netscape iteration count: 0 = loop forever; 1 when the extension is
   *  absent (play once). */
  loopCount: number;
  /** True when the file ended mid-stream, a frame was corrupt, or the memory
   *  cap stopped decoding; `frames` holds what decoded cleanly. */
  truncated: boolean;
}

export class GifDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GifDecodeError";
  }
}

/** The delay a frame actually plays at (see module comment): authored delays
 *  under 20ms mean "browser default", i.e. 100ms; everything else is exact. */
export function effectiveDelayMs(delayMs: number): number {
  return delayMs < 20 ? 100 : delayMs;
}

/** Default cap on total decoded frame memory (RGBA bytes across all frames).
 *  Typical GIFs (a few MB file, <200 frames, <600px) land well under this;
 *  a pathological one stops here with `truncated` instead of eating the heap. */
export const DEFAULT_MAX_PIXEL_BYTES = 256 * 1024 * 1024;

// ── Byte cursor ──────────────────────────────────────────────────────────────

interface Cursor {
  bytes: Uint8Array;
  pos: number;
}

function u8(c: Cursor): number {
  if (c.pos >= c.bytes.length) throw new GifDecodeError("unexpected end of file");
  return c.bytes[c.pos++];
}

function u16le(c: Cursor): number {
  return u8(c) | (u8(c) << 8);
}

function take(c: Cursor, n: number): Uint8Array {
  if (c.pos + n > c.bytes.length) throw new GifDecodeError("unexpected end of file");
  const v = c.bytes.subarray(c.pos, c.pos + n);
  c.pos += n;
  return v;
}

/** Read a sub-block chain (length byte, data, … until a 0 length) into one
 *  contiguous buffer. */
function readSubBlocks(c: Cursor): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let len = u8(c); len !== 0; len = u8(c)) {
    parts.push(take(c, len));
    total += len;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ── LZW ──────────────────────────────────────────────────────────────────────

/**
 * GIF-flavored LZW: variable code width from `minCodeSize+1` up to 12 bits,
 * clear code resets the dictionary, EOI ends the stream. The dictionary is flat
 * prefix/suffix arrays (an entry is "prefix entry's expansion + one suffix
 * byte"), expanded through a stack — no string building. Tolerates the two
 * real-world stream shapes: filling `expected` pixels before EOI (common), and
 * ending early (returns how many pixels landed; the caller marks truncated).
 * A code beyond the next free dictionary slot is corruption and throws.
 */
function lzwDecode(
  minCodeSize: number,
  data: Uint8Array,
  expected: number,
): { indices: Uint8Array; filled: number } {
  const MAX_DICT = 4096;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int32Array(MAX_DICT);
  const suffix = new Uint8Array(MAX_DICT);
  const stack = new Uint8Array(MAX_DICT + 1);
  const out = new Uint8Array(expected);

  let dictSize = eoi + 1;
  let codeSize = minCodeSize + 1;
  let prev = -1;
  let acc = 0;
  let bits = 0;
  let pos = 0;
  let outPos = 0;

  while (outPos < expected) {
    while (bits < codeSize) {
      if (pos >= data.length) return { indices: out, filled: outPos }; // stream ended early
      acc |= data[pos++] << bits;
      bits += 8;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      dictSize = eoi + 1;
      codeSize = minCodeSize + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    // Expand the code (or, for the KwKwK case where the code IS the next free
    // slot, the previous code + its own first byte) through the stack.
    let cur = code;
    let sp = 0;
    let kwkwk = false;
    if (cur >= dictSize) {
      if (cur !== dictSize || prev < 0) throw new GifDecodeError("corrupt LZW stream");
      kwkwk = true;
      cur = prev;
    }
    while (cur >= clear) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    const first = cur; // the expansion's first byte (a literal)
    stack[sp++] = first;
    for (let i = sp - 1; i >= 0 && outPos < expected; i--) out[outPos++] = stack[i];
    if (kwkwk && outPos < expected) out[outPos++] = first;

    if (prev >= 0 && dictSize < MAX_DICT) {
      prefix[dictSize] = prev;
      suffix[dictSize] = first;
      dictSize++;
      // Grow the code width when the dictionary fills the current one; a full
      // dictionary (4096) stays at 12 bits until the encoder sends a clear.
      if (dictSize === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return { indices: out, filled: outPos };
}

// ── Interlace ────────────────────────────────────────────────────────────────

/** Reorder an interlaced frame's rows into display order (the 4-pass 8/8/4/2
 *  row scheme). */
function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  const offsets = [0, 4, 2, 1];
  const steps = [8, 8, 4, 2];
  let src = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = offsets[pass]; y < h; y += steps[pass]) {
      out.set(indices.subarray(src, src + w), y * w);
      src += w;
    }
  }
  return out;
}

// ── Compositor ───────────────────────────────────────────────────────────────

/** Patch a frame's palette indices onto the full canvas. The transparent index
 *  leaves the underlying pixel; rows/cols outside the logical screen (broken
 *  files) and indices beyond the color table are skipped. `filled` bounds a
 *  partially decoded frame to the pixels that actually landed. */
function drawFrame(
  canvas: Uint8ClampedArray,
  cw: number,
  ch: number,
  indices: Uint8Array,
  filled: number,
  left: number,
  top: number,
  w: number,
  h: number,
  table: Uint8Array,
  transparent: number,
): void {
  for (let row = 0; row < h; row++) {
    const cy = top + row;
    if (cy < 0 || cy >= ch) continue;
    const rowBase = row * w;
    if (rowBase >= filled) break;
    for (let col = 0; col < w; col++) {
      const src = rowBase + col;
      if (src >= filled) break;
      const cx = left + col;
      if (cx < 0 || cx >= cw) continue;
      const idx = indices[src];
      if (idx === transparent) continue;
      const t = idx * 3;
      if (t + 2 >= table.length) continue;
      const p = (cy * cw + cx) * 4;
      canvas[p] = table[t];
      canvas[p + 1] = table[t + 1];
      canvas[p + 2] = table[t + 2];
      canvas[p + 3] = 255;
    }
  }
}

/** Clear a rect to transparent (disposal 2 — see module comment). */
function clearRect(
  canvas: Uint8ClampedArray,
  cw: number,
  ch: number,
  left: number,
  top: number,
  w: number,
  h: number,
): void {
  const x0 = Math.max(0, left);
  const x1 = Math.min(cw, left + w);
  const y0 = Math.max(0, top);
  const y1 = Math.min(ch, top + h);
  for (let y = y0; y < y1; y++) canvas.fill(0, (y * cw + x0) * 4, (y * cw + x1) * 4);
}

// ── Stream decoder ───────────────────────────────────────────────────────────

/** Incremental decoder: `nextFrame()` decodes and returns one composited frame
 *  at a time (null after the trailer / truncation), so a caller can yield to
 *  the event loop between frames instead of blocking on a long file.
 *  `loopCount`/`truncated` are settled once `nextFrame()` has returned null. */
export interface GifStream {
  readonly width: number;
  readonly height: number;
  nextFrame(): GifFrame | null;
  readonly loopCount: number;
  readonly truncated: boolean;
}

/** Parse the header/logical screen (throws `GifDecodeError` when `bytes` is not
 *  a GIF) and return a {@link GifStream} over the frames. */
export function openGif(
  bytes: Uint8Array,
  opts?: { maxPixelBytes?: number },
): GifStream {
  const c: Cursor = { bytes, pos: 0 };
  const magic = String.fromCharCode(...take(c, 6));
  if (magic !== "GIF87a" && magic !== "GIF89a") throw new GifDecodeError("not a GIF file");
  const width = u16le(c);
  const height = u16le(c);
  if (width === 0 || height === 0) throw new GifDecodeError("empty logical screen");
  const lsdFlags = u8(c);
  u8(c); // background color index — unused (see module comment on disposal 2)
  u8(c); // pixel aspect ratio — universally ignored
  const gct = lsdFlags & 0x80 ? take(c, 3 * (2 << (lsdFlags & 7))) : null;

  const maxPixelBytes = opts?.maxPixelBytes ?? DEFAULT_MAX_PIXEL_BYTES;
  const frameBytes = width * height * 4;
  // Checked before the canvas below is allocated: the size is the file's claim,
  // so a 30-byte GIF could otherwise ask for 65535² × 4 bytes (16 GiB) up front.
  if (frameBytes > maxPixelBytes) throw new GifDecodeError("logical screen too large");
  // The persistent composite canvas; starts fully transparent.
  const canvas = new Uint8ClampedArray(frameBytes);
  let snapshot: Uint8ClampedArray | null = null;
  // The pending Graphic Control Extension — it precedes and applies to the next
  // image descriptor only.
  let pending: { delayMs: number; disposal: number; transparent: number } | null = null;
  let loopCount = 1;
  let truncated = false;
  let done = false;
  let delivered = 0;

  function readNext(): GifFrame | null {
    while (true) {
      const block = u8(c);
      if (block === 0x3b) return null; // trailer
      if (block === 0x21) {
        const label = u8(c);
        if (label === 0xf9) {
          // Graphic Control Extension: disposal + transparency + delay.
          const d = readSubBlocks(c);
          if (d.length >= 4) {
            pending = {
              disposal: (d[0] >> 2) & 7,
              transparent: d[0] & 1 ? d[3] : -1,
              delayMs: (d[1] | (d[2] << 8)) * 10,
            };
          }
        } else if (label === 0xff) {
          // Application extension — only the Netscape loop count matters.
          const d = readSubBlocks(c);
          const id = String.fromCharCode(...d.subarray(0, 11));
          if ((id === "NETSCAPE2.0" || id === "ANIMEXTS1.0") && d.length >= 14 && d[11] === 1) {
            loopCount = d[12] | (d[13] << 8);
          }
        } else {
          // Comment / plain-text / unknown extension: skip leniently — real-world
          // GIFs carry junk extensions.
          readSubBlocks(c);
        }
        continue;
      }
      if (block === 0x2c) {
        // Image descriptor.
        const left = u16le(c);
        const top = u16le(c);
        const w = u16le(c);
        const h = u16le(c);
        const dFlags = u8(c);
        const lct = dFlags & 0x80 ? take(c, 3 * (2 << (dFlags & 7))) : null;
        const table = lct ?? gct;
        if (!table) throw new GifDecodeError("frame has no color table");
        if (w === 0 || h === 0) throw new GifDecodeError("empty frame");
        // `lzwDecode` sizes its index buffer from the frame's own `w*h`, so a
        // frame larger than the screen would allocate past the screen-sized
        // budget checked above. Refused before decoding; offsets that only push
        // a screen-sized frame past an edge still draw clipped.
        if (w > width || h > height) throw new GifDecodeError("frame larger than the screen");
        if ((delivered + 1) * frameBytes > maxPixelBytes) {
          truncated = true;
          return null;
        }
        const minCodeSize = u8(c);
        if (minCodeSize < 1 || minCodeSize > 11) throw new GifDecodeError("corrupt LZW code size");
        const { indices, filled } = lzwDecode(minCodeSize, readSubBlocks(c), w * h);
        const idx = dFlags & 0x40 ? deinterlace(indices, w, h) : indices;
        const gce = pending;
        pending = null;
        const disposal = gce?.disposal ?? 0;
        // Disposal 3 restores the state from BEFORE this frame drew — snapshot
        // only then, so ordinary frames cost no copy.
        if (disposal === 3) snapshot = canvas.slice();
        drawFrame(canvas, width, height, idx, filled, left, top, w, h, table, gce?.transparent ?? -1);
        const frame: GifFrame = {
          pixels: canvas.slice(),
          delayMs: gce?.delayMs ?? 0,
          disposal,
        };
        // Apply this frame's disposal now, preparing the canvas the NEXT frame
        // composites onto.
        if (disposal === 2) clearRect(canvas, width, height, left, top, w, h);
        else if (disposal === 3 && snapshot) {
          canvas.set(snapshot);
          snapshot = null;
        }
        if (filled < w * h) truncated = true; // LZW stream ended early
        delivered++;
        return frame;
      }
      throw new GifDecodeError(`unknown block 0x${block.toString(16)}`);
    }
  }

  return {
    width,
    height,
    get loopCount() {
      return loopCount;
    },
    get truncated() {
      return truncated;
    },
    nextFrame() {
      if (done) return null;
      let frame: GifFrame | null = null;
      try {
        frame = readNext();
      } catch (e) {
        // Corruption/EOF before the first complete frame is a hard error; after
        // one, render what decoded cleanly (what browsers do).
        if (delivered === 0) {
          done = true;
          throw e instanceof GifDecodeError ? e : new GifDecodeError(String(e));
        }
        truncated = true;
      }
      if (frame === null) done = true;
      return frame;
    },
  };
}

/** Decode a whole GIF upfront (drains {@link openGif}). Throws `GifDecodeError`
 *  when the bytes are not a GIF or no frame decodes. */
export function decodeGif(bytes: Uint8Array, opts?: { maxPixelBytes?: number }): GifData {
  const stream = openGif(bytes, opts);
  const frames: GifFrame[] = [];
  for (let f = stream.nextFrame(); f !== null; f = stream.nextFrame()) frames.push(f);
  if (frames.length === 0) throw new GifDecodeError("GIF contains no image frames");
  return {
    width: stream.width,
    height: stream.height,
    frames,
    loopCount: stream.loopCount,
    truncated: stream.truncated,
  };
}
