import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { hpcGuardRefusal, withHpcConfirm } from "../../lib/remote/hpc/hpcGuard";
import { basename } from "../../lib/paths";
import {
  useSyncStore,
  type HostNewScan,
  type SyncEntryStatus,
  type SyncSkippedFile,
} from "../../stores/remote/sync";
import { confirmSyncTransfer } from "../../stores/remote/syncConfirm";
import { ErrorNote } from "../common/ErrorNote";
import { ArrowDownIcon, SearchIcon, TrashIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { SyncSkippedLarge } from "./SyncSkippedLarge";

/**
 * The diverged view's **remote-only** section: files the host holds that the
 * local mirror never had. The amber list only knows files the manifest has
 * seen and the local-new list only walks the mirror, so nothing else ever
 * names them. Finding them is a recursive host walk (`sync_scan_host_new`), so
 * it runs on the button, never on the status refresh — and on a host tagged
 * HPC only after the guard dialog. The result is a snapshot: a pulled file
 * leaves it once the status lists it, a deleted one as soon as it is gone.
 */
export function SyncHostOnlyFiles({
  projectId,
  label,
  remoteBlocked,
  syncMap,
}: {
  projectId: string;
  label: string;
  remoteBlocked: boolean;
  syncMap: Record<string, SyncEntryStatus> | undefined;
}) {
  const t = useT();
  const [scan, setScan] = useState<HostNewScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set());
  const [skipped, setSkipped] = useState<SyncSkippedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A snapshot of another project's host means nothing here.
  useEffect(() => {
    setScan(null);
    setDeleted(new Set());
    setSkipped(null);
    setError(null);
  }, [projectId]);

  // A pulled file gets a manifest entry (and its own row elsewhere, if any).
  const files = (scan?.files ?? []).filter((f) => !syncMap?.[f.relPath] && !deleted.has(f.relPath));
  const rels = files.map((f) => f.relPath);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    setSkipped(null);
    try {
      const result = await withHpcConfirm((confirmed) =>
        useSyncStore.getState().scanHostNew(projectId, confirmed),
      );
      setScan(result);
      setDeleted(new Set());
    } catch (e) {
      // A declined HPC confirmation is an answer, not an error.
      if (!hpcGuardRefusal(e)) setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const pull = async (paths: string[]) => {
    const one = paths.length === 1;
    const ok = await confirmSyncTransfer({
      projectId,
      direction: "pull",
      relPath: one ? paths[0] : "",
      isDir: !one,
      label: one ? basename(paths[0]) || paths[0] : label,
      relPaths: one ? undefined : paths,
    });
    if (!ok) return;
    setError(null);
    setSkipped(null);
    const outcome = await useSyncStore.getState().resolveAll(projectId, paths, "host");
    setSkipped(outcome.skipped);
    if (outcome.failed > 0)
      setError(t("projectFilesView.resolveFailed", { count: outcome.failed, error: outcome.firstError ?? "" }));
  };

  const remove = async (paths: string[]) => {
    const one = paths.length === 1;
    const ok = await confirmSyncTransfer({
      projectId,
      deleteSide: "host",
      hostOnly: true,
      relPath: one ? paths[0] : "",
      isDir: !one,
      label: one ? basename(paths[0]) || paths[0] : label,
      relPaths: one ? undefined : paths,
    });
    if (!ok) return;
    setError(null);
    const outcome = await useSyncStore.getState().applyDeleteAll(projectId, paths, "host");
    const failed = new Set(outcome.failedPaths);
    setDeleted((prev) => new Set([...prev, ...paths.filter((p) => !failed.has(p))]));
    if (outcome.failed > 0)
      setError(t("projectFilesView.resolveFailed", { count: outcome.failed, error: outcome.firstError ?? "" }));
  };

  return (
    <>
      <div className="orange-bulk-bar">
        <span className="orange-bulk-count">
          {scanning
            ? t("projectFilesView.scanningHost")
            : scan
              ? rels.length > 0
                ? t("projectFilesView.hostOnlyCount", { count: rels.length })
                : t("projectFilesView.hostOnlyNone")
              : t("projectFilesView.scanHost")}
        </span>
        <UntestedTag id="syncHostOnlyFiles.scan" />
        <div className="orange-file-actions">
          <button
            type="button"
            className="orange-file-act orange-file-act--icon"
            aria-label={t("projectFilesView.scanHost")}
            title={t("projectFilesView.scanHostTitle")}
            disabled={remoteBlocked || scanning}
            onClick={() => void runScan()}
          >
            <SearchIcon />
          </button>
          {rels.length > 0 && (
            <>
              <button
                type="button"
                className="orange-file-act orange-file-act--icon orange-file-act--remote"
                aria-label={t("projectFilesView.pullHostOnlyAllAria")}
                title={t("projectFilesView.pullHostOnlyAllTitle")}
                disabled={remoteBlocked}
                onClick={() => void pull(rels)}
              >
                <ArrowDownIcon />
              </button>
              <button
                type="button"
                className="orange-file-act orange-file-act--icon orange-file-act--delete"
                aria-label={t("projectFilesView.deleteHostOnlyAllAria")}
                title={t("projectFilesView.deleteHostOnlyAllTitle")}
                disabled={remoteBlocked}
                onClick={() => void remove(rels)}
              >
                <TrashIcon />
              </button>
            </>
          )}
        </div>
      </div>
      {scan?.truncated && (
        <div className="side-panel-orange-empty">
          {t("projectFilesView.hostOnlyTruncated")}
        </div>
      )}
      {error && <ErrorNote className="project-files-sync-result" role="alert" error={error} />}
      {skipped && skipped.length > 0 && (
        <div className="project-files-sync-result" role="status">
          <span>
            <SyncSkippedLarge files={skipped} lead={false} />
          </span>
        </div>
      )}
      {files.map((f) => (
        <div key={f.relPath} className="orange-file-row" title={f.relPath}>
          <span className="orange-file-name">
            <span className="orange-file-dot" aria-hidden="true">
              −
            </span>
            {f.relPath}
          </span>
          <div className="orange-file-actions">
            <button
              type="button"
              className="orange-file-act orange-file-act--icon orange-file-act--remote"
              aria-label={t("projectFilesView.pullHostOnlyAria")}
              title={t("projectFilesView.pullHostOnlyTitle")}
              disabled={remoteBlocked}
              onClick={() => void pull([f.relPath])}
            >
              <ArrowDownIcon />
            </button>
            <button
              type="button"
              className="orange-file-act orange-file-act--icon orange-file-act--delete"
              aria-label={t("projectFilesView.deleteHostOnlyAria")}
              title={t("projectFilesView.deleteHostOnlyTitle")}
              disabled={remoteBlocked}
              onClick={() => void remove([f.relPath])}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
