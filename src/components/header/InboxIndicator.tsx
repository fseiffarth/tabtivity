import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useT } from "../../lib/i18n";
import { formatBytes } from "../../lib/formatBytes";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { UntestedTag } from "../common/UntestedTag";
import { InboxGlyph } from "./HeaderGlyphs";

const MENU_ID = "inbox";

/** How often the folder is re-read while the window is visible. One small
 *  directory listing; a file sent from the phone shows within this. */
const POLL_MS = 10_000;

/** One file waiting in `<state_dir>/inbox/` (`inbox::GlobalInboxFile`). */
export type GlobalInboxFile = { name: string; size: number; modified: number };

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
 */
export function InboxIndicator() {
  const t = useT();
  const [files, setFiles] = useState<GlobalInboxFile[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const menuOpen = useHeaderHoverMenuStore((s) => s.openId === MENU_ID);
  const openMenu = useHeaderHoverMenuStore((s) => s.open);
  const closeMenu = useHeaderHoverMenuStore((s) => s.close);
  const setMenuOpen = useCallback(
    (v: boolean) => (v ? openMenu(MENU_ID) : closeMenu(MENU_ID)),
    [openMenu, closeMenu],
  );
  const closeTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setFiles(await invoke<GlobalInboxFile[]>("global_inbox_list"));
    } catch {
      // A failed read keeps the last list rather than hiding the button.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

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

  // The last file deleted with the list open would otherwise leave it painted
  // over a button that is gone.
  useEffect(() => {
    if (files.length === 0) setMenuOpen(false);
  }, [files.length, setMenuOpen]);

  // A disarmed delete: leaving the list forgets the half-made choice.
  useEffect(() => {
    if (!menuOpen) setArmed(null);
  }, [menuOpen]);

  if (files.length === 0) return null;

  const count = files.length;
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
    // Drop the row first; the re-read confirms (or restores) it.
    setFiles((current) => current.filter((f) => f.name !== name));
    try {
      await invoke("global_inbox_delete", { name });
    } finally {
      void load();
    }
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
          setMenuOpen(false);
          window.clearTimeout(closeTimer.current);
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
        </div>
      )}
    </div>
  );
}
