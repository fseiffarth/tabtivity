/**
 * Open an `.odt` ZIP for the ODT viewer with bounded inflation (#869).
 *
 * fflate's `unzipSync` sizes every entry's output buffer from the archive's
 * own declared `originalSize`, and by default inflates every entry. A small
 * file can therefore declare gigabytes, or carry a bomb in a part the viewer
 * never reads. Here only the parts `extractOdt` uses are inflated —
 * `content.xml` and the `Pictures/` images (`styles.xml`, `meta.xml`,
 * thumbnails and the rest are never read, so never inflated) — and their
 * declared sizes are summed before anything is inflated:
 *
 * - `content.xml` alone past {@link ODT_MAX_INFLATED_BYTES} refuses the file;
 * - images fill what is left of that budget in archive order, and an image
 *   past it is skipped (it renders as a missing picture), so a document with
 *   many photos still opens;
 * - an archive listing more than {@link ODT_MAX_ENTRIES} entries is refused.
 *
 * Two passes over the central directory: the first only reads the listing (no
 * inflation), the second inflates exactly the entries the first chose, by
 * position, so a duplicated name cannot sneak a second copy past the budget.
 *
 * The declared sizes bound memory, not work: fflate's `inflateSync` writes into
 * a buffer of the declared size but keeps decoding the whole stream, dropping
 * what does not fit, so a part declaring 1 KiB over a 64 MiB deflate bomb would
 * spin the window through ~64 GiB of output. The chosen parts are therefore
 * inflated as a stream in {@link INFLATE_CHUNK} pieces and the first one whose
 * real output passes its declared size refuses the file — a real archive's
 * declared size is the size — so the work stays within the budget plus one
 * chunk's expansion.
 */
import { Inflate, unzipSync, type UnzipFileInfo } from "fflate";
import { formatBytes } from "../formatBytes";
import { translate, useI18nStore } from "../i18n";

/** Total bytes the viewer inflates from one `.odt`. */
export const ODT_MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** Entries a real document never comes near; past it the listing is refused. */
export const ODT_MAX_ENTRIES = 10_000;

/** Bytes an entry costs once taken out: a stored entry is copied at its stored
 *  size, a deflated one gets a buffer of its declared size. */
const cost = (f: UnzipFileInfo): number => Math.max(f.size, f.originalSize);

function tooLarge(): Error {
  return new Error(
    translate(useI18nStore.getState().lang, "odt.errTooLarge", {
      size: formatBytes(ODT_MAX_INFLATED_BYTES),
    }),
  );
}

/** The entries of `bytes` the ODT viewer reads, inflated within the budget.
 *  Throws (translated) when `content.xml` or the listing is over the limits;
 *  a missing `content.xml` is left for `extractOdt` to report. */
export function unzipOdt(bytes: Uint8Array): Record<string, Uint8Array> {
  const listing: UnzipFileInfo[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      if (listing.length >= ODT_MAX_ENTRIES) throw tooLarge();
      listing.push(f);
      return false;
    },
  });

  const take = new Array<boolean>(listing.length).fill(false);
  let used = 0;
  // The body first, so images listed before it cannot spend its budget.
  const content = listing.findIndex((f) => f.name === "content.xml");
  if (content >= 0) {
    if (cost(listing[content]) > ODT_MAX_INFLATED_BYTES) throw tooLarge();
    take[content] = true;
    used = cost(listing[content]);
  }
  listing.forEach((f, i) => {
    if (!f.name.startsWith("Pictures/") || f.name.endsWith("/")) return;
    const c = cost(f);
    if (used + c > ODT_MAX_INFLATED_BYTES) return;
    take[i] = true;
    used += c;
  });

  const starts = dataStarts(bytes, listing.length);
  const out: Record<string, Uint8Array> = {};
  listing.forEach((f, i) => {
    if (!take[i]) return;
    const raw = bytes.subarray(starts[i], starts[i] + f.size);
    if (f.compression === 0) out[f.name] = raw.slice();
    else if (f.compression === 8) out[f.name] = inflateBounded(raw, f.originalSize);
    else throw new Error(`unknown compression type ${f.compression}`);
  });
  return out;
}

/** Compressed bytes handed to the inflater at a time: the most output that can
 *  pass an entry's declared size before the check below stops it is one
 *  chunk's worth of deflate expansion (~1032×, so ~66 MiB of work). */
export const INFLATE_CHUNK = 64 * 1024;

/** Inflate `raw` into at most `declared` bytes; refuses the file the moment the
 *  stream produces more than it declared. */
function inflateBounded(raw: Uint8Array, declared: number): Uint8Array {
  const buf = new Uint8Array(declared);
  let pos = 0;
  const inflater = new Inflate((chunk) => {
    if (pos + chunk.length > declared) throw tooLarge();
    buf.set(chunk, pos);
    pos += chunk.length;
  });
  for (let at = 0; at < raw.length; at += INFLATE_CHUNK) {
    inflater.push(raw.subarray(at, at + INFLATE_CHUNK), at + INFLATE_CHUNK >= raw.length);
  }
  return buf.subarray(0, pos);
}

const b2 = (d: Uint8Array, b: number): number => d[b] | (d[b + 1] << 8);
const b4 = (d: Uint8Array, b: number): number =>
  (d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0;
const b8 = (d: Uint8Array, b: number): number => b4(d, b) + b4(d, b + 4) * 0x1_0000_0000;

/** Where each of the first `count` central-directory entries' data starts, in
 *  listing order. The same walk `unzipSync` made for the listing (end record,
 *  zip64 locator, per-entry zip64 extra field), which fflate does not expose;
 *  that pass has already validated the structure. */
function dataStarts(d: Uint8Array, count: number): number[] {
  let e = d.length - 22;
  while (e > 0 && b4(d, e) !== 0x06054b50) e--;
  let o = b4(d, e + 16);
  let z64 = e >= 20 && b4(d, e - 20) === 0x07064b50;
  if (z64) {
    const ze = b4(d, e - 12);
    z64 = b4(d, ze) === 0x06064b50;
    if (z64) o = b4(d, ze + 48);
  }
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = b2(d, o + 28);
    const extraLen = b2(d, o + 30);
    const sc = b4(d, o + 20);
    const su = b4(d, o + 24);
    let off = b4(d, o + 42);
    if (z64 && off === 0xffff_ffff) {
      const skip = 8 * (Number(su === 0xffff_ffff) + Number(sc === 0xffff_ffff));
      const end = o + 46 + nameLen + extraLen;
      for (let x = o + 46 + nameLen; x + 4 < end; x += 4 + b2(d, x + 2)) {
        if (b2(d, x) === 1) {
          off = b8(d, x + 4 + skip);
          break;
        }
      }
    }
    starts.push(off + 30 + b2(d, off + 26) + b2(d, off + 28));
    o += 46 + nameLen + extraLen + b2(d, o + 32);
  }
  return starts;
}
