import { PreviewImages } from "../previewImages";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findTabByKey, useTabsStore } from "../../../stores/tabs";
import { useExperimental } from "../../../lib/experimental";
import { useScrollSync } from "../../../stores/viewers/scrollSync";
import { CompareView } from "../CompareView";
import { matchAnchorId, renderMarkdown, toggleTaskCheckbox } from "../../../lib/viewers/markdown";
import { onMarkdownLinkClick, resolveLocalHref } from "../../../lib/viewers/markdownLinks";
import { useMdAnchorStore } from "../../../stores/viewers/mdAnchor";
import { printHtmlBody, MARKDOWN_PRINT_CSS } from "../../../lib/viewers/print";
import {
  toggleInline,
  cycleHeading,
  toggleLinePrefix,
  makeLink,
  generateToc,
  type EditResult,
} from "../../../lib/viewers/markdownEdit";
import { UntestedTag } from "../../common/UntestedTag";
import { fetchRemoteImage, hostsLabel, remoteImageHosts } from "../../../lib/remote/remoteImages";
import { basename, dirname } from "../../../lib/paths";
import { useFileScope, usePaneVisible, readFileBytes } from "../../../lib/files/fileAccess";
import { useT } from "../../../lib/i18n";
import { LinkIcon } from "../../common/icons/Icon";
import { ErrorNote } from "../../common/ErrorNote";
import { MdGraphView } from "./lazyViewers";
import { useViewerState } from "./viewerState";
import { openLinkedFile, openMarkdownTarget, viewerForPath } from "./openLinked";
import { ViewerHeader } from "./ViewerHeader";
import { type EditorApi, useEditableFile, ExternalChangeBanner } from "./editableFile";
import { LinkOpenHint, CodeEditor } from "./CodeEditor";
import { SaveButton, PrintButton, UndoRedoButtons, useFormatter, FormatButton, CompareButton } from "./toolbar";
import { useTabAiPrefs, EditorAiControls } from "./editorPrefs";
import { onCtrlWheelFont, useZoomModifierWheel, useEditorFontSize, FontSizeControls } from "./fontZoom";

/** MIME type for inlining a local image into the markdown preview as a Blob URL.
 *  Raster formats render even from a typeless blob (the webview content-sniffs
 *  the magic bytes), but SVG is XML text the browser will NOT sniff as an image —
 *  an `<img>` only renders it when the blob is explicitly `image/svg+xml`. That's
 *  why an SVG in a doc (e.g. README's "At a glance" map) showed blank. We set the
 *  type for every known extension so all inlined images carry a correct MIME. */
function imageMimeForPath(p: string): string {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    default: return "";
  }
}

/** Markdown editing toolbar (#md-toolbar): inline/structural formatting plus a
 *  generated table of contents, applied through the editor's imperative API so
 *  each action is one undo step. Buttons `preventDefault` on mousedown so the
 *  editor keeps its selection as the action's target. */
function MarkdownToolbar({ api }: { api: React.MutableRefObject<EditorApi | null> }) {
  const t = useT();
  const act = (fn: (v: string, s: number, e: number) => EditResult) => () =>
    api.current?.applyEdit(fn);
  const btn = (label: React.ReactNode, title: string, fn: (v: string, s: number, e: number) => EditResult) => (
    <button
      className="file-viewer-md-btn"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={act(fn)}
    >
      {label}
    </button>
  );
  return (
    <div className="file-viewer-md-toolbar" role="group" aria-label={t("fileViewer.formattingGroup")}>
      {btn(<b>B</b>, t("fileViewer.mdBold"), (v, s, e) => toggleInline(v, s, e, "**"))}
      {btn(<i>I</i>, t("fileViewer.mdItalic"), (v, s, e) => toggleInline(v, s, e, "_"))}
      {btn(<span style={{ fontFamily: "var(--font-mono, monospace)" }}>{"<>"}</span>, t("fileViewer.mdInlineCode"), (v, s, e) => toggleInline(v, s, e, "`"))}
      {btn("H", t("fileViewer.mdCycleHeading"), (v, s) => cycleHeading(v, s))}
      {btn(<LinkIcon />, t("fileViewer.mdLink"), (v, s, e) => makeLink(v, s, e))}
      {btn("•", t("fileViewer.mdBulletedList"), (v, s, e) => toggleLinePrefix(v, s, e, "- "))}
      {btn("TOC", t("fileViewer.mdInsertToc"), (v, s, e) => {
        const toc = generateToc(v);
        const ins = toc ? `${toc}\n` : "";
        return { value: v.slice(0, s) + ins + v.slice(e), selStart: s, selEnd: s + ins.length };
      })}
    </div>
  );
}

