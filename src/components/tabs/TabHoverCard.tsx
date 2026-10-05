import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  effectiveTabLocation,
  isLocatableKind,
  isPtyTabKind,
  isResumableAgentTab,
  localityHostLabel,
  remoteHostIdOf,
  type LocalityHost,
  type TabEntry,
  type TabKind,
} from "../../stores/tabs";
import { lastPtyOutputAt, useActivityStore } from "../../stores/activity";
import { useAgentTaskStore } from "../../stores/agents/agentTask";
import { useFileSourcesStore } from "../../stores/viewers/fileSources";
import type { InternalViewer } from "../../lib/viewers/fileUtils";
import { TAB_ACCENT } from "./newTabItems";
import { useT, type TranslationKey } from "../../lib/i18n";

/** Friendly, human-readable name for a tab kind, shown as the card's muted
 *  sub-line. Falls back to the raw kind for anything unmapped. */
const KIND_LABEL_KEY: Record<TabKind, TranslationKey> = {
  agent: "tabKind.agent",
  local_agent: "tabKind.local_agent",
  shell: "newTabMenu.groupShell",
  files: "newTabMenu.groupFiles",
  projectfiles: "tabKind.projectfiles",
  embed: "tabKind.embed",
  projects3d: "newTabMenu.itemProjects3d",
  network: "tabKind.network",
  monitor: "tabKind.monitor",
  diskusage: "tabKind.diskusage",
  calendar: "newTabMenu.calendar",
  browser: "newTabMenu.browser",
  printing: "printing.title",
  skillslibrary: "skillsLibrary.title",
  promptchart: "promptChart.heading",
};

/** Which built-in viewer a file tab renders in — "Embedded app" says nothing
 *  exactly where the card is most used, six viewer tabs deep. */
const VIEWER_LABEL_KEY: Record<InternalViewer, TranslationKey> = {
  pdf: "viewerLabel.pdf",
  image: "viewerLabel.image",
  gif: "viewerLabel.gif",
  markdown: "viewerLabel.markdown",
  text: "viewerLabel.text",
  tex: "viewerLabel.tex",
  texworkspace: "viewerLabel.texworkspace",
  table: "viewerLabel.table",
  notebook: "viewerLabel.notebook",
  diff: "viewerLabel.diff",
  syncdiff: "viewerLabel.syncdiff",
  syncmerge: "viewerLabel.syncmerge",
  gitmerge: "viewerLabel.gitmerge",
  odt: "viewerLabel.odt",
  media: "viewerLabel.media",
  html: "viewerLabel.html",
  sqlite: "viewerLabel.sqlite",
  yaml: "viewerLabel.yaml",
  bib: "viewerLabel.bib",
  eldeck: "viewerLabel.eldeck",
};

/** Gap between the tab and the card, and the keep-inside-the-window margin. */
const GAP = 6;
const MARGIN = 8;

