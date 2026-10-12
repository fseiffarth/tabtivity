import { useModalFocus } from "../../hooks/useModalFocus";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { basename, fromFileUri } from "../../lib/paths";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

/**
 * Importing OS files into a project by dropping them onto a file view — shared
 * by the side panel and the "Files (Project)" tab, which must import
 * identically (same collision prompt, same destination folder rule).
 */

type ConflictChoice = "replace" | "rename" | "skip";

interface ConflictAnswer {
  choice: ConflictChoice;
  /** Apply the *choice* to every remaining collision. Deliberately carries no
   *  name: one typed name cannot serve N files, so the rest keep both under the
   *  automatic " (n)" — which the prompt says on its face. */
  all: boolean;
  /** The name a "keep both" was given, when the user changed the suggestion. */
  name?: string;
}

/** Heuristic: is this drag an external OS file drag (vs. an internal pill/text
 *  drag)? `dragDropEnabled` stays false so HTML5 DnD keeps working for the
 *  app's pointer/HTML drags; an OS file drag advertises Files/uri-list/html
 *  (WebKitGTK uses text/html here). During dragover WebKit may hide the type
 *  list, so an empty list is treated as a file drag too. */
export function isExternalFileDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types ?? []);
  if (types.length === 0) return true;
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html")
  );
}

/** Extract absolute local paths from an OS HTML5 file drop. WebKitGTK withholds
 *  `Files`/`text/uri-list` data here but leaks the `file://` URL inside
 *  `text/html`, so scan every text payload for `file://` URIs and dedupe.
 *  NOTE: this drag path is best-effort — some file managers only expose ONE
 *  file this way. Use the Import button for reliable multi-file selection. */
export function parseDroppedFilePaths(dataTransfer: DataTransfer): string[] {
  const sources = [
    dataTransfer.getData("text/uri-list"),
    dataTransfer.getData("text/plain"),
    dataTransfer.getData("text/html"),
  ];
  const FILE_URI = /file:\/\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of sources) {
    if (!raw) continue;
    for (const match of raw.match(FILE_URI) ?? []) {
      const p = fromFileUri(match);
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

/** A name's stem and extension, split the way Rust's `Path::extension` does —
 *  a leading-dot name with no other dot (".gitignore") has none, so a suffix
 *  lands at the end rather than inside it. Kept in step with `unique_dest` so
 *  the suggested "keep both" name is the one the backend would have picked. */
export function splitFileName(name: string): { stem: string; ext: string | null } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: null };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/** `stem (n).ext` — the shape the backend's own collision fallback produces. */
export function suffixedName(name: string, n: number): string {
  const { stem, ext } = splitFileName(name);
  return ext ? `${stem} (${n}).${ext}` : `${stem} (${n})`;
}

/** The first free " (n)" name in the destination folder, probed rather than
 *  assumed so the prompt's field opens on the name Keep both would actually
 *  produce. Bounded far below the backend's own 10k because this is a
 *  suggestion, not the decision: the import re-runs `unique_dest` on whatever
 *  is typed, so a suggestion that has gone stale by the time the button is
 *  pressed is suffixed again rather than overwriting anything. */
async function suggestKeepBothName(
  projectDir: string,
  destRel: string,
  name: string,
): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const candidate = suffixedName(name, n);
    const rel = destRel ? `${destRel}/${candidate}` : candidate;
    const exists = await invoke<boolean>("project_path_exists", {
      projectDir,
      relPath: rel,
    }).catch(() => null);
    if (exists === null) break; // probe failed — offer the first form and let the backend decide
    if (!exists) return candidate;
  }
  return suffixedName(name, 1);
}

interface Options {
  /** Destination project root. Empty disables the drop. */
  projectDir: string;
  /** False for a box scope: several roots, so no single destination. */
  enabled: boolean;
  /** Project-relative folder the files land in, read at drop time. */
  destRel: string;
  /** Fired once the whole batch has been copied (e.g. to refresh git). */
  onImported?: () => void;
}

/**
 * OS file drop → copy into the project, prompting on name collisions. Returns
 * the drag handlers to spread onto the drop zone, the classes that paint it,
 * the conflict modal to render, and the file-picker fallback (WebKitGTK only
 * leaks one path per drag, so the picker is the reliable multi-file route).
 */