/** Markdown documents whose remote images the user chose to load this session.
 *  Module scope so the choice survives the tab remounting; deliberately not
 *  persisted, since "yes, fetch from these hosts" was said about a file's
 *  contents at one moment, and the file can change. */
const remoteImagesAllowed = new Set<string>();

// A graph source can restore its mode when a linked markdown tab returns to it.
const mdGraphShow = new Map<string, () => void>();

export function MarkdownView({
  path,
  onOpenExternally,
  tabKey,
  groupId,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
}) {
  const t = useT();
  const {
    error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo, externalChange, reloadFromDisk, keepMine,
  } = useEditableFile(path);
  const scope = useFileScope();
  const visible = usePaneVisible();
  // The relationship-graph mode is opt-in (`md_graph` experimental flag): the
  // Graph button only renders while the flag is live, and a mode the flag
  // withdrew falls back to the preview rather than stranding a blank pane.
  const graphEnabled = useExperimental("md_graph");
  const [mode, setMode] = useState<"preview" | "edit" | "graph">("preview");
  useEffect(() => {
    if (!tabKey) return;
    mdGraphShow.set(tabKey, () => setMode("graph"));
    return () => { mdGraphShow.delete(tabKey); };
  }, [tabKey]);
  useEffect(() => {
    if (!graphEnabled && mode === "graph") setMode("preview");
  }, [graphEnabled, mode]);
  const [compareOpen, setCompareOpen] = useState(false);
  const font = useEditorFontSize(tabKey, "markdown");
  const wheelRef = useZoomModifierWheel((e) => onCtrlWheelFont(e, font.inc, font.dec));
  // Proportional scroll-link (preview mode only — edit mode links via CodeEditor's
  // textarea). `.file-viewer-body` is the overflow:auto scroller for the preview.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const setBodyRef = useCallback(
    (el: HTMLDivElement | null) => {
      wheelRef(el);
      bodyScrollRef.current = el;
    },
    [wheelRef],
  );
  const ai = useTabAiPrefs(tabKey, "markdown");
  const ac = ai.ac;
  const sc = ai.sc;
  const fmt = useFormatter(path, draft, setDraft);
  // Imperative editor handle the formatting toolbar drives (bold/italic/TOC/…).
  const editorApi = useRef<EditorApi | null>(null);
  const viewPos = useViewerState(tabKey);
  const persistScroll = useCallback(
    (scrollTop: number) => viewPos.persist({ scrollTop }),
    [viewPos],
  );
  // Keep the hidden DOM stable; regenerate from the latest draft on show.
  const lastPreview = useRef("");
  const html = useMemo(() => {
    if (!loaded) lastPreview.current = "";
    else if (visible && mode === "preview") lastPreview.current = renderMarkdown(draft);
    return lastPreview.current;
  }, [loaded, draft, visible, mode]);
  // Register the preview scroller only while in preview mode, so it never fights
  // CodeEditor for the same group id (edit mode links via the textarea instead).
  const reportPreviewSync = useScrollSync(mode === "preview" ? groupId : null, bodyScrollRef);
  const graphOrigin = tabKey ? findTabByKey(useTabsStore.getState(), tabKey)?.mdGraphOriginKey : undefined;
  const canReturnToGraph = graphEnabled && graphOrigin && findTabByKey(useTabsStore.getState(), graphOrigin);

  // After the preview HTML is committed to the DOM, run the mermaid/KaTeX
  // enrichment pass (Dev A): it finds the mermaid code blocks and math
  // placeholders renderMarkdown emitted and renders them in place. Re-runs
  // whenever the rendered HTML changes or we switch back to preview mode.
  // The module is imported HERE, not at the top of the file (§5.3 startup
  // size): mermaid + katex + the katex CSS initialize at its module
  // evaluation, so a static import would pay that at every window's launch
  // instead of at the first markdown preview. Placeholders render as plain
  // source until the chunk lands (milliseconds), then enrich in place.
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible || mode !== "preview") return;
    if (!previewRef.current) return;
    let cancelled = false;
    void import("../../../lib/viewers/markdownEnrich").then((m) => {
      // Re-read the ref after the await: the pane may have unmounted, or the
      // effect re-run for newer HTML (that run enriches the current DOM).
      const el = previewRef.current;
      if (!cancelled && el) void m.enrichMarkdownDom(el);
    });
    return () => {
      cancelled = true;
    };
  }, [html, mode, visible]);

  // #49/#50: local-file links in the rendered preview open in-app. Unlike the
  // source editor, Preview has no caret interaction to preserve, so a normal
  // click follows the usual Markdown convention.
  const [linkTip, setLinkTip] = useState<{
    left: number;
    top: number;
    destination: string;
  } | null>(null);
  // Kept local to the viewer rather than routed through AppShell's project toast:
  // Markdown tabs can live in detached windows, where the main shell's toast
  // would appear in the wrong window (or not be visible at all).
  const [copyNotice, setCopyNotice] = useState(0);
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
    },
    [],
  );

  const images = useMemo(() => new PreviewImages(
    (target) => readFileBytes(target, scope), imageMimeForPath,
  ), [scope]);
  useEffect(() => () => images.dispose(), [images]);
  useEffect(() => {
    images.pause(!visible || mode !== "preview");
    return () => images.pause(true);
  }, [images, visible, mode]);
  useEffect(() => {
    if (!visible || mode !== "preview") return;
    const root = previewRef.current;
    if (!root) return;
    let cancelled = false;
    const targets = new Map<HTMLImageElement, string>();
    for (const img of root.querySelectorAll<HTMLImageElement>("img.md-img-local[data-md-src]")) {
      const target = resolveLocalHref(path, img.getAttribute("data-md-src") ?? "");
      if (target) targets.set(img, target);
    }
    images.retain(new Set(targets.values()));
    const load = (img: HTMLImageElement) => {
      const target = targets.get(img);
      if (!target) return;
      void images.load(target).then((url) => {
        if (!cancelled && url) img.src = url;
      });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) {
          load(entry.target as HTMLImageElement);
          observer?.unobserve(entry.target);
        }
      }, { root: bodyScrollRef.current, rootMargin: "300px" },
    );
    for (const img of targets.keys()) {
      if (observer) observer.observe(img);
      else load(img);
    }
    return () => { cancelled = true; observer?.disconnect(); };
  }, [html, mode, visible, path, images]);

  // Remote (http/https) images render as placeholders and fetch nothing until
  // the user presses Load in the banner: a document must not be able to make
  // the app contact a server just by being opened (tracking, or a leak out of a
  // VM/agent sandbox through the host). The fetch itself is the backend's
  // (`markdown_remote_image`), and the result lands as a blob: URL, which the
  // CSP already allows.
  const [remoteUrls, setRemoteUrls] = useState<string[]>([]);
  const [, bumpRemoteAllowed] = useState(0);
  const remoteAllowed = remoteImagesAllowed.has(path);
  const remoteMime = useRef(new Map<string, string>());
  const remoteImages = useMemo(() => new PreviewImages(
    async (url) => {
      const image = await fetchRemoteImage(url);
      remoteMime.current.set(url, image.mime);
      return image.bytes;
    },
    (url) => remoteMime.current.get(url) ?? "application/octet-stream",
  ), []);
  useEffect(() => () => remoteImages.dispose(), [remoteImages]);
  useEffect(() => {
    remoteImages.pause(!visible || mode !== "preview");
    return () => remoteImages.pause(true);
  }, [remoteImages, visible, mode]);
  useEffect(() => {
    if (!visible || mode !== "preview") return;
    const root = previewRef.current;
    if (!root) return;
    const spans = Array.from(root.querySelectorAll<HTMLElement>("span.md-img-remote[data-md-remote]"));
    const urls = [...new Set(spans.map((s) => s.dataset.mdRemote ?? "").filter(Boolean))];
    setRemoteUrls((prev) => (prev.length === urls.length && prev.every((u, i) => u === urls[i]) ? prev : urls));
    if (!remoteAllowed) return;
    let cancelled = false;
    remoteImages.retain(new Set(urls));
    for (const span of spans) {
      const url = span.dataset.mdRemote;
      // A failed image is not retried on every re-render; reopening the
      // document (or editing it) gives it a fresh placeholder to try again.
      if (!url || span.classList.contains("is-loaded") || span.classList.contains("is-failed")) continue;
      span.classList.add("is-loading");
      void remoteImages.load(url).then((blobUrl) => {
        if (cancelled || !span.isConnected) return;
        span.classList.remove("is-loading");
        if (!blobUrl) {
          span.classList.add("is-failed");
          span.title = `${t("fileViewer.remoteImageFailed")}\n${url}`;
          return;
        }
        const img = document.createElement("img");
        img.src = blobUrl;
        img.alt = span.textContent ?? "";
        span.replaceChildren(img);
        span.classList.add("is-loaded");
      });
    }
    return () => { cancelled = true; };
  }, [html, mode, visible, remoteAllowed, remoteImages, t]);

  // Cross-file `#fragment` navigation (stores/viewers/mdAnchor): when a followed link
  // into this document carried a fragment, scroll the rendered preview to that
  // heading once the preview exists — covering both a freshly opened tab (the
  // request outlives the mount) and an already-open one (`openLinkedFile`
  // re-activates it, and this store is how the fragment still arrives).
  // Consumed after one attempt in preview mode, found or not — a fragment
  // naming no heading is an authoring fact, not a standing order. While Edit
  // mode is showing, the request is left pending and applies on the switch
  // back to Preview.
  const anchorReq = useMdAnchorStore((s) => s.requestsByPath[path]);
  useEffect(() => {
    if (!anchorReq || mode !== "preview" || !loaded) return;
    const root = previewRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>("[id]"));
    const id = matchAnchorId(els.map((el) => el.id), anchorReq.fragment);
    if (id) els.find((el) => el.id === id)?.scrollIntoView({ block: "start" });
    useMdAnchorStore.getState().consume(path);
  }, [anchorReq, mode, loaded, html, path]);

  // Print the rendered Markdown. Prefer the live preview DOM (it carries the
  // enriched mermaid/KaTeX output and inlined local images); fall back to a fresh
  // render of the current draft when Edit mode has the preview unmounted.
  const handlePrint = useCallback(() => {
    const inner = previewRef.current?.innerHTML || html || renderMarkdown(draft);
    void printHtmlBody(
      `<div class="markdown-body">${inner}</div>`,
      MARKDOWN_PRINT_CSS,
      basename(path),
    );
  }, [html, draft, path]);

  // Every preview link reports its destination on hover. Resolve local file
  // paths against this Markdown file so `docs/guide.md` is unambiguous even when
  // multiple projects contain a file with that name; leave external URLs and
  // in-document fragments as authored.
  const onPreviewMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a") as HTMLAnchorElement | null;
    if (!a) {
      setLinkTip((current) => current ? null : current);
      return;
    }
    const href = a.getAttribute("href") ?? "";
    const resolved = a.classList.contains("file-link")
      ? resolveLocalHref(path, href)
      : null;
    const fragment = href.match(/[?#].*$/)?.[0] ?? "";
    const destination = resolved ? `${resolved}${fragment}` : href;
    const rect = a.getBoundingClientRect();
    setLinkTip((current) =>
      current?.destination === destination
        ? current
        : { left: rect.left, top: rect.top, destination },
    );
  }, [path]);

  // Copy-on-select for the rendered preview, matching the native terminal.
  // Mouse-up covers drag and double/triple-click selection while keeping the
  // clipboard write inside the user gesture required by WebKit. Both endpoints
  // must belong to this preview so a selection crossing into adjacent chrome or
  // another tiled pane cannot replace the clipboard unexpectedly.
  const onPreviewMouseUp = useCallback(() => {
    const root = previewRef.current;
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !root.contains(selection.anchorNode) ||
      !root.contains(selection.focusNode)
    ) return;
    const text = selection.toString();
    const clipboard = navigator.clipboard;
    if (!text || !clipboard) return;
    void clipboard.writeText(text).then(() => {
      setCopyNotice((notice) => notice + 1);
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current);
      copyNoticeTimer.current = setTimeout(() => setCopyNotice(0), 2200);
    }).catch(() => {});
  }, []);

  const onPreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Task-list checkboxes toggle the underlying `- [ ]`/`- [x]` in the draft.
      // The clicked box's position among all task checkboxes in the preview is its
      // document order — exactly toggleTaskCheckbox's index — so we count them and
      // flip the matching source line. The native toggle stands until the re-render
      // reconciles it from the (now-updated) source, so there is no flicker.
      const box = (e.target as HTMLElement).closest?.(
        "li.task-item > input[data-md-task]",
      ) as HTMLInputElement | null;
      if (box) {
        const root = previewRef.current;
        if (!root) return;
        const boxes = Array.from(
          root.querySelectorAll<HTMLInputElement>("li.task-item > input[data-md-task]"),
        );
        const index = boxes.indexOf(box);
        if (index < 0) return;
        const nextSrc = toggleTaskCheckbox(draft, index);
        if (nextSrc != null) setDraft(nextSrc);
        return;
      }
      // Links: `#anchor`s scroll here, local files open in a tab, and nothing
      // navigates the app window away (shared with every Markdown host).
      onMarkdownLinkClick(e, {
        root: previewRef.current,
        basePath: path,
        open: openMarkdownTarget(tabKey, path),
      });
    },
    [path, tabKey, draft, setDraft],
  );

  return (
    <div className="file-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        {canReturnToGraph && (
          <button
            className="md-graph-back"
            disabled={isDirty || saving}
            title={t(isDirty || saving ? "mdGraph.backSaveFirst" : "mdGraph.back")}
            onClick={() => {
              if (!tabKey || !graphOrigin) return;
              mdGraphShow.get(graphOrigin)?.();
              const store = useTabsStore.getState();
              store.setActive(graphOrigin);
              store.removeTab(tabKey);
            }}
          >
            ← {t("mdGraph.back")}
            <UntestedTag id="mdGraph.back" />
          </button>
        )}
        <div className="file-viewer-modes">
          <button
            className={`file-viewer-mode${mode === "preview" ? " active" : ""}`}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            {t("fileViewer.modePreview")}
          </button>
          <button
            className={`file-viewer-mode${mode === "edit" ? " active" : ""}`}
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            {t("fileViewer.modeEdit")}
          </button>
          {graphEnabled && (
            <button
              className={`file-viewer-mode${mode === "graph" ? " active" : ""}`}
              aria-pressed={mode === "graph"}
              onClick={() => setMode("graph")}
            >
              {t("fileViewer.modeGraph")}
            </button>
          )}
        </div>
        {mode === "edit" && <MarkdownToolbar api={editorApi} />}
        <FontSizeControls fontSize={font.fontSize} inc={font.inc} dec={font.dec} reset={font.reset} />
        {mode === "edit" && <EditorAiControls ai={ai} path={path} />}
        {mode === "edit" && fmt.enabled && (
          <FormatButton available={fmt.available} busy={fmt.busy} run={() => void fmt.run()} />
        )}
        {mode === "edit" && (
          <CompareButton active={compareOpen} toggle={() => setCompareOpen((v) => !v)} />
        )}
        {mode === "edit" && (
          <UndoRedoButtons undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo} />
        )}
        <SaveButton isDirty={isDirty} saving={saving} save={() => void save()} />
        <PrintButton onPrint={handlePrint} disabled={!loaded} />
      </ViewerHeader>
      {externalChange && <ExternalChangeBanner onReload={reloadFromDisk} onKeep={keepMine} />}
      {saveError && <ErrorNote className="file-viewer-error" error={saveError} />}
      {mode === "edit" && fmt.status && (
        <div className="file-viewer-status-line">{fmt.status}</div>
      )}
      {mode === "preview" && loaded && remoteUrls.length > 0 && !remoteAllowed && (
        <div className="file-viewer-reload-banner" role="status">
          <span>
            {t("fileViewer.remoteImagesBlocked", {
              count: remoteUrls.length,
              hosts: hostsLabel(remoteImageHosts(remoteUrls)),
            })}
          </span>
          <UntestedTag id="fileViewerPane.3" />
          <button
            className="file-viewer-reload-btn"
            title={t("fileViewer.remoteImagesLoadTitle")}
            onClick={() => {
              remoteImagesAllowed.add(path);
              bumpRemoteAllowed((n) => n + 1);
            }}
          >
            {t("fileViewer.remoteImagesLoad")}
          </button>
        </div>
      )}
      <div
        className={`file-viewer-body${mode === "edit" ? " file-viewer-code-body" : ""}`}
        ref={setBodyRef}
        onScroll={reportPreviewSync}
      >
        {mode === "graph" ? (
          <Suspense fallback={<div className="file-viewer-loading">{t("common.loading")}</div>}>
            <MdGraphView
              path={path}
              onOpen={(target) => {
                const viewer = viewerForPath(target);
                openLinkedFile(tabKey, dirname(path), {
                  path: target,
                  viewer,
                  label: basename(target),
                  mdGraphOriginKey: viewer === "markdown" ? tabKey : undefined,
                });
              }}
            />
          </Suspense>
        ) : mode === "edit" && compareOpen ? (
          <CompareView
            path={path}
            rightText={draft}
            onApply={(merged) => {
              setDraft(merged);
              setCompareOpen(false);
            }}
            onClose={() => setCompareOpen(false)}
          />
        ) : mode === "edit" ? (
          // The shared code editor gives markdown the same Tab/undo/save behaviour
          // as the text/tex viewers — and local autocomplete (#45). `wrap` so prose
          // soft-wraps. It renders its own load/error states.
          <CodeEditor
            path={path}
            error={error}
            draft={draft}
            setDraft={setDraft}
            loaded={loaded}
            save={() => void save()}
            undo={undo}
            redo={redo}
            autocomplete={ac}
            spellCheck={sc}
            fontSize={font.fontSize}
            lineHeight={font.lineHeight}
            incFont={font.inc}
            decFont={font.dec}
            resetFont={font.reset}
            wrap
            editorApiRef={editorApi}
            initialScrollTop={viewPos.initial?.scrollTop}
            onScrollPersist={persistScroll}
            groupId={groupId}
          />
        ) : error != null ? (
          <div className="file-viewer-error">{error}</div>
        ) : !loaded ? (
          <div className="file-viewer-loading">{t("common.loading")}</div>
        ) : (
          <div
            ref={previewRef}
            className="markdown-body"
            // Leave the preview at its CSS default until the user sets a size,
            // then drive the base font-size so headings (em-based) scale with it.
            style={font.isCustom ? { fontSize: `${font.fontSize}px` } : undefined}
            onMouseMove={onPreviewMove}
            onMouseUp={onPreviewMouseUp}
            onMouseLeave={() => setLinkTip(null)}
            onClick={onPreviewClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
      {mode === "preview" && <LinkOpenHint at={linkTip} label={linkTip?.destination} />}
      {copyNotice > 0 && (
        <div key={copyNotice} className="project-switch-toast" role="status" aria-live="polite">
          {t("fileViewer.copiedToClipboard")}
        </div>
      )}
    </div>
  );
}
