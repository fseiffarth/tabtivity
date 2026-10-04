import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { STANDARD_PROJECT_FILES } from "../../../src/lib/viewers/fileUtils";
import { ApiError, listProjectFiles, type OutboxFile, type ProjectFileEntry, type ProjectFileListing, type TabRow, type ViewerScope } from "../api";
import { openFileTab, readFilesPlace, rememberFilesPlace } from "../filesPlace";
import { shareAs, useOutboxShare } from "../outboxShare";
import { sizeLabel } from "../terminal/fileLabels";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { OutboxViewer, type MarkupTarget } from "./OutboxViewer";

/** One folder on the way down: its sealed token (none for the project root)
 * and the name the reader tapped. */
type Crumb = { token?: string; name: string };

/** A listed file as the viewer takes it, fetched by its token. */
export function asViewerFile(entry: ProjectFileEntry): OutboxFile {
  return { name: entry.name, kind: entry.kind, size: entry.size, modified: entry.modified, ref: entry.token };
}

/** A listed time as the row prints it, in the app's language and as
 * short as it can be told apart: the clock for today, the day this year, the
 * whole date before that. */
function stampLabel(seconds: number, lang: Language, now = new Date()): string {
  const when = new Date(seconds * 1000);
  if (when.toDateString() === now.toDateString()) return when.toLocaleTimeString(lang, { timeStyle: "short" });
  return when.toLocaleDateString(lang, when.getFullYear() === now.getFullYear()
    ? { day: "numeric", month: "short" }
    : { dateStyle: "medium" });
}

/** What a row's tile draws: a folder, a picture, a PDF, a text, or a file. */
type Glyph = "dir" | "image" | "pdf" | "text" | "file";

function glyphOf(kind: string): Glyph {
  if (kind === "dir") return "dir";
  if (kind.startsWith("image/")) return "image";
  if (kind === "application/pdf") return "pdf";
  return kind.startsWith("text/") ? "text" : "file";
}

const SHEET = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5";
const GLYPHS: Record<Glyph, ReactNode> = {
  dir: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m20.5 15.5-4.5-4.5-9.5 8.5" /></>,
  pdf: <><path d={SHEET} /><path d="M8.5 13.5h7M8.5 17h4.5" /></>,
  text: <><path d={SHEET} /><path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4" /></>,
  file: <path d={SHEET} />,
};

/** A row's tinted kind tile; the project screen's file cards wear it too. */
export function FileGlyph({ kind }: { kind: string }) {
  const glyph = glyphOf(kind);
  return <span className={`files-icon files-icon-${glyph}`} aria-hidden="true"><svg viewBox="0 0 24 24">{GLYPHS[glyph]}</svg></span>;
}

/** The folder's rows as the desktop tree groups them: the rest first, then
 * the project root's scaffold (README, AGENTS.md, …) and what git ignores,
 * each folded into its own section. A scaffold file git ignores stays a
 * scaffold file, as on the desktop. */
function sectionsOf(entries: ProjectFileEntry[], atRoot: boolean) {
  const scaffold = atRoot ? entries.filter((entry) => STANDARD_PROJECT_FILES.has(entry.name)) : [];
  const rest = atRoot ? entries.filter((entry) => !STANDARD_PROJECT_FILES.has(entry.name)) : entries;
  return { regular: rest.filter((entry) => !entry.ignored), scaffold, ignored: rest.filter((entry) => entry.ignored) };
}

/** The line under a row's name: a file's size, then when it was created (where
 * the desktop's filesystem says) and last edited. */
function rowMeta(entry: ProjectFileEntry, t: ReturnType<typeof useT>, lang: Language): string {
  return [
    entry.kind !== "dir" ? sizeLabel(entry.size) : null,
    entry.created ? t("mobile.files.created", { when: stampLabel(entry.created, lang) }) : null,
    entry.modified > 0 ? t("mobile.files.edited", { when: stampLabel(entry.modified, lang) }) : null,
  ].filter(Boolean).join(" · ");
}

/** The message for a listing the sidecar refused. */
function failureKey(reason: unknown): TranslationKey {
  if (reason instanceof ApiError) {
    if (reason.code === "files_off") return "mobile.files.off";
    if (reason.code === "file_not_found") return "mobile.files.gone";
  }
  return "mobile.files.error";
}

