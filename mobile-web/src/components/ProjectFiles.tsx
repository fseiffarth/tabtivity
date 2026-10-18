import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FolderIcon } from "../../../src/components/common/icons/Icon";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import type { TabRow } from "../api";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { FilesLibrary } from "./FilesLibrary";
import type { MarkupNewTab, MarkupTarget } from "./OutboxViewer";

export { FileGlyph, asViewerFile } from "./FilesLibrary";

/**
 * The project's drawer from the right edge: the project screen opens it on a
 * right→left swipe or its header's ☰, and a left→right swipe over it (or a
 * tap beside it) puts it away. It holds the project's menu (`menu`: 🖼 the
 * agent's files, ⎇ Git) and, while the desktop's "Project files on the phone"
 * switch is on (`browse`), a **Files** row that opens the full-screen
 * library (`FilesLibrary`, #31bo); ‹ Back at the library's root comes back
 * here.
 *
 * With no menu of its own (a tab's Focus view) the drawer would hold Files
 * alone, so the library opens straight away and closing it closes both.
 */
export function ProjectFiles({ projectId, label, onClose, markup, showTab, linked, menu, browse = true }: {
  projectId: string;
  /** The project's name, the drawer's heading and the library root's title. */
  label: string;
  onClose: () => void;
  /** Passed on to the library: an agent tab's offers **Mark up** on its PDFs
   * and pictures; the project screen's passes none (it has no chat). */
  markup?: Omit<MarkupTarget, "projectId" | "place" | "folder" | "refresh">;
  /** With no `markup`, Mark up's Submit opens a new agent tab, and the
   * view's Open tab button shows it through this (`MarkupNewTab`). */
  showTab?: (tab: TabRow) => void;
  /** The agent tab a file's card sends its marks to (`MarkupNewTab`). */
  linked?: MarkupNewTab["linked"];
  /** The project screen's own rows (＋ New tab, the agent's files, Git),
   * above the Files row; the drawer is then headed by the project's name. */
  menu?: ReactNode;
  /** False while the desktop's "Project files on the phone" switch is off:
   * the drawer holds `menu` alone, with no Files row. */
  browse?: boolean;
}) {
  const t = useT();
  const direct = !menu && browse;
  const [library, setLibrary] = useState(direct);
  const closeLibrary = useCallback(() => setLibrary(false), []);
  const drawer = useRef<HTMLElement | null>(null);
  const libraryShown = library && browse;

  useEffect(() => {
    if (libraryShown) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [libraryShown, onClose]);

  useEffect(() => {
    // Remounted with the drawer after the library closed, hence `libraryShown`.
    const host = drawer.current;
    if (libraryShown || !host) return;
    return installFocusSwipe(host, { onSwipeRight: onClose, onSwipeLeft: () => {} });
  }, [libraryShown, onClose]);

  if (libraryShown) {
    return <FilesLibrary projectId={projectId} label={label} onClose={direct ? onClose : closeLibrary}
      markup={markup} showTab={showTab} linked={linked} />;
  }

  return <div className="sheet-backdrop files-drawer-backdrop" role="presentation" onClick={onClose}>
    <section ref={drawer} className="option-sheet project-files" role="dialog" aria-modal="true" aria-label={menu ? label : t("mobile.files.title")} onClick={(event) => event.stopPropagation()}>
      <header>
        <button className="files-close" onClick={onClose} aria-label={t("mobile.files.close")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        <h2>{menu ? label : t("mobile.files.title")}</h2>
        <span className="files-close" aria-hidden="true" />
      </header>
      {menu}
      {browse && <div className="option-list drawer-menu">
        <button className="drawer-files" onClick={() => setLibrary(true)} aria-label={t("mobile.files.library.open")}>
          <span aria-hidden="true" className="project-menu-icon"><FolderIcon /></span>
          <span><strong>{t("mobile.files.title")}</strong>{isUntested("mobile.files.browse") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
          <svg className="files-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>}
    </section>
  </div>;
}
