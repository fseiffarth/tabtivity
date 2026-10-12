import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRightIcon } from "../../../src/components/common/icons/Icon";
import { useI18nStore, useT, type Language, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { STANDARD_PROJECT_FILES } from "../../../src/lib/viewers/fileUtils";
import { ApiError, listProjectFiles, searchProjectFiles, undoProjectUpload, uploadProjectFile, type OutboxFile, type ProjectFileEntry, type ProjectFileHit, type ProjectFileListing, type ProjectFileSearch, type TabRow, type ViewerScope } from "../api";
import { openFileTab, readFilesPlace, rememberFilesPlace } from "../filesPlace";
import { shareAs, useOutboxShare } from "../outboxShare";
import { sizeLabel } from "../terminal/fileLabels";
import { installFocusSwipe } from "../terminal/focusSwipe";
import { OutboxViewer, type MarkupNewTab, type MarkupTarget } from "./OutboxViewer";
import { usePhonePicks, type PickedFile } from "./phonePicks";

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

/** The message for a listing (or a search) the sidecar refused. */
function failureKey(reason: unknown, fallback: TranslationKey = "mobile.files.error"): TranslationKey {
  if (reason instanceof ApiError) {
    if (reason.code === "files_off") return "mobile.files.off";
    if (reason.code === "file_not_found") return "mobile.files.gone";
  }
  return fallback;
}

/** Why a file did not land in the folder, by the desktop's code. */
const UPLOAD_FAILURES: Record<string, TranslationKey> = {
  uploads_off: "mobile.files.upload.off",
  files_off: "mobile.files.upload.off",
  upload_refused: "mobile.files.upload.refused",
  uploads_full: "mobile.files.upload.full",
  file_too_large: "mobile.sendToDesktop.tooLarge",
  empty_file: "mobile.sendToDesktop.empty",
  project_unavailable: "mobile.projectInbox.unavailable",
  project_not_found: "mobile.projectInbox.notShared",
  file_not_found: "mobile.files.upload.gone",
  files_unavailable: "mobile.files.upload.gone",
  timeout: "mobile.sendToDesktop.timeout",
  offline: "mobile.sendToDesktop.offline",
};
/** Why an Undo left the file where it is, by the desktop's code. */
const UNDO_FAILURES: Record<string, TranslationKey> = {
  file_not_found: "mobile.files.upload.undoGone",
  uploads_off: "mobile.files.upload.undoOff",
  files_off: "mobile.files.upload.undoOff",
  timeout: "mobile.files.upload.undoRetry",
  offline: "mobile.files.upload.undoRetry",
};
/** Refusals after which the folder is listed again: its Upload here (the
 * listing's `uploads`) or the folder itself may be gone. */
const RELIST = new Set(["uploads_off", "files_off", "upload_refused", "file_not_found", "files_unavailable"]);

const codeOf = (reason: unknown) => reason instanceof ApiError ? reason.code : "";

/** A pick for **Upload here**: the folder it was picked in (its token, none
 * at the root, and its trail's names for the row), the drawer's visit to that
 * folder (Undo is offered only while it lasts), and once it landed, the
 * file's own name — the desktop's, which may be `name-2.pdf` — and token. */
interface FolderUpload extends PickedFile {
  folder?: string;
  place: string;
  visit: number;
  landed?: { token: string; name: string };
  undoing?: boolean;
  undone?: boolean;
  /** Why the last Undo kept the file; `undoFinal` when another try would
   * not change that. */
  undoFailure?: string;
  undoFinal?: boolean;
}

/** How long typing rests before the search goes out. */
const SEARCH_DEBOUNCE_MS = 250;
/** The sidecar's bound on a query (`files::MAX_QUERY`, bytes). */
const MAX_QUERY = 80;

/**
 * The project's own tree (`files.rs`, #31bo): folders to walk into and files
 * to open — a picture, a PDF or a text — in the outbox's full-screen viewer,
 * with its Save and Share (a PDF then goes on to the browser's viewer). The
 * "what did the agent just write" glance without a shell. Nothing here
 * changes a file that is there.
 *
 * Where the desktop allows it (the listing's `uploads`), **Upload here** adds
 * files from this phone to the folder the drawer stands in (`uploads.rs`):
 * one after another, each under its own name, never over an existing file.
 * A landed file's row offers Undo while the drawer stays in that folder; the
 * desktop deletes it only while it is still unchanged.
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
 * The search box finds a file or folder anywhere in the project by name
 * (`files/search`; what git ignores is not searched). Each hit carries the
 * sealed folders above it, so opening one moves the drawer there: a folder is
 * walked into, a file opens with the drawer standing in its folder — and the
 * results are still there when the viewer closes.
 *
 * A drawer from the left edge: the project screen opens it on a left→right
 * swipe or its header's ☰, and a right→left swipe over it (or a tap beside
 * it) puts it away. There it is the project's menu too (`menu`), and holds
 * only that while the desktop's files switch is off (`browse`).
 */
export function ProjectFiles({ projectId, label, onClose, markup, showTab, linked, menu, browse = true }: {
  projectId: string;
  /** The project's name, the trail's first crumb. */
  label: string;
  onClose: () => void;
  /** An agent tab's drawer offers **Mark up** on its PDFs and pictures; the
   * project screen's passes none (it has no chat). The drawer finds a
   * file's newest version itself (`refresh`). */
  markup?: Omit<MarkupTarget, "projectId" | "place" | "folder" | "refresh">;
  /** With no `markup`, Mark up's Submit opens a new agent tab, and the
   * view's Open tab button shows it through this (`MarkupNewTab`). */
  showTab?: (tab: TabRow) => void;
  /** The agent tab a file's card sends its marks to (`MarkupNewTab`). */
  linked?: MarkupNewTab["linked"];
  /** The project screen's own rows (＋ New tab, the agent's files, Git),
   * above the files; the drawer is then headed by the project's name. */
  menu?: ReactNode;
  /** False while the desktop's "Project files on the phone" switch is off:
   * the drawer holds `menu` alone and lists nothing. */
  browse?: boolean;
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
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProjectFileSearch | null>(null);
  const [searchFailure, setSearchFailure] = useState<TranslationKey | null>(null);
  const searching = query.trim() !== "";
  const scope = useMemo<ViewerScope>(() => ({ files: projectId }), [projectId]);
  const sharing = useOutboxShare(scope);
  const here = trail[trail.length - 1];
  const drawer = useRef<HTMLElement | null>(null);
  /** Bumped to list the folder again (an upload landed or was undone). */
  const [reload, setReload] = useState(0);
  const relist = useCallback(() => setReload((count) => count + 1), []);
  /** The folder the listing shows: listed again, it is not blanked first. */
  const listed = useRef<string | null>(null);
  /** Counts the drawer's moves between folders: an upload's Undo lasts only
   * as long as the visit it was picked in. */
  const [visit, setVisit] = useState(0);
  useEffect(() => { setVisit((count) => count + 1); }, [here.token]);

  const uploads = usePhonePicks<FolderUpload>({
    testId: "project-files-upload-input",
    tooLarge: t("mobile.sendToDesktop.tooLarge"),
    oneByOne: true,
    send: (file, row, settle) => uploadProjectFile(projectId, row.folder, file, row.name).then(
      (entry) => {
        settle({ state: "sent", landed: { token: entry.token, name: entry.name } });
        relist();
      },
      (reason: unknown) => {
        const code = codeOf(reason);
        settle({ state: "failed", failure: t(UPLOAD_FAILURES[code] ?? "mobile.files.upload.failed") });
        if (RELIST.has(code)) relist();
      },
    ),
  });

  const undo = (row: FolderUpload) => {
    const landed = row.landed;
    if (!landed || row.undoing) return;
    uploads.update(row.id, { undoing: true, undoFailure: undefined });
    void undoProjectUpload(projectId, landed.token).then(
      () => {
        uploads.update(row.id, { undoing: false, undone: true });
        relist();
      },
      (reason: unknown) => {
        const code = codeOf(reason);
        const key = UNDO_FAILURES[code] ?? "mobile.files.upload.undoFailed";
        uploads.update(row.id, { undoing: false, undoFailure: t(key), undoFinal: key !== "mobile.files.upload.undoRetry" });
        if (RELIST.has(code)) relist();
      },
    );
  };

  useEffect(() => {
    if (!browse) return;
    const controller = new AbortController();
    const folder = here.token ?? "";
    if (listed.current !== folder) {
      setListing(null);
      setFailure(null);
    }
    listed.current = folder;
    void listProjectFiles(projectId, here.token, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        restored.current = false;
        // A re-list after an upload is not blanked first: a refusal it met
        // before must not outlive this answer.
        setFailure(null);
        setListing(next);
      },
      (reason) => {
        if (controller.signal.aborted) return;
        const key = failureKey(reason);
        if (restored.current && here.token && key === "mobile.files.gone") {
          setTrail((current) => current.slice(0, -1));
          return;
        }
        // Nor may the listing it replaced: its `uploads` would keep Upload
        // here on screen beside the refusal (files switched off).
        setListing(null);
        setFailure(key);
      },
    );
    return () => controller.abort();
  }, [projectId, here.token, browse, reload]);

  useEffect(() => {
    // The last results stay up while the next search is out, so typing does
    // not blank the list letter by letter.
    const words = query.trim();
    if (!words) {
      setFound(null);
      setSearchFailure(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchProjectFiles(projectId, words, controller.signal).then(
        (next) => {
          if (controller.signal.aborted) return;
          setFound(next);
          setSearchFailure(null);
        },
        (reason) => { if (!controller.signal.aborted) setSearchFailure(failureKey(reason, "mobile.files.searchError")); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectId, query]);

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
      else if (searching) setQuery("");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileOpen, searching, onClose]);

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

  /** Opens a row of the folder at `at` (the trail as it stands, or as a
   * search hit's sets it). */
  const open = (entry: ProjectFileEntry, at: Crumb[] = trail) => {
    if (entry.kind === "dir") {
      setTrail([...at, { token: entry.token, name: entry.name }]);
      return;
    }
    // A PDF too: the browser's own PDF viewer has no Save or Share, so the
    // viewer's head carries them and its Open button hands the file over.
    // It also becomes a card among the project screen's tabs.
    if (entry.kind === "application/pdf") {
      const { token, name, kind, size, modified } = entry;
      openFileTab(projectId, { token, name, kind, size, modified, folder: at[at.length - 1].token, place: at.slice(1).map((crumb) => crumb.name).join("/") });
    }
    setTrail(at);
    setFileOpen(asViewerFile(entry));
  };

  /** A search hit: the drawer moves to its folder (Mark up's Reload and the
   * picture steps read that folder), a folder hit ends the search there. */
  const openHit = (hit: ProjectFileHit) => {
    if (hit.kind === "dir") setQuery("");
    open(hit, [trail[0], ...hit.trail]);
  };

  if (fileOpen) {
    // The folder trail names the file's layer on the phone; its token cannot.
    const place = trail.slice(1).map((crumb) => crumb.name).join("/");
    return <OutboxViewer key={fileOpen.ref} scope={scope} file={fileOpen} pictures={pictures} onStep={setFileOpen} onClose={() => setFileOpen(null)}
      markup={markup && { ...markup, projectId, place, folder: here.token, refresh }} newTab={showTab && { projectId, place, folder: here.token, refresh, show: showTab, linked }} />;
  }
  /** One file or folder: its tile, name and times, and ↗ Share for a file.
   * A search hit names its folder above the times. */
  function row(entry: ProjectFileEntry, folded = false, hit?: ProjectFileHit) {
    const file = entry.kind === "dir" ? null : asViewerFile(entry);
    const ready = sharing.ready === entry.name;
    return <li key={entry.token} className={folded ? "files-folded" : undefined}>
      <button onClick={() => hit ? openHit(hit) : open(entry)} aria-label={entry.kind === "dir" ? t("mobile.files.openFolder", { name: entry.name }) : t("mobile.files.openFile", { name: entry.name })}>
        <FileGlyph kind={entry.kind} />
        <span>
          <strong>{entry.name}</strong>
          {hit && <small className="files-hit-place">{hit.trail.length ? hit.trail.map((crumb) => crumb.name).join("/") : t("mobile.files.atRoot")}</small>}
          <small>{rowMeta(entry, t, lang)}</small>
        </span>
        {entry.kind === "dir" && <svg className="files-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>}
      </button>
      {file && shareAs(file) && <button
        className="files-share"
        disabled={sharing.busy === entry.name}
        onClick={() => void sharing.share(file)}
        aria-label={t(ready ? "mobile.outbox.shareReadyFile" : "mobile.outbox.shareFile", { name: entry.name })}
      ><span aria-hidden="true"><ArrowUpRightIcon /></span>{ready && t("mobile.outbox.shareReady")}</button>}
      {sharing.failed === entry.name && <p className="files-share-error" role="alert">{t("mobile.outbox.shareError")}</p>}
    </li>;
  }

  /** One **Upload here** pick: on its way, refused, landed (with Undo while
   * the drawer stays in its folder), or undone. */
  function uploadRow(upload: FolderUpload) {
    const close = <button onClick={() => uploads.dismiss(upload.id)} aria-label={t("mobile.sendToDesktop.dismiss", { name: upload.landed?.name ?? upload.name })}>✕</button>;
    if (upload.state === "failed") return <div key={upload.id} className="inbox-upload error" role="alert"><strong>{upload.name}</strong><span>{upload.failure}</span>{close}</div>;
    if (upload.state === "sending" || !upload.landed) return <div key={upload.id} className="inbox-upload" role="status"><strong>{upload.name}</strong><span>{t("mobile.files.upload.sending")}</span></div>;
    const name = upload.landed.name;
    if (upload.undone) return <div key={upload.id} className="inbox-upload" role="status"><strong>{name}</strong><span>{t("mobile.files.upload.undone")}</span>{close}</div>;
    const canUndo = upload.visit === visit && !upload.undoFinal;
    return <div key={upload.id} className={upload.undoFailure ? "inbox-upload error" : "inbox-upload landed"} role="status">
      <strong>{name}</strong>
      <span>{upload.undoFailure ?? t("mobile.files.upload.landed", { folder: upload.place })}</span>
      {canUndo && <button disabled={upload.undoing} onClick={() => undo(upload)} aria-label={t("mobile.files.upload.undoLabel", { name })}>{t("mobile.files.upload.undo")}</button>}
      {close}
    </div>;
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
    <section ref={drawer} className="option-sheet project-files" role="dialog" aria-modal="true" aria-label={menu ? label : t("mobile.files.title")} onClick={(event) => event.stopPropagation()}>
      <header>
        <button className="files-close" onClick={onClose} aria-label={t("mobile.files.close")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        <h2>{menu ? label : t("mobile.files.title")} {browse && (isUntested("mobile.files.browse") || isUntested("mobile.files.share") || isUntested("mobile.files.sections") || isUntested("mobile.files.remember") || isUntested("mobile.files.search") || isUntested("mobile.files.upload")) && <small>{t("mobile.outbox.untested")}</small>}</h2>
        <span className="files-close" aria-hidden="true" />
      </header>
      {menu}
      {browse && <>
        <input className="files-search" type="search" value={query} maxLength={MAX_QUERY} enterKeyHint="search"
          placeholder={t("mobile.files.searchPlaceholder")} aria-label={t("mobile.files.search")}
          onChange={(event) => setQuery(event.target.value)} />
        {!searching && <nav className="files-trail" aria-label={t("mobile.files.trail")}>
          {trail.map((crumb, index) => {
            const last = index === trail.length - 1;
            return <button key={`${index}:${crumb.token ?? ""}`} aria-current={last ? "location" : undefined} disabled={last}
              onClick={() => setTrail((current) => current.slice(0, index + 1))}>{crumb.name}</button>;
          })}
        </nav>}
        {!searching && listing?.uploads && <button className="new-tab-file" onClick={() => uploads.open({ folder: here.token, place: here.name, visit })}>
          <span><strong>{t("mobile.files.upload.button")}</strong><small>{t("mobile.files.upload.hint", { folder: here.name })}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></svg>
        </button>}
        {uploads.input}
        {uploads.rows.map(uploadRow)}
        <p className="sheet-note">{t(!searching && listing?.uploads ? "mobile.files.addOnly" : "mobile.files.readOnly")}</p>
        {searching ? searchFailure
          ? <p className="sheet-note error" role="alert">{t(searchFailure)}</p>
          : !found
            ? <p className="sheet-note">{t("mobile.files.searching")}</p>
            : found.hits.length === 0
              ? <p className="sheet-note">{t("mobile.files.noHits")}</p>
              : <ul className="option-list files-list" aria-label={t("mobile.files.search")}>
                {found.hits.map((hit) => row(hit, false, hit))}
              </ul>
        : failure
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
        {searching
          ? found?.truncated && <p className="sheet-note">{t("mobile.files.searchTruncated", { count: found.hits.length })}</p>
          : listing?.truncated && <p className="sheet-note">{t("mobile.files.truncated", { count: listing.entries.length })}</p>}
      </>}
    </section>
  </div>;
}
