/**
 * How the PDF viewer re-reads a file a compiler may still be writing: wait for its
 * size to settle, then retry a parse that caught it mid-write.
 */
import { fileSize } from "../../../lib/files/fileAccess";

/** A recompile rewrites the PDF in place, so a reload can catch the file
 *  mid-write and pdf.js throws `InvalidPDFException: Invalid PDF structure` on
 *  the truncated bytes. That is transient — the write finishes in well under a
 *  second — so a failed parse is retried a few times before it counts as a real
 *  error, at this spacing, while the last good document stays on screen. */
export const RELOAD_RETRY_MS = 250;
export const RELOAD_MAX_RETRIES = 12;

/** The stat-twice gate before a reload's read: the file's size must agree across
 *  two stats this far apart (a compiler writes a PDF in one go, so a size that
 *  held for this long is a finished one), for at most this many rounds before
 *  the read goes ahead regardless and the parse retry above takes over. */
export const RELOAD_SETTLE_MS = 300;
const RELOAD_SETTLE_ROUNDS = 10;

/**
 * Wait until the file's size holds still across two stats `RELOAD_SETTLE_MS`
 * apart, or `RELOAD_SETTLE_ROUNDS` have passed. A stat that fails, or a backend
 * without the command (a test's mocked `invoke`), ends the wait at once — the
 * read that follows carries its own retry.
 */
export async function settledFileSize(
  path: string,
  scope: string | null,
  cancelled: () => boolean,
): Promise<void> {
  let last: number | null = null;
  for (let round = 0; round < RELOAD_SETTLE_ROUNDS; round++) {
    let size: unknown;
    try {
      size = await fileSize(path, scope);
    } catch {
      return;
    }
    if (cancelled() || typeof size !== "number") return;
    if (last === size) return;
    last = size;
    await new Promise<void>((r) => setTimeout(r, RELOAD_SETTLE_MS));
    if (cancelled()) return;
  }
}
