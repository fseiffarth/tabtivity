import { useEffect, useRef } from "react";

import { useModalFocus } from "../../hooks/useModalFocus";
import { useT } from "../../lib/i18n";
import { fmtSize } from "../../lib/viewers/fileUtils";
import { useProjectsStore } from "../../stores/projects";
import { useSyncConfirmStore, type SyncTransferPreview } from "../../stores/remote/syncConfirm";
import { UntestedTag } from "./UntestedTag";

/**
 * The confirmation every byte-sync transfer asks for, mounted once at the shell
 * like the HPC guard and the host-key prompt (a transfer can be started from the
 * file tree, the file view's toolbar, or the diverged-files list — in the main
 * window or in a popout — and they all ask through one dialog).
 *
 * What it is for: a pull writes the host's bytes over the mirror's and a push
 * writes the mirror's over the host's, so each is destructive to whichever side
 * is receiving. The old one-click buttons made the safe case (the other side has
 * nothing) and the lossy one (the other side has edits held nowhere else) look
 * identical. This states which one you are in — direction, scope, file count,
 * size, how much of it lands on top of something, and by name the files whose
 * content would be gone — and then gets out of the way.
 *
 * The numbers are the backend's read-only `sync_transfer_preview`. They may be
 * missing (still loading, failed, or a tree too big to inspect up front); the
 * dialog says so and keeps asking, because a preview is information and the
 * click is the gate.
 */
/**
 * The dialog's headline sentence, indexed by direction × does-it-replace-anything
 * × scope. Written out as a table rather than assembled from key fragments so
 * every sentence the dialog can show is greppable and type-checked as a
 * translation key.
 */
const BODY_KEYS = {
  pull: {
    over: {
      selected: "syncConfirm.pullSelected",
      project: "syncConfirm.pullProject",
      folder: "syncConfirm.pullFolder",
      file: "syncConfirm.pullFile",
    },
    new: {
      selected: "syncConfirm.pullSelectedNew",
      project: "syncConfirm.pullProjectNew",
      folder: "syncConfirm.pullFolderNew",
      file: "syncConfirm.pullFileNew",
    },
  },
  push: {
    over: {
      selected: "syncConfirm.pushSelected",
      project: "syncConfirm.pushProject",
      folder: "syncConfirm.pushFolder",
      file: "syncConfirm.pushFile",
    },
    new: {
      selected: "syncConfirm.pushSelectedNew",
      project: "syncConfirm.pushProjectNew",
      folder: "syncConfirm.pushFolderNew",
      file: "syncConfirm.pushFileNew",
    },
  },
} as const;

