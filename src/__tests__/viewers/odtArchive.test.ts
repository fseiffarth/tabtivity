/**
 * The ODT viewer's bounded unzip (#869): fflate sizes each output buffer from
 * the archive's declared size, so the declared sizes are checked before
 * anything inflates, and only the parts the renderer reads are inflated.
 */
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { unzipOdt, ODT_MAX_ENTRIES, ODT_MAX_INFLATED_BYTES, INFLATE_CHUNK } from "../../lib/viewers/odtArchive";
import { extractOdt } from "../../lib/viewers/odt";

const CONTENT = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>`;

/** Rewrite the central-directory "uncompressed size" of `name` to `size` — the
 *  field fflate allocates from. */
function claimSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let o = 0; o + 46 <= out.length; o++) {
    if (view.getUint32(o, true) !== 0x02014b50) continue;
    const len = view.getUint16(o + 28, true);
    const fn = new TextDecoder().decode(out.subarray(o + 46, o + 46 + len));
    if (fn === name) {
      view.setUint32(o + 24, size, true);
      return out;
    }
  }
  throw new Error(`no central entry for ${name}`);
}

describe("unzipOdt", () => {
  it("inflates content.xml and pictures, and nothing else", () => {
    const zip = zipSync({
      mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
      "content.xml": strToU8(CONTENT),
      "styles.xml": strToU8("<styles/>"),
      "meta.xml": strToU8("<meta/>"),
      "Thumbnails/thumbnail.png": new Uint8Array([1, 2, 3]),
      "Pictures/a.png": new Uint8Array([9, 9, 9]),
    });
    const entries = unzipOdt(zip);
    expect(Object.keys(entries).sort()).toEqual(["Pictures/a.png", "content.xml"]);
    const { contentXml, images } = extractOdt(entries);
    expect(contentXml).toBe(CONTENT);
    expect(images.has("Pictures/a.png")).toBe(true);
  });

  it("refuses a content.xml that declares more than the budget, before inflating it", () => {
    const zip = claimSize(
      zipSync({ "content.xml": strToU8(CONTENT) }),
      "content.xml",
      0x7fff_ffff,
    );
    expect(() => unzipOdt(zip)).toThrow(/too large to show here/);
  });

  it("never inflates an extra part, however large it claims to be", () => {
    const zip = claimSize(
      zipSync({ "content.xml": strToU8(CONTENT), "bomb.bin": new Uint8Array(1024) }),
      "bomb.bin",
      0xffff_fff0,
    );
    const entries = unzipOdt(zip);
    expect(Object.keys(entries)).toEqual(["content.xml"]);
  });

  it("skips pictures past the budget but still opens the document", () => {
    // The oversize picture is listed BEFORE content.xml: it must not spend the
    // body's budget, and it is dropped rather than refusing the file.
    const zip = claimSize(
      zipSync({ "Pictures/huge.png": new Uint8Array(16), "content.xml": strToU8(CONTENT), "Pictures/ok.png": new Uint8Array(4) }),
      "Pictures/huge.png",
      ODT_MAX_INFLATED_BYTES,
    );
    const entries = unzipOdt(zip);
    expect(Object.keys(entries).sort()).toEqual(["Pictures/ok.png", "content.xml"]);
  });

  it("inflates parts spanning many stream chunks byte for byte, stored and deflated", () => {
    // Pseudo-random bytes do not compress, so the deflated copy spans several
    // INFLATE_CHUNK pushes.
    const photo = new Uint8Array(5 * INFLATE_CHUNK + 123);
    let x = 0x2545f491;
    for (let i = 0; i < photo.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      photo[i] = x & 0xff;
    }
    const body = CONTENT + "<!--" + "lorem ipsum ".repeat(50_000) + "-->";
    const zip = zipSync({
      "content.xml": strToU8(body),
      "Pictures/deflated.png": photo,
      "Pictures/stored.png": [photo, { level: 0 }],
    });
    const entries = unzipOdt(zip);
    expect(new TextDecoder().decode(entries["content.xml"])).toBe(body);
    expect(entries["Pictures/deflated.png"]).toEqual(photo);
    expect(entries["Pictures/stored.png"]).toEqual(photo);
  });

  // The declared size bounds the buffer, not the work: fflate's inflateSync
  // decodes the whole stream into a buffer that size and silently drops the
  // rest, so a tiny declaration over a deflate bomb used to come back as a
  // truncated part after decoding every byte of it.
  for (const name of ["content.xml", "Pictures/bomb.png"]) {
    it(`refuses ${name} once it inflates past its declared size`, () => {
      const parts: Record<string, Uint8Array> = { "content.xml": strToU8(CONTENT) };
      parts[name] = new Uint8Array(8 * 1024 * 1024); // zeros: a ~8 KiB stream
      const zip = claimSize(zipSync(parts), name, 1024);
      expect(() => unzipOdt(zip)).toThrow(/too large to show here/);
    });
  }

  it("refuses an archive listing more entries than any document has", () => {
    const files: Record<string, Uint8Array> = { "content.xml": strToU8(CONTENT) };
    for (let i = 0; i < ODT_MAX_ENTRIES; i++) files[`x/${i}`] = new Uint8Array(0);
    expect(() => unzipOdt(zipSync(files, { level: 0 }))).toThrow(/too large to show here/);
  });
});
