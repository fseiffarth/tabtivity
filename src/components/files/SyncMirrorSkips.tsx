import { useState } from "react";
import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/formatBytes";
import { useSyncStore, type SyncMirrorSkip } from "../../stores/remote/sync";
import { UntestedTag } from "../common/UntestedTag";

const KEYS = {
  link: "projectFilesPane.syncMirrorSkipLink",
  special: "projectFilesPane.syncMirrorSkipSpecial",
  tooLarge: "projectFilesPane.syncMirrorSkipTooLarge",
} as const;

/**
 * The per-project notice of mirror files a push left alone: a link (or a file
 * behind a linked folder), a FIFO/device where a file was, or one over the cap.
 * The mirror is writable by a fenced agent, so these are never read for a push
 * (gap 46); before, they were skipped with only a log line. Fed by the
 * `auto-sync` event and a manual push's result; nothing when nothing was
 * skipped. Dismissing hides the current list until it changes.
 */
export function SyncMirrorSkips({ projectId }: { projectId: string | undefined }) {
  const t = useT();
  const skips = useSyncStore((s) => (projectId ? s.skippedUnsafeByProject[projectId] : undefined));
  const [dismissed, setDismissed] = useState("");
  if (!skips || skips.total === 0) return null;
  const signature = skips.items.map((i) => `${i.rel}:${i.kind}`).join("\n") + `#${skips.total}`;
  if (dismissed === signature) return null;
  const line = (i: SyncMirrorSkip) =>
    `${i.rel} (${t(KEYS[i.kind], { size: formatBytes(i.size ?? 0) })})`;
  return (
    <div className="project-files-sync-result project-files-sync-result--bad" role="status">
      <span>
        {t("projectFilesPane.syncMirrorSkipped", { count: skips.total })}{" "}
        <UntestedTag id="projectFilesPane.syncMirrorSkipped" />
        <code className="error-note-raw">{skips.items.map(line).join("\n")}</code>
      </span>
      <button
        className="file-tree-up"
        onClick={() => setDismissed(signature)}
        title={t("common.close")}
        aria-label={t("common.close")}
      >
        ×
      </button>
    </div>
  );
}
