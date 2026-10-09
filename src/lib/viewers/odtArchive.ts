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
 */
import { unzipSync, type UnzipFileInfo } from "fflate";
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

  let at = 0;
  return unzipSync(bytes, { filter: () => take[at++] === true });
}