/**
 * The project's own tree, read-only (`files.rs`, #31bo): folders to walk into
 * and files to open — a picture, a PDF or a text — in the outbox's full-screen
 * viewer, with its Save and Share (a PDF then goes on to the browser's
 * viewer). The "what did the agent just write" glance without a shell.
 * Nothing here can change a file.
 *
 * A file the phone's share sheet takes carries ↗ Share on its row, as an
 * outbox tile does: passing a file on to Signal or WhatsApp should not mean
 * opening it first.
 *
 * The project root's scaffold files and everything git ignores sit in
 * collapsed sections below the rest, as in the desktop's file tree.
 *
 * The phone never holds a path: each folder and file is a sealed token the
 * sidecar handed out, and the trail across the top is the tokens walked so far.
 * The trail is remembered per project (`filesPlace.ts`), so the drawer opens
 * again in the folder it was put away in — after a viewed file, a closed
 * drawer or a reloaded app alike. A remembered folder that no longer lists
 * steps back to the nearest one that does.
 *
 * A drawer from the left edge: the project screen opens it on a left→right
 * swipe, and a right→left swipe over it (or a tap beside it) puts it away.
 */
export function ProjectFiles({ projectId, label, onClose, markup, showTab }: {
  projectId: string;
  /** The project's name, the trail's first crumb. */
  label: string;
  onClose: () => void;
  /** An agent tab's drawer offers **Mark up** on its PDFs and pictures; the
   * project screen's passes none (it has no chat). The drawer finds a
   * file's newest version itself (`refresh`). */
  markup?: Omit<MarkupTarget, "projectId" | "place" | "refresh">;
  /** With no `markup`, Mark up's Submit opens a new agent tab, and the
   * view's Open tab button shows it through this (`MarkupNewTab`). */
  showTab?: (tab: TabRow) => void;
}) {
  const t = useT();
  const lang = useI18nStore((state) => state.lang);
  const [trail, setTrail] = useState<Crumb[]>(() => [{ name: label }, ...readFilesPlace(projectId)]);
  /** Still standing on the remembered trail, not yet listed once: a folder
   * that is gone (or a token a re-keyed host no longer opens) steps back. */
  const restored = useRef(trail.length > 1);
  const [listing, setListing] = useState<ProjectFileListing | null>(null);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const [fileOpen, setFileOpen] = useState<OutboxFile | null>(null);
  // Both fold shut by default, and stay as set while the drawer is walked.
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const scope = useMemo<ViewerScope>(() => ({ files: projectId }), [projectId]);
  const sharing = useOutboxShare(scope);
  const here = trail[trail.length - 1];
  const drawer = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    setFailure(null);
    void listProjectFiles(projectId, here.token, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        restored.current = false;
        setListing(next);
      },
      (reason) => {
        if (controller.signal.aborted) return;
        const key = failureKey(reason);
        if (restored.current && here.token && key === "mobile.files.gone") {
          setTrail((current) => current.slice(0, -1));
          return;
        }
        setFailure(key);
      },
    );
    return () => controller.abort();
  }, [projectId, here.token]);

  useEffect(() => {
    rememberFilesPlace(projectId, trail.flatMap((crumb) => crumb.token ? [{ token: crumb.token, name: crumb.name }] : []));
  }, [projectId, trail]);

  const sections = useMemo(() => sectionsOf(listing?.entries ?? [], trail.length === 1), [listing, trail.length]);

  /** The folder's shown pictures, which the viewer steps through in row order. */
  const pictures = useMemo(
    () => [...sections.regular, ...(scaffoldOpen ? sections.scaffold : []), ...(ignoredOpen ? sections.ignored : [])]
      .filter((entry) => entry.kind.startsWith("image/")).map(asViewerFile),
    [sections, scaffoldOpen, ignoredOpen],
  );

  useEffect(() => {
    // The viewer opens over the sheet, so Escape closes the top one first.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fileOpen) setFileOpen(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, onClose]);

  useEffect(() => {
    // Remounted with the drawer after a file was viewed, hence `fileOpen`.
    const host = drawer.current;
    if (fileOpen || !host) return;
    return installFocusSwipe(host, { onSwipeRight: () => {}, onSwipeLeft: onClose });
  }, [fileOpen, onClose]);

  /** Mark up's Reload: the open file's folder listed again, for its fresh
   * token, size and time. The viewer keeps showing it — swapping `fileOpen`
   * would remount the viewer (its key) and lose the markup's view. */
  const refresh = useCallback(async (file: OutboxFile): Promise<OutboxFile | null> => {
    const fresh = await listProjectFiles(projectId, here.token);
    const entry = fresh.entries.find((candidate) => candidate.kind !== "dir" && candidate.name === file.name);
    return entry ? asViewerFile(entry) : null;
  }, [projectId, here.token]);

  const open = (entry: ProjectFileEntry) => {
    if (entry.kind === "dir") {
      setTrail((current) => [...current, { token: entry.token, name: entry.name }]);
      return;
    }
    // A PDF too: the browser's own PDF viewer has no Save or Share, so the
    // viewer's head carries them and its Open button hands the file over.
    // It also becomes a card among the project screen's tabs.
    if (entry.kind === "application/pdf") {
      const { token, name, kind, size, modified } = entry;
      openFileTab(projectId, { token, name, kind, size, modified, folder: here.token, place: trail.slice(1).map((crumb) => crumb.name).join("/") });
    }
    setFileOpen(asViewerFile(entry));
  };

  if (fileOpen) {
    // The folder trail names the file's layer on the phone; its token cannot.
    const place = trail.slice(1).map((crumb) => crumb.name).join("/");
    return <OutboxViewer key={fileOpen.ref} scope={scope} file={fileOpen} pictures={pictures} onStep={setFileOpen} onClose={() => setFileOpen(null)}
      markup={markup && { ...markup, projectId, place, refresh }} newTab={showTab && { projectId, place, refresh, show: showTab }} />;
  }
  /** One file or folder: its tile, name and times, and ↗ Share for a file. */
  function row(entry: ProjectFileEntry, folded = false) {
    const file = entry.kind === "dir" ? null : asViewerFile(entry);
    const ready = sharing.ready === entry.name;
    return <li key={entry.token} className={folded ? "files-folded" : undefined}>
      <button onClick={() => open(entry)} aria-label={entry.kind === "dir" ? t("mobile.files.openFolder", { name: entry.name }) : t("mobile.files.openFile", { name: entry.name })}>
        <FileGlyph kind={entry.kind} />
        <span>
          <strong>{entry.name}</strong>
          <small>{rowMeta(entry, t, lang)}</small>
        </span>
        {entry.kind === "dir" && <svg className="files-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>}
      </button>
      {file && shareAs(file) && <button
        className="files-share"
        disabled={sharing.busy === entry.name}
        onClick={() => void sharing.share(file)}
        aria-label={t(ready ? "mobile.outbox.shareReadyFile" : "mobile.outbox.shareFile", { name: entry.name })}
      ><span aria-hidden="true">↗</span>{ready && t("mobile.outbox.shareReady")}</button>}
      {sharing.failed === entry.name && <p className="files-share-error" role="alert">{t("mobile.outbox.shareError")}</p>}
    </li>;
  }

  /** A folded section: the desktop tree's divider, then its rows when open. */
  function section(kind: "scaffold" | "ignored", isOpen: boolean, setOpen: (open: boolean) => void, entries: ProjectFileEntry[]) {
    const scaffold = kind === "scaffold";
    return <>
      <li className="files-section">
        <button aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}
          title={t(scaffold ? (isOpen ? "fileTree.collapseScaffold" : "fileTree.expandScaffold") : (isOpen ? "fileTree.collapseGitignored" : "fileTree.expandGitignored"))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          <span>{t(scaffold ? "fileTree.scaffoldSection" : "fileTree.gitignoredSection", { count: entries.length })}</span>
        </button>
      </li>
      {isOpen && entries.map((entry) => row(entry, !scaffold))}
    </>;
  }

  return <div className="sheet-backdrop files-drawer-backdrop" role="presentation" onClick={onClose}>
    <section ref={drawer} className="option-sheet project-files" role="dialog" aria-modal="true" aria-label={t("mobile.files.title")} onClick={(event) => event.stopPropagation()}>
      <header>
        <button className="files-close" onClick={onClose} aria-label={t("mobile.files.close")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        <h2>{t("mobile.files.title")} {(isUntested("mobile.files.browse") || isUntested("mobile.files.share") || isUntested("mobile.files.sections") || isUntested("mobile.files.remember")) && <small>{t("mobile.outbox.untested")}</small>}</h2>
        <span className="files-close" aria-hidden="true" />
      </header>
      <nav className="files-trail" aria-label={t("mobile.files.trail")}>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return <button key={`${index}:${crumb.token ?? ""}`} aria-current={last ? "location" : undefined} disabled={last}
            onClick={() => setTrail((current) => current.slice(0, index + 1))}>{crumb.name}</button>;
        })}
      </nav>
      <p className="sheet-note">{t("mobile.files.readOnly")}</p>
      {failure
        ? <p className="sheet-note error" role="alert">{t(failure)}</p>
        : !listing
          ? <p className="sheet-note">{t("mobile.files.loading")}</p>
          : listing.entries.length === 0
            ? <p className="sheet-note">{t("mobile.files.empty")}</p>
            : <ul className="option-list files-list">
              {sections.regular.map((entry) => row(entry))}
              {sections.scaffold.length > 0 && section("scaffold", scaffoldOpen, setScaffoldOpen, sections.scaffold)}
              {sections.ignored.length > 0 && section("ignored", ignoredOpen, setIgnoredOpen, sections.ignored)}
            </ul>}
      {listing?.truncated && <p className="sheet-note">{t("mobile.files.truncated", { count: listing.entries.length })}</p>}
    </section>
  </div>;
}
