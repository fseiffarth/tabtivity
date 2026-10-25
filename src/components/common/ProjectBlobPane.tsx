import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { openFileEntry } from "../files/openFileEntry";
import { useTabScope } from "../tabs/tabScopeContext";
import { resolveProjectDirectory, type ProjectBox, type ProjectEntry } from "../../types";
import { ActivityCalendar } from "../projects/ActivityCalendar";
import { CategoryEditor } from "../projects/CategoryEditor";
import { categoryColor, primaryCategoryColor, projectCategories } from "../../lib/theme/categoryColor";
import { quiesceActive } from "../../stores/power";
import {
  type FileEntry,
  disabledViewers,
  fmtSize,
  fmtModified,
} from "../../lib/viewers/fileUtils";
import { useT } from "../../lib/i18n";
import { FileIcon } from "./icons/FileIcon";
import { HexagonIcon } from "./icons/Icon";

/**
 * A node in the 3D cloud. In the project cloud it's a project or a box; once a
 * project is focused (the spherical file viewer) it's the centered project plus
 * one node per file/folder in the current directory.
 */
type BlobNode =
  | { id: string; kind: "project"; project: ProjectEntry }
  | { id: string; kind: "box"; box: ProjectBox }
  | { id: string; kind: "center"; project: ProjectEntry; label: string; rel: string }
  | { id: string; kind: "file"; entry: FileEntry };

/** A 3D coordinate (already scaled by the node's cloud radius at layout time). */
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The focused project + the directory currently shown around it. */
interface FocusState {
  project: ProjectEntry;
  dir: string; // absolute project root
  rel: string; // current directory relative to the root ("" = root)
}

/**
 * Distribute `n` points evenly over a sphere of `radius` using the Fibonacci
 * lattice — deterministic and visually uniform without clustering at the poles.
 */
function fibonacciSphere(n: number, radius: number): Vec3[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, z: radius }];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2; // 1 → -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius });
  }
  return out;
}

/** A point on a circle of `r` at angle `a` (radians), centered at (cx, cy). */
function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/**
 * SVG path for a donut segment between angles `a0`→`a1` (radians, clockwise),
 * with outer/inner radii `rO`/`rI`. A near-full sweep (the single-project case)
 * is drawn as a complete ring via an even-odd circle pair, since a normal arc
 * whose endpoints coincide renders nothing.
 */
function donutSlicePath(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-3) {
    const ring = (r: number) =>
      `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
    return `${ring(rO)} ${ring(rI)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, rO, a0);
  const [x1, y1] = polar(cx, cy, rO, a1);
  const [x2, y2] = polar(cx, cy, rI, a1);
  const [x3, y3] = polar(cx, cy, rI, a0);
  return `M ${x0} ${y0} A ${rO} ${rO} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rI} ${rI} 0 ${large} 0 ${x3} ${y3} Z`;
}

const ROT_SENSITIVITY = 0.3; // deg per px dragged
const AUTO_SPIN = 0.06; // deg per frame when idle
const MIN_DOLLY = -360;
const PERSPECTIVE = 1100; // px; the perspective the CSS scene used to delegate
// Zoom (dolly) can now push the camera all the way through the cloud rather than
// stopping at the front shell. At dz = PERSPECTIVE the camera plane sits at the
// cloud centre; a little beyond lets you fly out the far side. Capped so the
// fly-through ends in mostly-empty space instead of an unbounded void.
const MAX_DOLLY = PERSPECTIVE + 360;
// Nodes whose projected depth falls within this of the camera are treated as
// flown-past: hidden and click-through. NEAR_FADE is the runway over which a
// node dissolves as it approaches that plane, so passing through one is a soft
// fade rather than a pop (and it never blows up to an infinite scale).
const NEAR_PLANE = 60;
const NEAR_FADE = 240;
const DBL_CLICK_MS = 260; // window to detect a double-click before the single fires

/** Human-readable total time tracked on a project. */
function fmtWorked(t: ReturnType<typeof useT>, secs?: number): string {
  if (!secs || secs <= 0) return t("blob.untracked");
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? t("blob.workedHm", { h, m }) : t("blob.workedM", { m });
}

/** Where the right-click menu is anchored, plus the project it targets. */
interface BlobMenu {
  x: number;
  y: number;
  project: ProjectEntry;
}

/**
 * The "Projects" tab body: a navigable 3D cloud of every project and box, plus
 * a spherical file viewer. Drag to orbit, scroll to zoom (dolly).
 *
 * Two modes:
 *  - **Cloud** (default): every project + box floats around the center. A
 *    project's *distance* from the center grows with the time tracked on it, so
 *    the most-worked projects sit furthest out. Single-click a project to focus
 *    it (open the file viewer); double-click to open it as the current scope.
 *  - **File viewer** (a project is focused): that project is pinned at the
 *    center and its files/folders orbit around it. Click a folder to descend,
 *    a file to open it, the center (or Esc) to go back up / exit.
 *
 * Rendered without WebGL: the rAF loop rotates each node's point and does the
 * perspective divide itself, then writes a plain 2D transform to the DOM. It
 * deliberately does NOT lean on CSS `perspective`/`preserve-3d` to project the
 * Z — WebKitGTK (Linux) drops nested-3D Z, which flattened the sphere to a disc,
 * while Chromium/WebView2 (Windows) honored it. Keeping the orbit/zoom state in
 * refs means a slow spin and a 60fps drag never thrash React. Each node is also
 * depth-shaded (front bright, back dim) so the cloud reads as a solid sphere.
 */
