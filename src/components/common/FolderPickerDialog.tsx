import { useModalFocus } from "../../hooks/useModalFocus";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeName } from "../projects/scaffold";
import { useT } from "../../lib/i18n";
import { isPathWithin } from "../../lib/paths";
import { ArrowUpIcon, FolderIcon } from "./icons/Icon";

/** One subdirectory row, mirroring the Rust `DirEntry` (commands::fs). */
interface DirEntry {
  name: string;
  path: string;
}

/** The listing returned by the `list_dirs` command (Rust `DirListing`). */
interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

interface Props {
  /** Directory to open the browser at (defaults to home when empty/omitted). */
  initialPath?: string;
  title: string;
  /**
   * Keep the browse inside this directory: ⬆ stops at it, and a folder that
   * resolves outside it (a symlink out of the tree) is refused rather than
   * entered. Omit for an unbounded browse.
   */
  boundPath?: string;
  /** Label for the confirm button (e.g. "Move here"). */
  confirmLabel: string;
  /**
   * When set, render a labeled text input for a folder name (its sanitized form
   * is previewed live). The entered value is passed as the second `onConfirm`
   * arg. Omit to keep the picker a pure directory chooser.
   */
  nameLabel?: string;
  /** Initial value for the optional name field. */
  nameInitial?: string;
  /**
   * Offer a "New folder" action that creates a sub-folder of the browsed
   * directory (local fs, confined to it via `create_dir`) and enters it.
   */
  allowCreateFolder?: boolean;
  /**
   * Called with the currently-browsed directory when the user confirms. When a
   * name field is shown (`nameLabel`), the entered folder name is passed too.
   */
  onConfirm: (dir: string, name?: string) => void;
  onClose: () => void;
}

/**
 * An in-app ("native to Tabtivity") folder-browser popup — an alternative to the OS
 * folder-chooser dialog. Browses the local filesystem via the unconfined
 * `list_dirs` command: click a folder to descend, ⬆ to go up, then confirm to
 * return the current directory. Follows the app modal convention (portal +
 * `.modal-backdrop` + a settings-style dialog).
 */
export function FolderPickerDialog({ initialPath, boundPath, title, confirmLabel, nameLabel, nameInitial, allowCreateFolder, onConfirm, onClose }: Props) {
  const t = useT();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(nameInitial ?? "");
  // Inline "New folder" row: null = closed, a string = the name being typed.
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The bound as `list_dirs` spells it (canonicalized), so listings — which
  // come back canonicalized too — compare against the same form.
  const [bound, setBound] = useState<string | null>(null);

  const load = useCallback((path: string, within: string | null) => {
    setLoading(true);
    setError(null);
    invoke<DirListing>("list_dirs", { path })
      .then((res) => {
        if (within && !isPathWithin(res.path, within)) {
          setError(t("folderPicker.outsideBound", { path: within }));
          return;
        }
        setListing(res);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    const start = initialPath?.trim() || "";
    if (!boundPath?.trim()) {
      setBound(null);
      load(start, null);
      return;
    }
    let cancelled = false;
    invoke<DirListing>("list_dirs", { path: boundPath })
      .then((res) => {
        if (cancelled) return;
        setBound(res.path);
        load(start || res.path, res.path);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [load, initialPath, boundPath]);

  useEffect(() => {
    setName(nameInitial ?? "");
  }, [nameInitial]);

  const modalRef = useModalFocus(() => {
    if (newFolder !== null) { setNewFolder(null); setCreateError(null); }
    else onClose();
  });

  const cur = listing?.path ?? initialPath ?? "";

  const newFolderName = newFolder?.trim() ?? "";
  // One path segment only: the create is relative to the browsed folder, and
  // the backend's confinement would refuse anything climbing out anyway.
  const newFolderInvalid = newFolderName === "." || newFolderName === ".." || /[/\\]/.test(newFolderName);
  const createFolder = () => {
    if (!listing || !newFolderName || newFolderInvalid || creating) return;
    setCreating(true);
    setCreateError(null);
    invoke("create_dir", { projectDir: listing.path, relPath: newFolderName })
      .then(() => {
        setNewFolder(null);
        const sep = listing.path.includes("\\") && !listing.path.includes("/") ? "\\" : "/";
        load(listing.path.replace(/[/\\]+$/, "") + sep + newFolderName, bound);
      })
      .catch((e) => setCreateError(String(e)))
      .finally(() => setCreating(false));
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="settings-dialog folder-picker-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{title}</h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="folder-picker-nav">
          <button
            type="button"
            disabled={!listing?.parent || (bound !== null && !isPathWithin(listing.parent, bound))}
            onClick={() => listing?.parent && load(listing.parent, bound)}
            title={t("folderPicker.upOneFolder")}
          >
            <ArrowUpIcon /> {t("folderPicker.up")}
          </button>
          <span className="folder-picker-cur" title={cur}>{cur || "…"}</span>
          {allowCreateFolder && (
            <button
              type="button"
              disabled={!listing || newFolder !== null}
              onClick={() => { setNewFolder(""); setCreateError(null); }}
              title={t("folderPicker.newFolderTitle")}
            >
              ＋ {t("folderPicker.newFolder")}
            </button>
          )}
        </div>

        {newFolder !== null && (
          <div className="folder-picker-name-row">
            <div className="folder-picker-name-label folder-picker-new-folder">
              <input
                type="text"
                value={newFolder}
                autoFocus
                spellCheck={false}
                placeholder={t("folderPicker.newFolderPlaceholder")}
                aria-label={t("folderPicker.newFolder")}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createFolder(); } }}
              />
              <button
                type="button"
                className="primary"
                disabled={!newFolderName || newFolderInvalid || creating}
                onClick={createFolder}
              >
                {t("folderPicker.create")}
              </button>
              <button type="button" onClick={() => { setNewFolder(null); setCreateError(null); }}>
                {t("common.cancel")}
              </button>
            </div>
            {(newFolderInvalid || createError) && (
              <span className="settings-help folder-picker-error folder-picker-name-preview">
                {newFolderInvalid ? t("folderPicker.newFolderInvalid") : createError}
              </span>
            )}
          </div>
        )}

        <div className="folder-picker-list">
          {error ? (
            <p className="settings-help folder-picker-error">{error}</p>
          ) : loading && !listing ? (
            <p className="settings-help">{t("common.loading")}</p>
          ) : listing && listing.entries.length === 0 ? (
            <p className="settings-help">{t("folderPicker.noSubfolders")}</p>
          ) : (
            listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="folder-picker-item"
                onClick={() => load(entry.path, bound)}
                title={entry.path}
              >
                <span className="folder-picker-icon"><FolderIcon /></span>
                <span className="folder-picker-name">{entry.name}</span>
              </button>
            ))
          )}
        </div>

        {nameLabel !== undefined && (
          <div className="folder-picker-name-row">
            <label className="folder-picker-name-label">
              <span>{nameLabel}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            </label>
            <span className="settings-help folder-picker-name-preview">
              {t("folderPicker.folderPrefix")} {sanitizeName(name) || "…"}
            </span>
          </div>
        )}

        <div className="folder-picker-actions">
          <button type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button
            type="button"
            className="primary"
            disabled={!cur || (bound !== null && (!listing || !isPathWithin(listing.path, bound)))}
            onClick={() => onConfirm(cur, nameLabel !== undefined ? name : undefined)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
