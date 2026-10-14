/**
 * Hand-built PDFs for the tests that run the REAL pdf.js (`realPdfjs.ts`).
 *
 * A binary fixture would hide what the test depends on; these are a few lines of
 * PDF syntax each, assembled with a correct cross-reference table so pdf.js
 * parses them as written rather than through its broken-file recovery path.
 * ASCII only: every offset below is a character offset.
 */
// @ts-expect-error node:crypto has no type declarations in this project (no @types/node)
import { createHash as nodeCreateHash } from "node:crypto";

/** The one `node:crypto` call used here, typed. */
const createHash = nodeCreateHash as (algorithm: "md5") => {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
};

/** `<<dict /Length n>> stream … endstream` for an ASCII content stream. */
export function stream(dict: string, content: string): string {
  return `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

/**
 * A PDF whose object `i + 1` is `objects[i]` and whose catalog is object 1.
 * Refer to object n as `n 0 R`. `trailer` adds entries to the trailer dict.
 */
export function assemblePdf(objects: readonly string[], trailer = ""): Uint8Array {
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** One page, `text` in 12pt Helvetica at (72, 700) on a `w × h` page. */
export function onePagePdf(text: string, w = 612, h = 792): Uint8Array {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    stream("", `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

// ── Standard security handler, revision 2 (ISO 32000-1, the RC4 algorithms) ───

const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padded(password: string): Uint8Array {
  const out = new Uint8Array(32);
  const pw = new TextEncoder().encode(password).slice(0, 32);
  out.set(pw);
  out.set(PASSWORD_PAD.slice(0, 32 - pw.length), pw.length);
  return out;
}

function md5(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A one-page PDF that needs `userPassword` to open (40-bit RC4). Its content is
 * never decrypted by anything under test — what matters is that the reader has
 * to ask for the password.
 */
export function encryptedPdf(userPassword: string): Uint8Array {
  const id = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1);
  const permissions = -4; // every permission bit set
  const owner = rc4(md5(padded("owner")).slice(0, 5), padded(userPassword));
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, permissions, true);
  const key = md5(padded(userPassword), owner, p, id).slice(0, 5);
  const user = rc4(key, PASSWORD_PAD);
  return assemblePdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      `<< /Filter /Standard /V 1 /R 2 /O <${hex(owner)}> /U <${hex(user)}> /P ${permissions} >>`,
    ],
    `/Encrypt 4 0 R /ID [<${hex(id)}> <${hex(id)}>] `,
  );
}