export function useImportDrop({ projectDir, enabled, destRel, onImported }: Options) {
  const t = useT();
  const [dropActive, setDropActive] = useState(false);
  const [dropFlash, setDropFlash] = useState(false);
  const [conflict, setConflict] = useState<{
    name: string;
    /** Destination folder, named so the user can see *which* copy collided. */
    folder: string;
    remaining: number;
    resolve: (r: ConflictAnswer) => void;
  } | null>(null);
  const [conflictAll, setConflictAll] = useState(false);
  /** The "keep both, as" field — pre-filled with the free " (n)" name. */
  const [conflictName, setConflictName] = useState("");
  const [conflictError, setConflictError] = useState<string | null>(null);
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canImport = enabled && !!projectDir;

  // The import runs asynchronously across a batch, so read the destination and
  // the completion callback from refs — a folder change mid-import must not
  // strand the loop on a stale closure.
  const destRelRef = useRef(destRel);
  destRelRef.current = destRel;
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  useEffect(() => {
    return () => {
      if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    };
  }, []);

  const flashDrop = () => {
    if (dropFlashTimer.current) clearTimeout(dropFlashTimer.current);
    setDropFlash(false);
    requestAnimationFrame(() => setDropFlash(true));
    dropFlashTimer.current = setTimeout(() => setDropFlash(false), 500);
  };

  // Ask the user how to resolve a name collision; resolves via the modal's
  // buttons. Returns the choice, whether to apply it to all remaining, and the
  // name a "keep both" was given.
  const askConflict = (name: string, folder: string, remaining: number, suggested: string) =>
    new Promise<ConflictAnswer>((resolve) => {
      setConflictAll(false);
      setConflictName(suggested);
      setConflictError(null);
      setConflict({ name, folder, remaining, resolve });
    });

  // Copy each absolute source path into the project, prompting on collisions.
  const importPaths = (paths: string[]) => {
    if (!canImport || !projectDir || paths.length === 0) return;
    flashDrop();
    const destRelAtDrop = destRelRef.current;
    void (async () => {
      let blanket: ConflictChoice | null = null;
      for (let i = 0; i < paths.length; i++) {
        const sourcePath = paths[i];
        const name = basename(sourcePath) || sourcePath;
        const rel = destRelAtDrop ? `${destRelAtDrop}/${name}` : name;
        let choice: ConflictChoice = "rename";
        // Only ever set by the prompt, so a blanket "keep both" over the rest of
        // the batch falls back to the automatic " (n)" rather than reusing one
        // typed name for every file.
        let destName: string | undefined;
        const exists = await invoke<boolean>("project_path_exists", { projectDir, relPath: rel }).catch(() => false);
        if (exists) {
          if (blanket) {
            choice = blanket;
          } else {
            const suggested = await suggestKeepBothName(projectDir, destRelAtDrop, name);
            const res = await askConflict(name, destRelAtDrop, paths.length - 1 - i, suggested);
            setConflict(null);
            choice = res.choice;
            destName = res.name;
            if (res.all) blanket = res.choice;
          }
        }
        if (choice === "skip") continue;
        try {
          await invoke("import_external_file", {
            projectDir,
            sourcePath,
            destRel: destRelAtDrop,
            replace: choice === "replace",
            destName: destName ?? null,
          });
        } catch (err) {
          console.error("import_external_file", sourcePath, err);
        }
      }
      // The tree auto-reloads via its fs-watch; the host may still want to
      // refresh anything derived from the files (e.g. git status counts).
      onImportedRef.current?.();
    })();
  };

  // HTML5 drag-and-drop (dragDropEnabled stays false so pointer drags — tabs,
  // splits, pills — keep working). Best-effort: WebKitGTK only leaks file paths
  // via text/html and sometimes just one; the Import button is the reliable
  // multi-file path.
  const onDragOver = (e: React.DragEvent) => {
    if (!canImport || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropActive(false);
  };

  const onDrop = (e: React.DragEvent) => {
    setDropActive(false);
    if (!canImport || !isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    importPaths(parseDroppedFilePaths(e.dataTransfer));
  };

  // Reliable multi-file import: native OS file picker → same copy+conflict flow.
  const importViaDialog = async () => {
    if (!canImport) return;
    const picked = await openDialog({ multiple: true, directory: false }).catch(() => null);
    if (!picked) return;
    importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // Same flow, but for whole folders: the backend's copy already recurses
  // (`import_external_file` → `copy_recursive`), so this is just a directory
  // picker feeding the same importPaths pipeline.
  const importFolderViaDialog = async () => {
    if (!canImport) return;
    const picked = await openDialog({ multiple: true, directory: true }).catch(() => null);
    if (!picked) return;
    importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // The name a "keep both" would land under. Trimmed here rather than at the
  // button, so the disabled state and what is sent cannot disagree.
  const keepBothName = conflictName.trim();

  const skip = () => conflict?.resolve({ choice: "skip", all: conflictAll });

  const keepBoth = () => {
    if (!conflict || !keepBothName) return;
    // A separator would place the copy outside the folder that was dropped
    // onto — refused here rather than left to the backend, so the message lands
    // next to the field that caused it. (The backend refuses it again.)
    if (keepBothName.includes("/") || keepBothName.includes("\\")) {
      setConflictError(t("fileTree.invalidFileName"));
      return;
    }
    conflict.resolve({ choice: "rename", all: conflictAll, name: keepBothName });
  };
  const modalRef = useModalFocus(skip, !!conflict);

  const conflictModal = conflict
    ? createPortal(
        <div className="modal-backdrop" onMouseDown={skip}>
          {/* Wears the file-operation overlay every other prompt in these views
              wears (delete, rename, paste) — this one used to be built out of
              the settings design system instead, which is why it sat flush
              against its own edges: `.settings-dialog` carries no padding of its
              own, expecting a `.dialog-scroll` child this dialog never had. */}
          <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" className="file-delete-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>
              {t("importDrop.title")} <UntestedTag id="importDrop.title" />
            </h2>
            <p>
              <strong>{conflict.name}</strong> {t("importDrop.existsIn")}{" "}
              <strong>{conflict.folder || t("fileTree.projectRootFolder")}</strong>
              {t("importDrop.existsPost")}
            </p>
            <input
              className="file-paste-name"
              autoFocus
              spellCheck={false}
              aria-label={t("importDrop.keepBothAs")}
              value={conflictName}
              onChange={(e) => {
                setConflictName(e.target.value);
                setConflictError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") keepBoth();
              }}
              // Selects the stem, not the extension — the rename dialog's rule,
              // and here the stem is the half the " (n)" was appended to.
              onFocus={(e) => {
                const dot = conflictName.lastIndexOf(".");
                e.currentTarget.setSelectionRange(0, dot > 0 ? dot : conflictName.length);
              }}
            />
            {conflictError && <ErrorNote className="file-delete-path file-delete-error" error={conflictError} />}
            {conflict.remaining > 0 && (
              <>
                <label className="file-delete-check">
                  <input
                    type="checkbox"
                    checked={conflictAll}
                    onChange={(e) => setConflictAll(e.target.checked)}
                  />
                  <span>
                    {t(
                      conflict.remaining > 1
                        ? "importDrop.applyToRemainingMany"
                        : "importDrop.applyToRemainingOne",
                      { count: conflict.remaining },
                    )}
                  </span>
                </label>
                {/* Said on its face rather than by disabling the box: the
                    checkbox carries the *choice*, and one typed name cannot
                    serve N files. */}
                <p className="file-delete-note">{t("importDrop.applyNameCaveat")}</p>
              </>
            )}
            <div className="file-delete-actions">
              <button type="button" onClick={skip}>
                {t("importDrop.skip")}
              </button>
              <button type="button" onClick={keepBoth} disabled={!keepBothName}>
                {t("importDrop.keepBoth")}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => conflict.resolve({ choice: "replace", all: conflictAll })}
              >
                {t("importDrop.replace")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return {
    canImport,
    dropActive,
    dropFlash,
    importViaDialog,
    importFolderViaDialog,
    conflictModal,
    handlers: {
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave,
      onDrop,
    },
  };
}
