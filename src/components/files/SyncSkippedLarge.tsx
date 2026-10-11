import { useState } from "react";
import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/formatBytes";
import type { SyncSkippedFile } from "../../stores/remote/sync";
import { UntestedTag } from "../common/UntestedTag";

/** Up to this many skipped files are listed at once; more fold behind a toggle. */
const INLINE_MAX = 3;

/**
 * The part of a pull's result line that names the files over the 64 MiB cap
 * the pull left on the host (gap 35). Before, they were skipped with only a
 * log line and the pull read as complete — a research dataset just went
 * missing from the mirror. Rendered inside the existing
 * `.project-files-sync-result` line (Remote tree pull, *Sync all*), with
 * `ErrorNote`'s disclosure: an inline link button and the raw list in
 * `.error-note-raw`. Nothing when nothing was skipped. `lead` puts a ` · `
 * before it, for when it follows the line's own text.
 */
export function SyncSkippedLarge({ files, lead = true }: { files: SyncSkippedFile[]; lead?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  const folds = files.length > INLINE_MAX;
  return (
    <>
      {lead && " · "}
      {t("projectFilesPane.syncSkippedLarge", { count: files.length })}{" "}
      <UntestedTag id="projectFilesPane.syncSkippedLarge" />
      {folds && (
        <>
          {" "}
          <button
            type="button"
            className="inline-link-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t("projectFilesPane.syncSkippedHide") : t("projectFilesPane.syncSkippedShow")}
          </button>
        </>
      )}
      {(!folds || open) && (
        <code className="error-note-raw">
          {files.map((f) => `${f.rel} (${formatBytes(f.size)})`).join("\n")}
        </code>
      )}
    </>
  );
}