export function SyncConfirmDialog() {
  const t = useT();
  const pending = useSyncConfirmStore((s) => s.pending);
  const proceed = useSyncConfirmStore((s) => s.proceed);
  const cancel = useSyncConfirmStore((s) => s.cancel);

  // An ask speaks for the project it was made in. Switching project while it is
  // up must not leave it standing over another project's screen: it is withdrawn,
  // which its caller reads as "no".
  const activeId = useProjectsStore((s) => s.activeId);
  const seenActive = useRef(activeId);
  useEffect(() => {
    if (seenActive.current === activeId) return;
    seenActive.current = activeId;
    const p = useSyncConfirmStore.getState().pending;
    if (p && p.projectId !== activeId) cancel();
  }, [activeId, cancel]);

  const modalRef = useModalFocus(cancel, !!pending);
  if (!pending) return null;
  const { direction, isDir, relPath, label, relPaths, force, preview, doomed, loading, error } =
    pending;
  const deleteSide = pending.deleteSide;
  const pull = direction === "pull";
  // An explicit file list (the diverged-files view's bulk resolve) is its own
  // scope: it is neither the folder it happens to sit under nor the whole
  // project, and saying either would misstate what is about to be overwritten.
  const scope = relPaths
    ? "selected"
    : relPath === ""
      ? "project"
      : isDir
        ? "folder"
        : "file";
  // Nothing to move — offer only a way out rather than a confirm button that
  // would transfer nothing.
  const empty = !!preview && preview.files === 0;
  // Does the receiving side actually hold anything this would replace? Only an
  // EXACT preview can answer: `exact: false` means the tree was too big to stat
  // up front, and a missing preview means the check hasn't landed (or failed).
  // In both of those the destructive wording stands, because an unknown price is
  // not an implicit "nothing to lose". But when the answer is a settled zero —
  // a first push, a folder the host doesn't have — "will be written over the
  // host's copy" names a loss that cannot happen, and a warning that cries wolf
  // on the safe case is how the same warning stops being read on the lossy one.
  const replaces = !preview || !preview.exact || preview.overwrites > 0;

  // Propagating a one-sided deletion: no transfer preview applies — the question
  // is one named copy, and the load-bearing sentence is that it is the file's
  // LAST copy on either side (the other side is already gone).
  if (deleteSide) {
    const host = deleteSide === "host";
    return (
      <div className="modal-backdrop" onMouseDown={cancel}>
        <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <h2>
            {t(
              pending.hostOnly
                ? "syncConfirm.deleteHostOnlyTitle"
                : host
                  ? "syncConfirm.deleteHostTitle"
                  : "syncConfirm.deleteLocalTitle",
            )}{" "}
            <UntestedTag id="syncConfirmDialog.1" />
          </h2>
          <p>
            {pending.hostOnly
              ? relPaths
                ? t("syncConfirm.deleteHostOnlySelectedBody", { count: relPaths.length })
                : t("syncConfirm.deleteHostOnlyBody", { name: label })
              : relPaths
                ? t(host ? "syncConfirm.deleteHostSelectedBody" : "syncConfirm.deleteLocalSelectedBody", {
                    count: relPaths.length,
                  })
                : t(host ? "syncConfirm.deleteHostBody" : "syncConfirm.deleteLocalBody", {
                    name: label,
                  })}
          </p>
          {relPaths ? (
            <div className="sync-confirm-loss">
              <ul>
                {relPaths.slice(0, 20).map((rel) => (
                  <li key={rel}>{rel}</li>
                ))}
              </ul>
              {relPaths.length > 20 && (
                <span className="sync-confirm-note">
                  {t("syncConfirm.andMore", { count: (relPaths.length - 20).toLocaleString() })}
                </span>
              )}
            </div>
          ) : (
            <div className="file-delete-path">{relPath}</div>
          )}
          {loading && <p className="sync-confirm-note">{t("syncConfirm.checking")}</p>}
          {error && <p className="sync-confirm-note">{t("syncConfirm.previewFailed", { error })}</p>}
          {doomed &&
            (doomed.exists ? (
              <p className="sync-confirm-note">
                {t("syncConfirm.deleteDoomedMeta", {
                  size: fmtSize(doomed.size),
                  date:
                    doomed.mtime != null
                      ? new Date(doomed.mtime * 1000).toLocaleString()
                      : "—",
                })}
              </p>
            ) : (
              <p className="sync-confirm-note">{t("syncConfirm.deleteAlreadyGone")}</p>
            ))}
          <div className="sync-confirm-loss">
            <strong>{t("syncConfirm.deleteLastCopyNote")}</strong>
          </div>
          <div className="file-delete-actions">
            <button type="button" onClick={cancel}>
              {t("common.cancel")}
            </button>
            <button type="button" className="danger" onClick={proceed}>
              {t("syncConfirm.confirmDelete")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Take the newer copy for all: both directions in one ask, each side's files
  // named and priced on their own, so nothing about the act waits for a second
  // dialog.
  if (pending.newer) {
    const lists = { pull: pending.newer.host, push: pending.newer.local };
    const priced = pending.newerPreview;
    const lossy = !!priced && (priced.pull?.destructiveTotal ?? 0) + (priced.push?.destructiveTotal ?? 0) > 0;
    return (
      <div className="modal-backdrop" onMouseDown={cancel}>
        <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
          <h2>
            {t("syncConfirm.newerTitle")} <UntestedTag id="syncConfirmDialog.3" />
          </h2>
          <p>{t("syncConfirm.newerBody", { count: (lists.pull.length + lists.push.length).toLocaleString() })}</p>
          {loading && <p className="sync-confirm-note">{t("syncConfirm.checking")}</p>}
          {error && <p className="sync-confirm-note">{t("syncConfirm.previewFailed", { error })}</p>}
          {(["pull", "push"] as const).map((dir) => {
            const files = lists[dir];
            if (files.length === 0) return null;
            const facts = priced?.[dir];
            return (
              <div key={dir}>
                <p>
                  <strong>
                    {t(dir === "pull" ? "syncConfirm.newerPull" : "syncConfirm.newerPush", {
                      count: files.length.toLocaleString(),
                    })}
                  </strong>
                </p>
                <div className="file-delete-path">
                  {files.slice(0, 8).join(", ") + (files.length > 8 ? ", …" : "")}
                </div>
                {facts && <PreviewFacts preview={facts} pull={dir === "pull"} />}
              </div>
            );
          })}
          {force && <p className="sync-confirm-note">{t("syncConfirm.forceNote")}</p>}
          <div className="file-delete-actions">
            <button type="button" onClick={cancel}>
              {t("common.cancel")}
            </button>
            <button type="button" className={lossy ? "danger" : undefined} onClick={proceed}>
              {t("syncConfirm.confirmNewer")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // Backdrop-dismissable: "I didn't mean to click that" is the most likely
    // answer here and should cost exactly one click, in any direction.
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          {t(pull ? "syncConfirm.pullTitle" : "syncConfirm.pushTitle")} <UntestedTag id="syncConfirmDialog.2" />
        </h2>
        <p>
          {t(BODY_KEYS[pull ? "pull" : "push"][replaces ? "over" : "new"][scope], {
            name: label,
            count: relPaths?.length ?? 0,
          })}
        </p>
        <div className="file-delete-path">
          {relPaths
            ? relPaths.slice(0, 8).join(", ") +
              (relPaths.length > 8 ? ", …" : "")
            : relPath || t("syncConfirm.wholeProjectPath")}
        </div>

        {loading && <p className="sync-confirm-note">{t("syncConfirm.checking")}</p>}
        {error && <p className="sync-confirm-note">{t("syncConfirm.previewFailed", { error })}</p>}
        {preview && <PreviewFacts preview={preview} pull={pull} />}
        {force && <p className="sync-confirm-note">{t("syncConfirm.forceNote")}</p>}

        <div className="file-delete-actions">
          <button type="button" onClick={cancel}>
            {t("common.cancel")}
          </button>
          {!empty && (
            <button
              type="button"
              className={
                preview && preview.destructiveTotal > 0 ? "danger" : undefined
              }
              onClick={proceed}
            >
              {/* The button is a promise about what the click does, so it follows
                  the same settled-zero rule as the sentence above: "Overwrite
                  host" on a transfer that overwrites nothing is the same lie in
                  two words. */}
              {t(
                pull
                  ? replaces
                    ? "syncConfirm.confirmPull"
                    : "syncConfirm.confirmPullNew"
                  : replaces
                    ? "syncConfirm.confirmPush"
                    : "syncConfirm.confirmPushNew",
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What one priced direction would do: how much moves, how much lands on top of
 *  something, and by name the files whose content it ends. */
function PreviewFacts({ preview, pull }: { preview: SyncTransferPreview; pull: boolean }) {
  const t = useT();
  const empty = preview.files === 0;
  return (
    <>
      <p>
        {empty
          ? t(
              preview.tracked > 0
                ? "syncConfirm.onlyTracked"
                : "syncConfirm.nothingToTransfer",
              { count: preview.tracked.toLocaleString() },
            )
          : t("syncConfirm.willTransfer", {
              count: preview.files.toLocaleString(),
              size: fmtSize(preview.bytes),
            })}
      </p>
      {!preview.exact && !empty && (
        <p className="sync-confirm-note">{t("syncConfirm.notInspected")}</p>
      )}
      {preview.exact && preview.overwrites > 0 && (
        <p className="sync-confirm-note">
          {t(
            pull ? "syncConfirm.overwritesLocal" : "syncConfirm.overwritesHost",
            { count: preview.overwrites.toLocaleString() },
          )}
        </p>
      )}
      {preview.conflicts > 0 && (
        <p className="sync-confirm-note">
          {t("syncConfirm.blockedConflicts", {
            count: preview.conflicts.toLocaleString(),
          })}
        </p>
      )}
      {preview.tracked > 0 && !empty && (
        <p className="sync-confirm-note">
          {t("syncConfirm.trackedAsCommits", {
            count: preview.tracked.toLocaleString(),
          })}
        </p>
      )}
      {preview.destructiveTotal > 0 && (
        // The load-bearing part: these files hold changes that exist on no
        // other side, and this transfer is what ends them.
        <div className="sync-confirm-loss">
          <strong>
            {t(
              pull ? "syncConfirm.lossLocalTitle" : "syncConfirm.lossHostTitle",
              { count: preview.destructiveTotal.toLocaleString() },
            )}
          </strong>
          <ul>
            {preview.destructive.map((rel) => (
              <li key={rel}>{rel}</li>
            ))}
          </ul>
          {preview.destructiveTotal > preview.destructive.length && (
            <span className="sync-confirm-note">
              {t("syncConfirm.andMore", {
                count: (
                  preview.destructiveTotal - preview.destructive.length
                ).toLocaleString(),
              })}
            </span>
          )}
        </div>
      )}
    </>
  );
}
