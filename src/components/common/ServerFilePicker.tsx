import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useModalFocus } from "../../hooks/useModalFocus";
import { useT } from "../../lib/i18n";
import { fmtSize } from "../../lib/viewers/fileUtils";
import { ArrowUpIcon, FolderIcon } from "./icons/Icon";
import { FileIcon } from "./icons/FileIcon";
import { UntestedTag } from "./UntestedTag";

/** One row of the Rust `FileListing` (`commands::fs::list_dir_all`). */
interface DirRow {
  name: string;
  path: string;
}
interface FileRow extends DirRow {
  size: number;
}
interface FileListing {
  path: string;
  parent: string | null;
  dirs: DirRow[];
  files: FileRow[];
}

export interface ServerFilePickerProps {
  /** `open` (pick existing) or `save` (type a name in a folder). */
  mode: "open" | "save";
  title?: string;
  /** `open` only: pick a folder instead of a file. */
  directory?: boolean;
  /** `open` only: several files. */
  multiple?: boolean;
  /** Folder (or file, whose folder is used) to start in. */
  defaultPath?: string;
  /** `@tauri-apps/plugin-dialog`'s filters: extensions without the dot. */
  filters?: { name: string; extensions: string[] }[];
  /** `open`: the path or paths (per `multiple`); `save`: the full path. */
  onPick: (picked: string | string[]) => void;
  onCancel: () => void;
}

/**
 * The browser desktop client's file dialog (hosted plan §3.5): the OS picker
 * has no counterpart in a browser, and a browser `<input type=file>` would
 * pick from the laptop — the wrong machine. This browses the **server's**
 * filesystem through `list_dir_all` (unconfined, like the folder picker's
 * `list_dirs`: what it replaces was not confined either), with the same look
 * as `FolderPickerDialog`. "Upload from this computer" is deliberately not
 * here; it is a separate, explicit action when a feature needs one.
 */
export function ServerFilePicker({ mode, title, directory = false, multiple = false, defaultPath, filters, onPick, onCancel }: ServerFilePickerProps) {
  const t = useT();
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveName, setSaveName] = useState(() => (mode === "save" && defaultPath ? defaultPath.split(/[/\\]/).pop() ?? "" : ""));

  const extensions = useMemo(() => {
    const all = (filters ?? []).flatMap((f) => f.extensions.map((e) => e.toLowerCase().replace(/^\./, "")));
    return all.length ? new Set(all) : null;
  }, [filters]);

  const load = useCallback(
    (path: string) => {
      setLoading(true);
      setError(null);
      invoke<FileListing>("list_dir_all", { path })
        .then((res) => {
          setListing(res);
          setSelected(new Set());
        })
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    },
    [],
  );

  useEffect(() => {
    // A default path naming a file starts in its folder; a bare folder in it.
    const start = defaultPath?.trim() ?? "";
    const looksLikeFile = mode === "save" && /\.[A-Za-z0-9]+$/.test(start.split(/[/\\]/).pop() ?? "");
    load(looksLikeFile ? start.replace(/[/\\][^/\\]*$/, "") : start);
  }, [load, defaultPath, mode]);

  const modalRef = useModalFocus(onCancel);
  const cur = listing?.path ?? "";
  const files = useMemo(
    () => (listing?.files ?? []).filter((f) => !extensions || extensions.has((f.name.split(".").pop() ?? "").toLowerCase())),
    [listing, extensions],
  );
  const dialogTitle = title ?? (mode === "save" ? t("filePicker.saveTitle") : directory ? t("filePicker.folderTitle") : multiple ? t("filePicker.titleMany") : t("filePicker.title"));
  const sep = cur.includes("\\") && !cur.includes("/") ? "\\" : "/";
  const joined = (name: string) => `${cur.replace(/[/\\]+$/, "")}${sep}${name}`;

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(multiple ? prev : []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const confirmDisabled = mode === "save" ? !cur || !saveName.trim() || /[/\\]/.test(saveName) : directory ? !cur : selected.size === 0;
  const confirm = () => {
    if (confirmDisabled) return;
    if (mode === "save") return onPick(joined(saveName.trim()));
    if (directory) return onPick(multiple ? [cur] : cur);
    const picked = [...selected];
    onPick(multiple ? picked : picked[0]);
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        className="settings-dialog folder-picker-dialog server-file-picker"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{dialogTitle} <UntestedTag id="filePicker.title" /></h2>
          <button type="button" className="dialog-close-btn" onClick={onCancel}>×</button>
        </div>
        <p className="settings-help">{t("filePicker.serverNote")}</p>

        <div className="folder-picker-nav">
          <button
            type="button"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && load(listing.parent)}
            title={t("folderPicker.upOneFolder")}
          >
            <ArrowUpIcon /> {t("folderPicker.up")}
          </button>
          <span className="folder-picker-cur" title={cur}>{cur || "…"}</span>
        </div>

        <div className="folder-picker-list">
          {error ? (
            <p className="settings-help folder-picker-error">{error}</p>
          ) : loading && !listing ? (
            <p className="settings-help">{t("common.loading")}</p>
          ) : listing && listing.dirs.length === 0 && files.length === 0 ? (
            <p className="settings-help">{t("filePicker.noEntries")}</p>
          ) : (
            <>
              {listing?.dirs.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="folder-picker-item"
                  onClick={() => load(entry.path)}
                  title={entry.path}
                >
                  <span className="folder-picker-icon"><FolderIcon /></span>
                  <span className="folder-picker-name">{entry.name}</span>
                </button>
              ))}
              {!directory &&
                files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={`folder-picker-item${selected.has(file.path) ? " is-selected" : ""}`}
                    aria-pressed={selected.has(file.path)}
                    onClick={() => (mode === "save" ? setSaveName(file.name) : toggle(file.path))}
                    onDoubleClick={() => { if (mode === "open") onPick(multiple ? [file.path] : file.path); }}
                    title={file.path}
                  >
                    <span className="folder-picker-icon"><FileIcon ext={file.name.split(".").pop() ?? ""} isDir={false} /></span>
                    <span className="folder-picker-name">{file.name}</span>
                    <span className="settings-help">{fmtSize(file.size)}</span>
                  </button>
                ))}
            </>
          )}
        </div>

        {mode === "save" && (
          <div className="folder-picker-name-row">
            <label className="folder-picker-name-label">
              <span>{t("filePicker.fileName")}</span>
              <input type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)} spellCheck={false} autoFocus />
            </label>
          </div>
        )}

        <div className="folder-picker-actions">
          {extensions && <span className="settings-help">{t("filePicker.filterHint", { types: [...extensions].join(", ") })}</span>}
          {multiple && selected.size > 0 && <span className="settings-help">{t("filePicker.selected", { count: selected.size })}</span>}
          <button type="button" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="primary" disabled={confirmDisabled} onClick={confirm}>
            {mode === "save" ? t("common.save") : t("filePicker.choose")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