/** "5 s" / "12 min" / "2 h 05 min" — the quiet-time readout. */
function formatQuiet(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * The folder shown on the card. A file tab's `cwd` is just the project root —
 * the same for every file tab, so it says nothing; show the file's FOLDER
 * relative to that root instead (the filename is already the card's title; a
 * root-level file shows no path row at all). Falls back to the absolute folder
 * for a file outside the root, e.g. a remote-native host path. Non-file tabs
 * keep their cwd.
 */
function cardPath(tab: TabEntry): string {
  if (tab.kind !== "embed" || !tab.embedPath) return tab.cwd;
  const dirOf = (p: string) => {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(0, i) : "";
  };
  const sep = tab.embedPath[tab.cwd.length];
  return tab.embedPath.startsWith(tab.cwd) && (sep === "/" || sep === "\\")
    ? dirOf(tab.embedPath.slice(tab.cwd.length + 1))
    : dirOf(tab.embedPath);
}

/**
 * Hover card for a tab — the tab-bar counterpart to `ProjectHoverCard`. Reuses
 * the project popup's row classes so the two hovers look identical. Rendered
 * into a portal by BOTH tab strips (the main window's `TabBar` and the detached
 * popout's `DetachedCenterPanel`), which is why it takes the whole `TabEntry`
 * and derives everything itself — the stores it reads (agent task title, file
 * source, activity) are per-window heaps, so each window's card shows what that
 * window knows and nothing has to be threaded across.
 *
 * `anchorX` is the tab's horizontal centre and `anchorY` its bottom edge. The
 * card measures itself and clamps into the viewport (a tab near the right/left
 * edge would otherwise push the centred card off-screen — "out of the app"), and
 * flips above the bar if it would overflow the bottom.
 */
export function TabHoverCard({
  tab,
  scope,
  /** Whether the owning project is a remote (SSH) one — gates the locality
   *  line. The detached window is inert to the projects store and omits it. */
  isRemote = false,
  /** Primary host name + worker machines, so the locality line can name the
   *  concrete machine ("Primary (gpu-1)", "gpu-2") not just "on host". Omitted by
   *  the detached window (inert to the projects store) → falls back to "on host". */
  primaryHost,
  computeHosts,
  anchorX,
  anchorY,
}: {
  tab: TabEntry;
  scope: string;
  isRemote?: boolean;
  primaryHost?: string;
  computeHosts?: LocalityHost[];
  anchorX: number;
  anchorY: number;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // null until measured — kept hidden for that first frame so the clamp doesn't
  // flash the card at the un-clamped position.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const ptyId = `${scope}:${tab.key}`;
  // The agent task summary (terminal title); absent when the tab set none.
  const summary = useAgentTaskStore((s) => s.titleByTab[tab.key]);
  // Viewer file-source (remote-native vs local mirror), published by the file
  // viewers on remote projects; absent otherwise.
  const fileSource = useFileSourcesStore((s) => s.byTab[tab.key]);
  const busy = useActivityStore((s) => !!s.busyByTab[ptyId]);

  // The "quiet for…" line ages while the card is up; tick it along so a card
  // hovered for a while doesn't freeze at its mount-time reading.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const isAgent = tab.kind === "agent" || tab.kind === "local_agent";

  // Muted kind line, enriched with what the tiny tab badges can only hint at:
  // the concrete viewer, where the process runs (remote projects), and which
  // side a viewed file came from. An agent's permission mode is deliberately
  // absent: it is set inside the agent's own CLI and Tabtivity does not track it.
  const kindBits: string[] = [
    tab.kind === "embed" && tab.viewer
      ? t(VIEWER_LABEL_KEY[tab.viewer] ?? KIND_LABEL_KEY.embed)
      : t(KIND_LABEL_KEY[tab.kind]),
  ];
  if (isRemote && isLocatableKind(tab.kind)) {
    const loc = effectiveTabLocation(tab);
    if (remoteHostIdOf(loc) === null) {
      kindBits.push(t("tabHoverCard.localMirror"));
    } else {
      // Name the concrete machine when known ("Primary (gpu-1)" / "gpu-2"); the
      // detached window has no host list, so it degrades to a generic label.
      const named = primaryHost || computeHosts ? localityHostLabel(loc, { primaryHost, computeHosts }) : null;
      kindBits.push(named ? t("tabHoverCard.onHost", { name: named }) : t("tabHoverCard.onHostSsh"));
    }
  }
  if (tab.kind === "embed" && fileSource === "remote") {
    kindBits.push(t("tabHoverCard.remoteNative"));
  } else if (tab.kind === "embed" && fileSource === "local") {
    kindBits.push(t("tabHoverCard.localMirror"));
  }

  // "working" / "quiet for N min" — only for tabs that own a process, and only
  // once it produced output this session (a window that never saw the PTY —
  // e.g. a fresh popout — has nothing truthful to say, so it says nothing).
  const lastOut = isPtyTabKind(tab.kind) ? lastPtyOutputAt(ptyId) : undefined;
  const activity = busy
    ? t("tabHoverCard.working")
    : lastOut !== undefined
      ? t("tabHoverCard.quietFor", { duration: formatQuiet(now - lastOut) })
      : null;

  // Whether the conversation survives an app restart — a real behavioral split
  // between agents (see RESUMABLE_AGENTS) that nothing else surfaces.
  const restart = isAgent
    ? isResumableAgentTab(tab)
      ? t("tabHoverCard.resumesOnRelaunch")
      : t("tabHoverCard.droppedOnRelaunch")
    : null;

  const path = cardPath(tab);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Centre under the tab, then clamp horizontally within the window.
    let left = anchorX - width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - width));
    // Below the bar by default; flip above it if that would run off the bottom.
    let top = anchorY + GAP;
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, anchorY - height - GAP);
    }
    setPos({ left, top });
  }, [anchorX, anchorY, tab, summary, fileSource, activity, restart, path]);

  return createPortal(
    <div
      ref={ref}
      className="project-pill-popup tab-popup"
      style={{
        left: pos?.left ?? anchorX,
        top: pos?.top ?? anchorY,
        // Own the position via left/top (with JS clamping); drop the shared
        // class's centring transform so the measured box maps 1:1 to the window.
        transform: "none",
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <span className="tab-popup-header">
        <span className="tab-popup-dot" style={{ color: TAB_ACCENT[tab.kind] }}>
          ●
        </span>
        <span className="tab-popup-label">{tab.label}</span>
      </span>
      {summary && <span className="pill-popup-description">{summary}</span>}
      <span className="tab-popup-kind">{kindBits.join(" · ")}</span>
      {activity && (
        <span className="pill-popup-path-row">
          <span className="pill-popup-path-label">{t("tabHoverCard.activityLabel")}</span>
          <span className={`tab-popup-meta${busy ? " working" : ""}`}>{activity}</span>
        </span>
      )}
      {restart && (
        <span className="pill-popup-path-row">
          <span className="pill-popup-path-label">{t("tabHoverCard.restartLabel")}</span>
          <span className="tab-popup-meta">{restart}</span>
        </span>
      )}
      {path && <span className="pill-popup-path">{path}</span>}
      {tab.sessionId && (
        <span className="pill-popup-path-row">
          <span className="pill-popup-path-label">{t("tabHoverCard.sessionLabel")}</span>
          <span className="pill-popup-path">{tab.sessionId}</span>
        </span>
      )}
    </div>,
    document.body,
  );
}