export function ProjectBlobPane({ visible = true }: { visible?: boolean } = {}) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const setActive = useProjectsStore((s) => s.setActive);
  const activateProject = useProjectsStore((s) => s.activateProject);
  const deactivateProject = useProjectsStore((s) => s.deactivateProject);
  const boxes = useBoxesStore((s) => s.boxes);
  const openBox = useBoxesStore((s) => s.openBox);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabledViewerSet = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  const tabScope = useTabScope();

  // A project can belong to several boxes. Keep this derived from the boxes'
  // canonical member lists, so the cloud never needs a second membership field
  // on its project nodes (and category tags remain independent of box tags).
  const boxNamesByProject = useMemo(() => {
    const names = new Map<string, string[]>();
    for (const box of boxes) {
      for (const projectId of box.member_ids) {
        const projectBoxes = names.get(projectId);
        if (projectBoxes) projectBoxes.push(box.name);
        else names.set(projectId, [box.name]);
      }
    }
    return names;
  }, [boxes]);

  const [menu, setMenu] = useState<BlobMenu | null>(null);
  // The project whose category editor is open (null = closed).
  const [catProject, setCatProject] = useState<ProjectEntry | null>(null);
  // The node currently hovered, plus where to anchor its info card. Cleared on
  // leave, on an orbit drag, and whenever the context menu opens.
  const [hover, setHover] = useState<{ x: number; y: number; node: BlobNode } | null>(null);
  // Per-project activity history (date → seconds). Drives both the hover card's
  // GitHub-style heatmap and the time-based cloud radius, so it's fetched for
  // every project (not just on hover) and cached.
  const [activity, setActivity] = useState<Record<string, Record<string, number>>>({});
  // The focused project + directory (null = project cloud).
  const [focus, setFocus] = useState<FocusState | null>(null);
  // Files/folders of the focused directory.
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  // Which visualization the project cloud renders: the 3D "sphere" (default) or
  // a 2D "pie" donut of time tracked per project. The file viewer (focus) is
  // sphere-only, so the toggle is hidden — and switching to pie exits focus.
  const [viewMode, setViewMode] = useState<"sphere" | "pie">("sphere");

  // Fetch activity for any project we don't have yet (the guard makes this a
  // one-shot per project, not a refetch loop).
  useEffect(() => {
    const missing = projects.filter((p) => !(p.id in activity)).map((p) => p.id);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((id) =>
        invoke<Record<string, number>>("get_project_activity", { projectId: id })
          .then((d) => [id, d] as const)
          .catch(() => [id, {}] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setActivity((m) => ({ ...m, ...Object.fromEntries(pairs) }));
    });
    return () => {
      cancelled = true;
    };
  }, [projects, activity]);

  // Total seconds tracked per project, and the busiest project, for the radius.
  const totals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, d] of Object.entries(activity)) {
      out[id] = Object.values(d).reduce((a, b) => a + b, 0);
    }
    return out;
  }, [activity]);
  const maxTotal = useMemo(() => {
    let m = 1;
    for (const v of Object.values(totals)) if (v > m) m = v;
    return m;
  }, [totals]);

  // Pie slices: one per project, the sweep proportional to time tracked. A flat
  // floor is added to every weight so untracked projects still get a visible,
  // clickable wedge (and all-untracked clouds split evenly). Slices start at the
  // top (−90°) and run clockwise.
  const pieSlices = useMemo(() => {
    const items = [...projects].sort((a, b) => a.position - b.position);
    if (items.length === 0) return [];
    const secs = items.map((p) => totals[p.id] ?? 0);
    const floor = maxTotal * 0.08;
    const adj = secs.map((s) => s + floor);
    const sum = adj.reduce((a, b) => a + b, 0) || 1;
    let acc = -Math.PI / 2;
    return items.map((project, i) => {
      const frac = adj[i] / sum;
      const a0 = acc;
      const a1 = acc + frac * Math.PI * 2;
      acc = a1;
      const cat = primaryCategoryColor(projectCategories(project));
      const color = cat ?? (project.status === "inactive" ? "var(--text-muted)" : "var(--accent)");
      return { project, a0, a1, frac, secs: secs[i], color, single: items.length === 1 };
    });
  }, [projects, totals, maxTotal]);

  // Load the focused directory's listing whenever the focus/path changes.
  useEffect(() => {
    if (!focus) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setEntriesLoading(true);
    invoke<FileEntry[]>("list_dir", { projectDir: focus.dir, relPath: focus.rel })
      .then((r) => {
        if (!cancelled) setEntries(r);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setEntriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focus]);

  const nodes = useMemo<BlobNode[]>(() => {
    if (focus) {
      const label = focus.rel === "" ? focus.project.name : focus.rel.split("/").pop()!;
      const center: BlobNode = { id: "center", kind: "center", project: focus.project, label, rel: focus.rel };
      const fileNodes: BlobNode[] = entries.map((entry) => ({ id: `f:${entry.path}`, kind: "file", entry }));
      return [center, ...fileNodes];
    }
    const projectNodes: BlobNode[] = [...projects]
      .sort((a, b) => a.position - b.position)
      .map((project) => ({ id: `p:${project.id}`, kind: "project", project }));
    const boxNodes: BlobNode[] = [...boxes]
      .sort((a, b) => a.position - b.position)
      .map((box) => ({ id: `b:${box.id}`, kind: "box", box }));
    return [...projectNodes, ...boxNodes];
  }, [focus, entries, projects, boxes]);

  // Cloud radius grows with population so dense clouds don't overlap.
  const radius = useMemo(() => Math.min(560, 220 + nodes.length * 16), [nodes.length]);

  // Each ring node gets an even direction from the Fibonacci lattice, then a
  // per-node distance: projects push out with time worked (more time → further
  // from center), boxes sit at a neutral mid-radius, files are uniform, and the
  // focused project is pinned at the very center.
  const positions = useMemo(() => {
    const ring = nodes.filter((n) => n.kind !== "center");
    const dirs = fibonacciSphere(ring.length, 1);
    const dirById = new Map<string, Vec3>();
    ring.forEach((n, i) => dirById.set(n.id, dirs[i] ?? { x: 0, y: 0, z: 1 }));
    return nodes.map((n) => {
      if (n.kind === "center") return { x: 0, y: 0, z: 0 };
      const d = dirById.get(n.id) ?? { x: 0, y: 0, z: 1 };
      let s: number;
      if (n.kind === "project") {
        const tot = totals[n.project.id];
        s = tot === undefined ? 0.72 : 0.5 + 0.5 * (tot / maxTotal);
      } else if (n.kind === "box") {
        s = 0.72;
      } else {
        s = 1; // files: uniform shell around the focused project
      }
      const r = radius * s;
      return { x: d.x * r, y: d.y * r, z: d.z * r };
    });
  }, [nodes, radius, totals, maxTotal]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef<Map<string, HTMLDivElement>>(new Map());
  // The hover card follows its node as the sphere spins, so the rAF loop pins it
  // each frame. It reads the hovered id (not React state, which the once-mounted
  // loop can't see) and writes straight to the card element.
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const hoverIdRef = useRef<string | null>(null);
  // Mirror the outer radius into a ref so the rAF loop (mounted once) can
  // normalize each node's rotated depth without re-binding on population change.
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  // Mirror the hovered node id (suppressed while the menu is open) for the loop.
  hoverIdRef.current = hover && !menu ? hover.node.id : null;
  // Mirror the view mode so the (once-bound) orbit handler can ignore drags
  // while the flat pie is showing.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  // Pending single-click timer, so a double-click can cancel the single action.
  const clickTimer = useRef<number | null>(null);

  // Live orbit/zoom state — held in refs (not React state) so the rAF loop can
  // mutate them without re-rendering. rotY orbits horizontally, rotX vertically.
  const rotX = useRef(-12);
  const rotY = useRef(0);
  const dolly = useRef(0); // translateZ of the whole scene (zoom)
  const dragging = useRef(false);
  // Set true once a press becomes a real orbit drag, so the click that the
  // browser fires on pointerup is ignored by the node handlers. Reset at the
  // start of every gesture (in onPointerDown) so it can never leak into a later,
  // genuine click — the failure mode of the old one-shot window swallow.
  const suppressClick = useRef(false);
  // Bloom animation: on every layout change (enter/leave focus, change folder)
  // the nodes fly out from the center. Progress runs 0→1 over ~380ms; the rAF
  // loop scales each node's radius by it. lastTs carries the frame timestamp.
  const animProgress = useRef(1);
  const lastTs = useRef(0);
  // Phase-1 "fly to center" when focusing a project: the chosen node id, its
  // 0→1 progress, and the focus to commit (phase 2: the files bloom out) once it
  // lands. Driven by the rAF loop so it can't fight React re-renders.
  const convergeId = useRef<string | null>(null);
  const convergeProgress = useRef(0);
  const pendingFocus = useRef<FocusState | null>(null);
  // Restart the bloom whenever the rendered layout (mode/project/folder) changes.
  const layoutKey = focus ? `f:${focus.project.id}:${focus.rel}` : "cloud";
  useEffect(() => {
    animProgress.current = 0;
  }, [layoutKey]);

  const registerNode = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) nodeEls.current.set(id, el);
      else nodeEls.current.delete(id);
    },
    [],
  );

  // rAF loop: rotate + project every node and pin the hover card. Auto-spins
  // gently while the user isn't dragging. Mounted only while the pane is laid
  // out: panes stay mounted across scope switches, and a hidden pane's loop —
  // even one that skips its work — kept a 60fps rAF alive for the whole session
  // whenever another project was current. `lastTs` resets on re-show so the
  // first frame's dt doesn't bank the hidden spell as elapsed animation time.
  useEffect(() => {
    if (!visible) return;
    lastTs.current = 0;
    let raf = 0;
    const frame = (ts: number) => {
      // Belt-and-braces: skip the work while the box has no layout (mid-restore,
      // display:none for a reason the prop can't see).
      if (!viewportRef.current?.offsetParent) {
        lastTs.current = ts;
        raf = requestAnimationFrame(frame);
        return;
      }
      // Advance the bloom: ease the radius out, fade opacity in a touch faster.
      const dt = lastTs.current ? ts - lastTs.current : 16;
      lastTs.current = ts;
      if (animProgress.current < 1) animProgress.current = Math.min(1, animProgress.current + dt / 380);
      const grow = 1 - Math.pow(1 - animProgress.current, 3); // easeOutCubic radius
      const fadeIn = Math.min(1, animProgress.current * 1.6);
      // Phase-1 converge: pull the chosen node to center, fade the rest out.
      let convAmt = 0;
      if (convergeId.current) {
        convergeProgress.current = Math.min(1, convergeProgress.current + dt / 240);
        convAmt = 1 - Math.pow(1 - convergeProgress.current, 2);
      }
      // Energy Saver freezes the idle auto-spin: a static scene re-projects to
      // identical positions, so the per-frame trig stops mattering. Drag/hover
      // still work (they mutate rotY/convergeId directly).
      if (!dragging.current && !quiesceActive()) rotY.current += AUTO_SPIN;
      const rx = rotX.current;
      const ry = rotY.current;
      const scene = sceneRef.current;
      // The scene stays untransformed and only anchors the cloud's center. We
      // project every node to 2D ourselves (below) instead of handing the scene
      // a rotate/translateZ and letting the browser project it: this WebKitGTK
      // build doesn't reliably honor nested `preserve-3d`, so each node's Z was
      // dropped and the sphere collapsed to a flat disc (WebView2 honored it, so
      // Windows looked correct).
      if (scene) scene.style.transform = "none";
      // Scene rotation Rx·Ry (matching the original CSS transform order). We
      // rotate each point here and project it with a manual perspective divide
      // so the result is identical on every webview.
      const rxr = (rx * Math.PI) / 180;
      const ryr = (ry * Math.PI) / 180;
      const cx = Math.cos(rxr);
      const sx = Math.sin(rxr);
      const cy = Math.cos(ryr);
      const sy = Math.sin(ryr);
      const radius = radiusRef.current || 1;
      const dz = dolly.current; // zoom, applied as a Z offset before projection
      const hoverId = hoverIdRef.current;
      for (const [id, el] of nodeEls.current.entries()) {
        // Per-node radius/opacity factors. Default = the bloom intro; during a
        // converge the chosen node is pulled to center (the rest fade + drift).
        let nodeGrow = grow;
        let nodeFade = fadeIn;
        if (convergeId.current) {
          if (id === convergeId.current) {
            nodeGrow = 1 - convAmt;
            nodeFade = 1;
          } else {
            nodeGrow = 1 + convAmt * 0.5;
            nodeFade = 1 - convAmt;
          }
        }
        // Scale by the factor so nodes fly out from / into the center; the
        // focused project sits at the origin and so stays put while files spread.
        const x = (Number(el.dataset.x) || 0) * nodeGrow;
        const y = (Number(el.dataset.y) || 0) * nodeGrow;
        const z = (Number(el.dataset.z) || 0) * nodeGrow;
        // Apply Ry then Rx to the point. worldZ grows toward the viewer.
        const x1 = x * cy + z * sy;
        const z1 = -x * sy + z * cy;
        const screenY = y * cx - z1 * sx;
        const worldZ = y * sx + z1 * cx;
        // Perspective divide: nearer nodes (high worldZ) magnify and spread out,
        // farther ones shrink toward the center — the cue that turns a flat ring
        // of cards into a readable sphere. `denom` shrinks as the camera dollies
        // toward a node; once it reaches the near plane the node is at/behind the
        // camera (we've flown past it), so hide it and let clicks fall through.
        const denom = PERSPECTIVE - (worldZ + dz);
        if (denom <= NEAR_PLANE) {
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
          el.style.zIndex = "-1";
          continue;
        }
        const f = PERSPECTIVE / denom;
        const tx = x1 * f;
        const ty = screenY * f;
        // Depth-shade opacity (0 far … 1 near) on top of the size foreshortening;
        // zIndex keeps front cards above back ones.
        const t = Math.max(0, Math.min(1, (worldZ / radius + 1) / 2));
        // Dissolve the node over the near runway so flying through it fades out
        // smoothly instead of popping at full (huge) scale.
        const nearFade = Math.min(1, (denom - NEAR_PLANE) / NEAR_FADE);
        el.style.pointerEvents = "";
        el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${f.toFixed(3)})`;
        el.style.opacity = ((0.28 + t * 0.72) * nodeFade * nearFade).toFixed(3);
        el.style.zIndex = String(Math.round(worldZ));
        // Pin the hover card just off the node so it tracks the spin. The scene
        // is anchored at the viewport center, so the node's screen point is that
        // center plus its projected offset.
        if (id === hoverId && hoverCardRef.current && viewportRef.current) {
          const vp = viewportRef.current.getBoundingClientRect();
          const card = hoverCardRef.current;
          const cw = card.offsetWidth;
          const ch = card.offsetHeight;
          const px = vp.left + vp.width / 2 + tx + 70 * f + 14;
          const py = vp.top + vp.height / 2 + ty - 14;
          card.style.left = `${Math.min(Math.max(8, px), window.innerWidth - cw - 8)}px`;
          card.style.top = `${Math.min(Math.max(8, py), window.innerHeight - ch - 8)}px`;
        }
      }
      // Converge landed: commit the focus. The layout-key effect then resets the
      // bloom so the focused project's files fly out from the center.
      if (convergeId.current && convergeProgress.current >= 1) {
        const pf = pendingFocus.current;
        convergeId.current = null;
        pendingFocus.current = null;
        dolly.current = 0;
        setFocus(pf);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  // Pointer-drag to orbit. Movement beyond a small threshold marks the gesture a
  // drag (so the pointerup isn't treated as a node click).
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (viewModeRef.current === "pie") return; // pie is a flat chart — no orbit

    const startX = e.clientX;
    const startY = e.clientY;
    const baseRotX = rotX.current;
    const baseRotY = rotY.current;
    const target = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    // Fresh gesture: clear any stale suppression so a press that turns out to be
    // a plain click always reaches the node handlers.
    suppressClick.current = false;
    let moved = false;
    let captured = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Only treat this as an orbit drag once the pointer clears the threshold.
      // Capturing the pointer eagerly on press makes WebKitGTK route the
      // pointerup to the viewport, so the node never receives its click and both
      // single- and double-click die. Capturing lazily keeps a stationary click
      // a normal click.
      if (!moved) {
        if (Math.hypot(dx, dy) <= 4) return;
        moved = true;
        dragging.current = true;
        suppressClick.current = true;
        setHover(null);
        captured = true;
        target.setPointerCapture?.(pointerId);
      }
      rotY.current = baseRotY + dx * ROT_SENSITIVITY;
      // Clamp vertical orbit so the cloud never flips fully upside-down.
      rotX.current = Math.max(-85, Math.min(85, baseRotX - dy * ROT_SENSITIVITY));
    };
    const onUp = (ev: PointerEvent) => {
      dragging.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (captured) target.releasePointerCapture?.(ev.pointerId);
      // suppressClick stays set for the click the browser fires on this
      // pointerup (if any); the next pointerdown resets it, so it never leaks.
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    dolly.current = Math.max(MIN_DOLLY, Math.min(MAX_DOLLY, dolly.current - e.deltaY * 0.6));
  }, []);

  const clearClickTimer = useCallback(() => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  }, []);

  // Focus a project: pin it at center and open the spherical file viewer at its
  // root. Resets the zoom so the new shell is framed.
  const enterFocus = useCallback((project: ProjectEntry) => {
    const dir = resolveProjectDirectory(project);
    if (!dir) return;
    setHover(null);
    // Phase 1: the clicked project flies to center while the rest of the cloud
    // fades; the rAF loop commits the focus when the converge lands.
    pendingFocus.current = { project, dir, rel: "" };
    convergeProgress.current = 0;
    convergeId.current = `p:${project.id}`;
  }, []);

  // Jump straight to a directory (breadcrumb click); "" is the project root.
  const jumpTo = useCallback((rel: string) => {
    setHover(null);
    setFocus((f) => (f ? { ...f, rel } : f));
  }, []);

  // Leave the file viewer entirely, back to the project cloud.
  const exitToCloud = useCallback(() => {
    setHover(null);
    dolly.current = 0;
    setFocus(null);
  }, []);

  // Switch the cloud visualization. Leaving for the pie drops any open file
  // viewer (pie is a project-only view) and clears the hover card.
  const selectView = useCallback((mode: "sphere" | "pie") => {
    setHover(null);
    if (mode === "pie") {
      dolly.current = 0;
      setFocus(null);
    }
    setViewMode(mode);
  }, []);

  // Go up one level in the file viewer; exit to the project cloud from the root.
  const ascend = useCallback(() => {
    setHover(null);
    setFocus((f) => {
      if (!f) return null;
      if (f.rel === "") {
        dolly.current = 0;
        return null;
      }
      const parent = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
      return { ...f, rel: parent };
    });
  }, []);

  // Open = make a project the current scope (switches view) / open a box.
  const openNode = useCallback(
    (node: BlobNode) => {
      if (node.kind === "project" || node.kind === "center") void setActive(node.project.id);
      else if (node.kind === "box") void openBox(node.box.id);
    },
    [setActive, openBox],
  );

  // Single click. In the cloud a project focuses (deferred so a double-click can
  // promote it to "open scope"); a box opens. In the file viewer a folder
  // descends, a file opens, and the center steps back up.
  const onNodeClick = useCallback(
    (node: BlobNode) => {
      // Swallow the click the browser fires at the end of an orbit drag so the
      // node the pointer happened to release over isn't activated.
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      clearClickTimer();
      if (node.kind === "center") {
        ascend();
        return;
      }
      if (node.kind === "file") {
        if (node.entry.is_dir) {
          setHover(null);
          setFocus((f) => (f ? { ...f, rel: f.rel ? `${f.rel}/${node.entry.name}` : node.entry.name } : f));
        } else {
          // The shared open-a-file policy: an in-app viewer opens in a tab
          // like everywhere else; only a file without one goes to the OS,
          // which asks first (threat recheck follow-up (b)).
          if (focus) {
            openFileEntry({
              entry: node.entry,
              projectDir: focus.dir,
              projectId: focus.project.id,
              origin: "blob_file_viewer",
              external: false,
              disabled: disabledViewerSet,
              scope: tabScope,
            });
          }
        }
        return;
      }
      if (node.kind === "box") {
        openNode(node);
        return;
      }
      const { project } = node;
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        enterFocus(project);
      }, DBL_CLICK_MS);
    },
    [clearClickTimer, ascend, focus, openNode, enterFocus, disabledViewerSet, tabScope],
  );

  const onNodeDoubleClick = useCallback(
    (node: BlobNode) => {
      clearClickTimer();
      if (node.kind === "project" || node.kind === "box" || node.kind === "center") openNode(node);
    },
    [openNode, clearClickTimer],
  );

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: BlobNode) => {
      const project = node.kind === "project" || node.kind === "center" ? node.project : null;
      if (!project) return;
      e.preventDefault();
      e.stopPropagation();
      clearClickTimer();
      setHover(null);
      setMenu({ x: e.clientX, y: e.clientY, project });
    },
    [clearClickTimer],
  );

  // Dismiss the context menu on any outside pointer (incl. an orbit drag start).
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);

  // Esc closes the context menu first, then steps back up / exits the file
  // viewer. Not while the pane is hidden or another handler already took it.
  useEffect(() => {
    if (!focus && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !visible || e.defaultPrevented) return;
      if (menu) setMenu(null);
      else ascend();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, menu, visible, ascend]);

  // Drop the pending single-click timer if the pane unmounts.
  useEffect(() => () => clearClickTimer(), [clearClickTimer]);

  const isPie = viewMode === "pie" && !focus;
  const hoveredProject =
    hover?.node.kind === "project" || hover?.node.kind === "center" ? hover.node.project : null;
  const hoveredCategories = hoveredProject ? projectCategories(hoveredProject) : [];
  const hoveredBoxNames = hoveredProject ? boxNamesByProject.get(hoveredProject.id) ?? [] : [];

  if (nodes.length === 0 && !focus) {
    return (
      <div className="blob-viewport blob-empty">
        <div className="blob-empty-card">{t("blob.noProjectsYet")}</div>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className={`blob-viewport${isPie ? " blob-viewport-pie" : ""}`}
      onPointerDown={onPointerDown}
      onWheel={onWheel}
    >
      {focus && (
        <div className="blob-breadcrumb" onPointerDown={(e) => e.stopPropagation()}>
          <button className="blob-crumb blob-crumb-exit" title={t("blob.backToProjects")} onClick={exitToCloud}>
            ✕
          </button>
          <button className="blob-crumb" onClick={() => jumpTo("")}>
            {focus.project.name}
          </button>
          {focus.rel
            ? focus.rel.split("/").map((seg, idx, arr) => (
                <Fragment key={idx}>
                  <span className="blob-crumb-sep">/</span>
                  <button className="blob-crumb" onClick={() => jumpTo(arr.slice(0, idx + 1).join("/"))}>
                    {seg}
                  </button>
                </Fragment>
              ))
            : null}
          {entriesLoading && <span className="blob-crumb-loading">{t("blob.loadingLower")}</span>}
        </div>
      )}
      {!focus && (
        <div className="blob-view-toggle" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className={viewMode === "sphere" ? "is-active" : ""}
            onClick={() => selectView("sphere")}
            title={t("blob.sphereViewTitle")}
          >
            {t("blob.sphereView")}
          </button>
          <button
            className={viewMode === "pie" ? "is-active" : ""}
            onClick={() => selectView("pie")}
            title={t("blob.pieViewTitle")}
          >
            {t("blob.pieView")}
          </button>
        </div>
      )}
      <div className="blob-hint">
        {focus
          ? t("blob.hintFocused")
          : isPie
            ? t("blob.hintPie")
            : t("blob.hintCloud")}
      </div>
      {isPie ? (
        pieSlices.length === 0 ? (
          <div className="blob-pie-empty">{t("blob.noProjectsToChart")}</div>
        ) : (
          <div className="blob-pie-stage">
            <svg className="blob-pie-svg" viewBox="0 0 320 320" preserveAspectRatio="xMidYMid meet">
              {pieSlices.map((sl) => {
                const node: BlobNode = { id: `p:${sl.project.id}`, kind: "project", project: sl.project };
                const isAct = sl.project.id === activeId;
                const mid = (sl.a0 + sl.a1) / 2;
                const [lx, ly] = polar(160, 160, 116, mid);
                return (
                  <g key={sl.project.id} className={`blob-pie-slice${isAct ? " is-active" : ""}`}>
                    <path
                      d={donutSlicePath(160, 160, 150, 78, sl.a0, sl.a1)}
                      fill={sl.color}
                      fillRule={sl.single ? "evenodd" : "nonzero"}
                      onPointerEnter={(e) => setHover({ x: e.clientX, y: e.clientY, node })}
                      onPointerLeave={() => setHover((h) => (h?.node.id === node.id ? null : h))}
                      onClick={(e) => {
                        e.stopPropagation();
                        void setActive(sl.project.id);
                      }}
                      onContextMenu={(e) => onNodeContextMenu(e, node)}
                    />
                    {sl.frac > 0.055 && (
                      <text
                        className="blob-pie-label"
                        x={lx}
                        y={ly}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {sl.project.name}
                      </text>
                    )}
                  </g>
                );
              })}
              <text className="blob-pie-center" x="160" y="153" textAnchor="middle">
                {t(projects.length === 1 ? "blob.projectCountOne" : "blob.projectCountMany", { count: projects.length })}
              </text>
              <text className="blob-pie-center-sub" x="160" y="173" textAnchor="middle">
                {fmtWorked(t, pieSlices.reduce((a, s) => a + s.secs, 0))}
              </text>
            </svg>
          </div>
        )
      ) : (
      <div className="blob-stage">
        <div ref={sceneRef} className="blob-scene">
          {nodes.map((node, i) => {
            const pos = positions[i] ?? { x: 0, y: 0, z: 0 };
            const base = `translate3d(${pos.x.toFixed(1)}px, ${pos.y.toFixed(1)}px, ${pos.z.toFixed(1)}px)`;

            let cls = "blob-node";
            let icon: React.ReactNode = "●";
            let label = "";
            let sub: number | null = null;
            let isActive = false;
            let catColor: string | null = null;
            let categories: string[] = [];
            let boxNames: string[] = [];
            if (node.kind === "project") {
              const status = node.project.status;
              cls += ` blob-node-project blob-status-${status}`;
              icon = status === "inactive" ? "○" : "●";
              label = node.project.name;
              isActive = node.project.id === activeId;
              categories = projectCategories(node.project);
              catColor = primaryCategoryColor(categories);
              boxNames = boxNamesByProject.get(node.project.id) ?? [];
              if (catColor) cls += " blob-node-categorized";
            } else if (node.kind === "box") {
              cls += " blob-node-box blob-status-box";
              icon = "▦";
              label = node.box.name;
              sub = node.box.member_ids.length;
            } else if (node.kind === "center") {
              cls += " blob-node-center";
              icon = node.rel === "" ? "◉" : "↑";
              label = node.label;
            } else {
              cls += node.entry.is_dir ? " blob-node-file blob-file-dir" : " blob-node-file blob-file-doc";
              icon = <FileIcon ext={node.entry.extension ?? null} isDir={node.entry.is_dir} />;
              label = node.entry.name;
            }
            if (isActive) cls += " blob-node-active";

            return (
              <div
                key={node.id}
                ref={registerNode(node.id)}
                data-x={pos.x.toFixed(1)}
                data-y={pos.y.toFixed(1)}
                data-z={pos.z.toFixed(1)}
                style={
                  catColor
                    ? ({ transform: base, "--cat-color": catColor } as React.CSSProperties)
                    : { transform: base }
                }
                className={cls}
                onPointerEnter={(e) => setHover({ x: e.clientX, y: e.clientY, node })}
                onPointerLeave={() => setHover((h) => (h?.node.id === node.id ? null : h))}
                onClick={(e) => {
                  e.stopPropagation();
                  onNodeClick(node);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onNodeDoubleClick(node);
                }}
                onContextMenu={(e) => onNodeContextMenu(e, node)}
              >
                <span className="blob-node-icon" aria-hidden>
                  {icon}
                </span>
                <span className="blob-node-label">{label}</span>
                {categories.length > 0 && (
                  <span
                    className="blob-node-category-dots"
                    title={t("pill.categoriesLabel", { list: categories.join(", ") })}
                    aria-label={t("pill.categoriesLabel", { list: categories.join(", ") })}
                  >
                    {categories.map((category) => (
                      <span
                        key={category.toLowerCase()}
                        className="blob-node-category-dot"
                        style={{ background: categoryColor(category) }}
                      />
                    ))}
                  </span>
                )}
                {boxNames.map((boxName) => (
                  <span key={boxName} className="blob-node-box-tag" title={t("pill.inBoxes", { list: boxName })}>
                    <HexagonIcon />
                    <span className="blob-node-box-tag-label">{boxName}</span>
                  </span>
                ))}
                {sub !== null && <span className="blob-node-sub">{sub}</span>}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* Category-tag editor (opened from a project node's right-click menu). */}
      {catProject && (
        <CategoryEditor project={catProject} onClose={() => setCatProject(null)} />
      )}

      {/* Right-click menu for a project node. */}
      {menu && createPortal(
        <div
          className="context-menu blob-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setMenu(null);
              void setActive(menu.project.id);
            }}
          >
            {t("blob.open")}
          </button>
          <button
            onClick={() => {
              const p = menu.project;
              setMenu(null);
              setCatProject(p);
            }}
          >
            {t("blob.categoriesEllipsis")}
          </button>
          {menu.project.status === "inactive" ? (
            <button
              onClick={() => {
                setMenu(null);
                void activateProject(menu.project.id);
              }}
            >
              {t("blob.activate")}
            </button>
          ) : (
            <button
              onClick={() => {
                setMenu(null);
                void deactivateProject(menu.project.id);
              }}
            >
              {t("blob.inactivate")}
            </button>
          )}
        </div>,
        document.body,
      )}

      {/* Hover info card, anchored to the node (pinned each frame by the rAF
          loop). Suppressed while the context menu is open. */}
      {hover && !menu && createPortal(
        <div
          ref={hoverCardRef}
          className="blob-hover-card"
          style={{
            left: Math.min(hover.x + 16, window.innerWidth - 320),
            top: Math.min(hover.y + 16, window.innerHeight - 200),
          }}
        >
          {(hover.node.kind === "project" || hover.node.kind === "center") && (
            <>
              <div className="blob-hover-title">{hover.node.project.name}</div>
              <div className="blob-hover-meta">
                {hover.node.kind === "center"
                  ? hover.node.rel
                    ? `/${hover.node.rel}`
                    : t("blob.projectRoot")
                  : `${hover.node.project.status} · ${fmtWorked(t, totals[hover.node.project.id])}`}
              </div>
              {hover.node.kind === "project" && (
                <div className="blob-hover-desc">
                  {hover.node.project.description?.trim() || t("blob.noDescriptionYet")}
                </div>
              )}
              {(hoveredCategories.length > 0 || hoveredBoxNames.length > 0) && (
                <div className="blob-hover-categories">
                  {hoveredCategories.map((cat) => (
                    <span
                      key={cat.toLowerCase()}
                      className="blob-hover-category"
                      style={{ "--cat-color": categoryColor(cat) } as React.CSSProperties}
                    >
                      <span className="blob-hover-category-dot" />
                      {cat}
                    </span>
                  ))}
                  {hoveredBoxNames.map((boxName) => (
                    <span key={boxName} className="blob-hover-box-tag">
                      <HexagonIcon />
                      {boxName}
                    </span>
                  ))}
                </div>
              )}
              {activity[hover.node.project.id] && (
                <div className="blob-hover-activity">
                  <ActivityCalendar data={activity[hover.node.project.id]} />
                </div>
              )}
              <div className="blob-hover-hint">
                {hover.node.kind === "center"
                  ? t("blob.hintCenterUp")
                  : t("blob.hintExploreOpen")}
              </div>
            </>
          )}
          {hover.node.kind === "box" && (
            <>
              <div className="blob-hover-title">{hover.node.box.name}</div>
              <div className="blob-hover-meta">
                {t(
                  hover.node.box.member_ids.length === 1 ? "blob.boxMetaOne" : "blob.boxMetaMany",
                  { count: hover.node.box.member_ids.length },
                )}
              </div>
              <div className="blob-hover-hint">{t("blob.doubleClickToOpen")}</div>
            </>
          )}
          {hover.node.kind === "file" && (
            <>
              <div className="blob-hover-title">{hover.node.entry.name}</div>
              <div className="blob-hover-meta">
                {hover.node.entry.is_dir
                  ? t("blob.folder")
                  : `${
                      hover.node.entry.extension
                        ? t("blob.extFile", { ext: hover.node.entry.extension.replace(/^\./, "").toUpperCase() })
                        : t("blob.file")
                    } · ${fmtSize(hover.node.entry.size)}`}
              </div>
              <div className="blob-hover-hint">
                {hover.node.entry.is_dir ? t("blob.clickToEnterFolder") : t("blob.clickToOpen")} ·{" "}
                {fmtModified(hover.node.entry.modified_secs)}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
