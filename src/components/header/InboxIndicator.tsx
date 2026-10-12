import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { storageKey } from "../../lib/brand";
import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/formatBytes";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { UntestedTag } from "../common/UntestedTag";
import { InboxGlyph } from "./HeaderGlyphs";
import { usePoll } from "../../lib/usePoll";

const MENU_ID = "inbox";

/** How often the folder is re-read while the window is visible. One small
 *  directory listing; a file sent from the phone shows within this. */
const POLL_MS = 10_000;

/** One file waiting in `<state_dir>/inbox/` (`inbox::GlobalInboxFile`). */
export type GlobalInboxFile = { name: string; size: number; modified: number };

/** A file a paired phone added to a project with **Upload here**, still
 *  unchanged on disk (`commands::mobile_control::phone_uploads_list`: the last
 *  24 h, newest first, one row per file). */
export type PhoneUpload = {
  id: string;
  projectName: string;
  /** `/`-separated, relative to the project folder. */
  rel: string;
  size: number;
  /** Unix seconds. */
  at: number;
  phone?: string;
};

/** Ids of upload rows this viewer pressed **Keep** on (a JSON string array). */
const KEPT_KEY = storageKey("inbox.keptUploads");

function readKept(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEPT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** `current` plus whatever another viewer of the same storage (a second
 *  browser tab of the web client) kept meanwhile, so a write from here never
 *  drops their Keep. */
function withStored(current: string[]): string[] {
  const merged = [...current];
  for (const id of readKept()) if (!merged.includes(id)) merged.push(id);
  return merged;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function writeKept(ids: string[]) {
  try {
    if (ids.length === 0) localStorage.removeItem(KEPT_KEY);
    else localStorage.setItem(KEPT_KEY, JSON.stringify(ids));
  } catch {
    // No storage (private window, blocked site data): Keep lasts this session.
  }
}

/** The stored name without the `YYYYMMDD-HHMMSS-` stamp the inbox prefixes. */
export function displayName(name: string): string {
  return name.replace(/^\d{8}-\d{6}-/, "") || name;
}

/**
 * The header's inbox — files the phone sent with **Send to desktop**, which
 * belong to no project and wait in Tabtivity's own `<state_dir>/inbox/`, never in
 * a project folder (a project's own inbox is `.tabtivity/inbox/`, fed by the
 * Focus composer).
 *
 * `TodoIndicator`'s shape: a `.global-apps-menu` wrapper whose hover lists the
 * files. It renders **only while something is waiting**, so a bar with an
 * empty inbox carries no extra button; the badge is the count, derived from
 * the folder and never acknowledged — it falls as files are deleted. A row
 * opens its file with the OS default app; the button itself shows the folder,
 * which is where a file is dragged on into a project.
 *
 * It also lists what the phone **added to projects** (Upload here) in the last
 * 24 h while the file is unchanged: **Undo** deletes it again (armed, then
 * confirmed, like the delete), **Keep** hides the row in this viewer only.
 * With no global files waiting, the button opens the list instead of the
 * folder.
 */
export function InboxIndicator() {
  const t = useT();
  const [files, setFiles] = useState<GlobalInboxFile[]>([]);
  const [uploads, setUploads] = useState<PhoneUpload[]>([]);
  const [kept, setKept] = useState<string[]>(readKept);
  const [armed, setArmed] = useState<string | null>(null);
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setMenuOpen = useCallback(
    (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [openMenu, closeMenu],
  );
  const closeTimer = useRef<number | undefined>(undefined);
  /** Bumped when a delete or undo starts and again when it ends. A read that
   *  began before the bump answers for the folder as it was, so its answer is
   *  dropped instead of painting the removed row back (a poll in flight while
   *  Undo is confirmed); the re-read after the write decides. */
  const writes = useRef(0);

  const load = useCallback(async () => {
    const seen = writes.current;
    // A failed read keeps the last list rather than hiding the button.
    const loadFiles = async () => {
      try {
        const listed = await invoke<GlobalInboxFile[]>("global_inbox_list");
        if (writes.current === seen) setFiles(listed);
      } catch {
        // kept as is
      }
    };
    const loadUploads = async () => {
      try {
        const listed = await invoke<PhoneUpload[]>("phone_uploads_list");
        if (writes.current !== seen) return;
        setUploads(listed);
        // Keep marks only what is still listed, so the stored set stays small.
        // Safe only on a good read: the command rejects (`list_failed`) rather
        // than answering [] when it cannot read projects.json or the log.
        const ids = new Set(listed.map((u) => u.id));
        setKept((current) => {
          const next = withStored(current).filter((id) => ids.has(id));
          if (!sameIds(next, readKept())) writeKept(next);
          return sameIds(next, current) ? current : next;
        });
      } catch {
        // kept as is
      }
    };
    await Promise.all([loadFiles(), loadUploads()]);
  }, []);

  // Read now and every POLL_MS while the window is in front (`usePoll` stops
  // while it is blurred or hidden), and again on every return to it.
  usePoll(load, POLL_MS, { catchUpAfterMs: 0 });

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, setMenuOpen]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const shown = uploads.filter((u) => !kept.includes(u.id));
  const count = files.length + shown.length;

  // The last row removed with the list open would otherwise leave it painted
  // over a button that is gone.
  useEffect(() => {
    if (count === 0) setMenuOpen(false);
  }, [count, setMenuOpen]);

  // A disarmed delete: leaving the list forgets the half-made choice.
  useEffect(() => {
    if (!menuOpen) setArmed(null);
  }, [menuOpen]);

  if (count === 0) return null;

  const label = t("inbox.indicatorCount", { count });

  const reveal = () => {
    window.clearTimeout(closeTimer.current);
    setMenuOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 250);
  };

  const open = (name: string) => {
    setMenuOpen(false);
    window.clearTimeout(closeTimer.current);
    invoke("global_inbox_open", { name }).catch(() => void load());
  };

  const remove = async (name: string) => {
    setArmed(null);
    writes.current += 1;
    // Drop the row first; the re-read confirms (or restores) it.
    setFiles((current) => current.filter((f) => f.name !== name));
    try {
      await invoke("global_inbox_delete", { name });
    } finally {
      writes.current += 1;
      void load();
    }
  };

  const undo = async (id: string) => {
    setArmed(null);
    writes.current += 1;
    setUploads((current) => current.filter((u) => u.id !== id));
    try {
      await invoke("phone_upload_undo", { id });
    } catch {
      // `file_not_found`: edited, moved or gone — the re-read drops the row
      // (only unchanged files are listed); anything else brings it back.
    } finally {
      writes.current += 1;
      void load();
    }
  };

  const keep = (id: string) => {
    setArmed(null);
    setKept((current) => {
      const next = withStored(current);
      if (!next.includes(id)) next.push(id);
      writeKept(next);
      return next;
    });
  };

  const age = (at: number) => {
    const seconds = Math.max(0, Date.now() / 1000 - at);
    if (seconds < 60) return t("inbox.uploads.justNow");
    if (seconds < 3_600) return t("inbox.uploads.minutesAgo", { count: Math.floor(seconds / 60) });
    return t("inbox.uploads.hoursAgo", { count: Math.floor(seconds / 3_600) });
  };

  return (
    <div
      className="global-apps-menu inbox-indicator no-drag"
      onMouseEnter={reveal}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="global-apps-menu-btn inbox-indicator-btn"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          window.clearTimeout(closeTimer.current);
          // Only uploads listed: there is no folder of theirs to show.
          if (files.length === 0) {
            setMenuOpen(true);
            return;
          }
          setMenuOpen(false);
          void invoke("global_inbox_reveal").catch(() => undefined);
        }}
        onFocus={reveal}
      >
        <InboxGlyph className="inbox-indicator-icon" />
        <span className="inbox-indicator-badge" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      </button>
      {menuOpen && (
        <div
          className="tab-new-menu inbox-indicator-menu"
          role="menu"
          aria-label={t("inbox.menuTitle")}
        >
          {files.length > 0 && (
            <>
              <div className="tab-new-menu-group-label">
                {t("inbox.menuTitle")} <UntestedTag id="inbox.menuTitle" />
              </div>
              <div className="menu-scroll-region">
                {files.map((file) => (
                  <div key={file.name} className="inbox-menu-row">
                    <button
                      type="button"
                      role="menuitem"
                      className="tab-new-menu-item inbox-menu-open"
                      title={t("inbox.open", { name: displayName(file.name) })}
                      onClick={() => open(file.name)}
                    >
                      <span className="inbox-menu-name">{displayName(file.name)}</span>
                      <span className="inbox-menu-size">{formatBytes(file.size)}</span>
                    </button>
                    <button
                      type="button"
                      className={"inbox-menu-delete" + (armed === file.name ? " armed" : "")}
                      title={t("inbox.deleteHint")}
                      aria-label={`${t("inbox.delete")} ${displayName(file.name)}`}
                      onClick={() =>
                        armed === file.name ? void remove(file.name) : setArmed(file.name)
                      }
                    >
                      {armed === file.name ? t("inbox.deleteConfirm") : "✕"}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {shown.length > 0 && (
            <>
              <div className="tab-new-menu-group-label">
                {t("inbox.uploads.title")} <UntestedTag id="desktop.inbox.phoneUploads" />
              </div>
              <div className="menu-scroll-region">
                {shown.map((upload) => {
                  const key = `upload:${upload.id}`;
                  const where = `${upload.projectName} · ${upload.rel}`;
                  return (
                    <div key={upload.id} className="inbox-menu-row">
                      <div className="inbox-menu-open inbox-menu-upload" title={where}>
                        <span className="inbox-menu-name">{where}</span>
                        <span className="inbox-menu-size">
                          {[formatBytes(upload.size), age(upload.at), upload.phone].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="inbox-menu-delete"
                        title={t("inbox.uploads.keepHint")}
                        aria-label={t("inbox.uploads.keepLabel", { name: upload.rel })}
                        onClick={() => keep(upload.id)}
                      >
                        {t("inbox.uploads.keep")}
                      </button>
                      <button
                        type="button"
                        className={"inbox-menu-delete" + (armed === key ? " armed" : "")}
                        title={t("inbox.uploads.undoHint")}
                        aria-label={t("inbox.uploads.undoLabel", { name: upload.rel })}
                        onClick={() => (armed === key ? void undo(upload.id) : setArmed(key))}
                      >
                        {armed === key ? t("inbox.uploads.undoConfirm") : t("inbox.uploads.undo")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {files.length > 0 && (
            <button
              type="button"
              role="menuitem"
              className="tab-new-menu-item"
              onClick={() => {
                setMenuOpen(false);
                void invoke("global_inbox_reveal").catch(() => undefined);
              }}
            >
              {t("inbox.showFolder")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
