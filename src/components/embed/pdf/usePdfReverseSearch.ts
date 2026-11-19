import { useRemoteStatusStore } from "../../../stores/remote/remoteStatus";
/** The PDF viewer's SyncTeX reverse search (#66, #250): a Ctrl/Cmd-click on a page
 *  opens the source line that produced it, and every outcome is worded. */
import { useCallback, useEffect, useRef, useState } from "react";
import { jumpToSource } from "../fileViewer/sourceJump";
import { useTexPdfHost } from "../fileViewer/texPdfHost";
import { canRecompileTexSource } from "../../../lib/viewers/tex/openTexWorkspace";
import {
  synctexEdit,
  synctexStatus,
  syncNoticeKind,
  texSourceCandidates,
  texPathExists,
  resolveTexRoot,
  type SyncNoticeKind,
} from "../../../lib/viewers/tex/tex";
import type { FileSource } from "../../../lib/files/fileAccess";

/**
 * Probes for the map beside a visible PDF, arms the crosshair
 * cursor while Ctrl/Cmd is held (an attribute on the scroller, never React state),
 * and answers each click with a jump, a notice, or both.
 */
export function usePdfReverseSearch({
  path,
  scope,
  fileSource,
  diskVersion,
  paneVisible,
  scrollRef,
}: {
  path: string;
  scope: string | null;
  /** Where the PDF and its map are read from. */
  fileSource: FileSource;
  /** Bumped per disk change: a recompile may just have written the map. */
  diskVersion: number;
  paneVisible: boolean;
  /** The reader's scroller, which carries `data-sync-armed`. */
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const host = useTexPdfHost();
  // True when a `.synctex(.gz)` sits beside the PDF, enabling reverse search.
  const [syncable, setSyncable] = useState(false);
  // The `.tex` that built this PDF by its name (`texSourceCandidates`), or null:
  // what a reverse-search click opens when there is no map to name the line.
  const [texSource, setTexSource] = useState<string | null>(null);
  // While Ctrl/⌘ is held the pages show the crosshair cursor (reverse-search
  // clicks fire only then, leaving plain clicks free for text selection). The
  // armed mark is an attribute on the scroller that CSS reads, never React
  // state: a modifier goes down for every shortcut typed anywhere in the window,
  // and as state each press and release re-rendered every page of this PDF. Not
  // tracked at all while the pane is hidden.
  const reverseArmable = syncable || texSource != null;
  useEffect(() => {
    if (!reverseArmable || !paneVisible) return;
    let armed = false;
    const arm = (next: boolean) => {
      if (next === armed) return;
      armed = next;
      scrollRef.current?.toggleAttribute("data-sync-armed", next);
    };
    const sync = (e: KeyboardEvent | MouseEvent) => arm(e.ctrlKey || e.metaKey);
    const clear = () => arm(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("mousemove", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("mousemove", sync);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [reverseArmable, paneVisible, scrollRef]);

  // Why a reverse-search click did nothing, or may have landed on the wrong
  // line — worded from `synctexStatus` after every click (see `syncNoticeKind`).
  // A Ctrl-click used to fail silently in every one of these cases, which read
  // as "click-to-source is broken" when the answer was "you haven't recompiled".
  // `source` is the file the Recompile button builds from (the resolved input on
  // a hit, the PDF's sibling `.tex` otherwise); `canRecompile` gates the button,
  // since a PDF opened on its own has no workspace to hand the build to.
  const [syncNotice, setSyncNotice] = useState<{
    /** `"remote"`: the host is disconnected. */
    kind: SyncNoticeKind | "remote";
    /** True when the click opened `source` at its top for want of a map. */
    opened: boolean;
    source: string;
    sources: string[];
    canRecompile: boolean;
  } | null>(null);
  useEffect(() => {
    if (!syncNotice) return;
    const id = window.setTimeout(() => setSyncNotice(null), 10000);
    return () => window.clearTimeout(id);
  }, [syncNotice]);

  const remoteSource = fileSource === "remote";
  const connected = useRemoteStatusStore((s) => !!scope && s.byProject[scope]?.ssh === "connected");
  const mapProbe = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    setSyncable(false);
    if (!paneVisible || (remoteSource && !connected)) return;
    let cancelled = false;
    const base = path.replace(/\.pdf$/i, "");
    const probe = remoteSource
      ? synctexStatus(path, scope).then((s) => !!s?.has_map)
      : Promise.all([`${base}.synctex.gz`, `${base}.synctex`].map((p) => texPathExists(p, scope))).then((found) => found.some(Boolean));
    mapProbe.current = probe;
    void probe.then((found) => { if (!cancelled) setSyncable(found); });
    return () => { cancelled = true; mapProbe.current = null; };
  }, [path, scope, diskVersion, remoteSource, connected, paneVisible]);

  // The source by name — a PDF with no map still opens the `.tex` that built it.
  // Probed once per local file; a remote one is asked only on a click
  // (`onSyncClick`), never at mount: a stat per restored tab over SFTP, hidden or
  // not, connected or not, is the probe the map check above declines too.
  const findTexSource = useCallback(async () => {
    for (const candidate of texSourceCandidates(path)) {
      if (await texPathExists(candidate, scope)) return candidate;
    }
    return null;
  }, [path, scope]);
  useEffect(() => {
    setTexSource(null);
    if (remoteSource) return;
    let cancelled = false;
    void findTexSource().then((found) => { if (!cancelled) setTexSource(found); });
    return () => { cancelled = true; };
  }, [findTexSource, remoteSource]);

  // Reverse search: a click on a page → which source line produced it → jump.
  // Resolve the clicked source's root (the main `.tex` that produces this PDF) and
  // pass it as the routing anchor, so a subfile with no tab yet opens in the
  // subwindow that already holds the main `.tex` rather than the focused group.
  //
  // Every outcome is worded: no map beside the PDF (compile with SyncTeX first),
  // a map the PDF or a source outgrew (recompile — the jump still happens, a
  // nearby line beats nothing), or an honest miss on a current map. The status
  // probe runs after the resolve, not before, so a clean hit on a current map
  // costs one extra command answered from the map cache and a few stats.
  //
  // With no map to ask (none beside the PDF) the
  // click still opens the `.tex` that built the PDF, at its top, and says why.
  const onSyncClick = useCallback(
    async (page: number, x: number, y: number) => {
      setSyncNotice(null);
      const jump = async (input: string, line: number) => {
        // A one-pane host (the agent tab's Data view) shows the source in this
        // PDF's place instead of a tab.
        if (host?.showSource(input, line, 0)) return;
        const root = await resolveTexRoot(input).catch(() => input);
        jumpToSource(input, line, 0, root);
      };
      const openByName = (source: string | null) => {
        if (source) void jump(source, 1);
        return source != null;
      };
      const hasMap = await mapProbe.current ?? syncable;
      if (remoteSource && (!scope || useRemoteStatusStore.getState().byProject[scope]?.ssh !== "connected")) {
        setSyncNotice({ kind: "remote", opened: false, source: path, sources: [], canRecompile: false });
        return;
      }
      const src = hasMap ? await synctexEdit(path, page, x, y, scope) : null;
      if (src) await jump(src.input, src.line);
      const status = hasMap ? await synctexStatus(path, scope) : null;
      const kind = hasMap ? syncNoticeKind(status, src != null) : "noMap";
      if (!kind) return;
      const fallback = kind === "noMap" && remoteSource ? await findTexSource() : texSource;
      const opened = kind === "noMap" && !src && openByName(fallback);
      const source = src?.input ?? fallback ?? texSourceCandidates(path)[0] ?? path;
      const canRecompile = await canRecompileTexSource(source).catch(() => false);
      setSyncNotice({ kind, opened, source, sources: status?.newer_sources ?? [], canRecompile });
    },
    [path, scope, remoteSource, syncable, texSource, findTexSource, host],
  );

  return { syncNotice, setSyncNotice, onSyncClick };
}
