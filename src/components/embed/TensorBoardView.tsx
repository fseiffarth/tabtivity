import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewerHeader } from "./fileViewer/ViewerHeader";
import { ScalarChart, type ChartRun } from "./tensorboard/ScalarChart";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { ChevronDownIcon, ChevronRightIcon, RefreshIcon } from "../common/icons/Icon";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import {
  describeFileErrorKey,
  tfeventsDiscover,
  tfeventsRead,
  useFileScope,
  useFileSource,
  usePaneVisible,
} from "../../lib/files/fileAccess";
import { basename } from "../../lib/paths";
import {
  applyRead,
  compileTagFilter,
  emptyFileState,
  formatValue,
  groupRuns,
  groupTags,
  isEventFileName,
  isRecent,
  mergeRunFiles,
  newestWall,
  runForFile,
  runStyle,
  tagsOf,
  unshownCounts,
  type FileState,
  type TfFileInfo,
  type TfRun,
  type XMode,
} from "../../lib/viewers/tensorboard";
import { useT, type TranslationKey } from "../../lib/i18n";

/** How often a followed file is re-read: locally cheap, on a host kept slow. */
const LIVE_LOCAL_MS = 5_000;
const LIVE_REMOTE_MS = 20_000;
/** Every Nth live tick a folder is listed again, so a run started later appears. */
const REDISCOVER_EVERY = 12;
/** Charts shown per group before "Show more" (each is an SVG with its paths). */
const GROUP_PAGE = 24;
const DEFAULT_SMOOTHING = 0.6;

const KIND_KEYS: Record<string, TranslationKey> = {
  image: "tensorboard.kind.image",
  histogram: "tensorboard.kind.histogram",
  audio: "tensorboard.kind.audio",
  text: "tensorboard.kind.text",
  hparams: "tensorboard.kind.hparams",
};

/**
 * Native TensorBoard viewer (`docs/tensorboard_viewer_plan.md`): an event file
 * (`events.out.tfevents.*`), or a folder opened as training runs, drawn as one
 * chart per scalar tag. The bytes come through the same project-scoped,
 * confined read as every other viewer (`tfevents_read`: local or ranged over
 * SFTP), so no TensorBoard process, port or Python is involved.
 *
 * Reading is incremental: each file keeps the cursor of its last read and a
 * refresh moves only new bytes. Standing work is gated like the other viewers':
 * nothing polls while the pane is hidden (it catches up on show) or while a
 * remote project is not connected.
 */
export function TensorBoardView({
  path,
  onOpenExternally,
}: {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
}) {
  const t = useT();
  const scope = useFileScope();
  const visible = usePaneVisible();
  const source = useFileSource();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === scope));
  const ssh = useRemoteStatusStore((s) => (scope ? s.byProject[scope]?.ssh : undefined));
  // A read against a dead session can freeze the window: never poll one.
  const remoteDown = source === "remote" && !!project?.remote && ssh !== "connected";
  const remote = source === "remote";
  const isFile = isEventFileName(basename(path));

  // ── What there is to read ────────────────────────────────────────────────
  const [files, setFiles] = useState<TfFileInfo[] | null>(null);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [errorDetail, setErrorDetail] = useState("");
  const filesRef = useRef<TfFileInfo[]>([]);
  filesRef.current = files ?? [];

  // Per-file accumulated state lives in a ref (it grows large and changes in
  // place of React's cheap diffing); `rev` is the render signal.
  const statesRef = useRef(new Map<string, FileState>());
  const [rev, setRev] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  // A token per (path, scope) generation: an answer from an older one is dropped.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const tick = useRef(0);

  useEffect(() => {
    generation.current += 1;
    statesRef.current = new Map();
    inFlight.current = false;
    setRev((n) => n + 1);
    setLoaded(false);
    setPercent(null);
    setErrorKey(null);
    setLive(null);
    setFiles(isFile ? [{ path, size: 0, mtime: 0 }] : null);
  }, [path, scope, isFile]);

  const discover = useCallback(async () => {
    const gen = generation.current;
    try {
      const found = await tfeventsDiscover(path, scope);
      if (gen !== generation.current) return;
      setFiles((prev) => {
        const same =
          prev != null && prev.length === found.length && prev.every((f, i) => f.path === found[i].path);
        return same ? prev : found;
      });
      setErrorKey(null);
    } catch (e) {
      if (gen !== generation.current) return;
      setErrorKey(describeFileErrorKey(e));
      setErrorDetail(String(e));
      setFiles((prev) => prev ?? []);
    }
  }, [path, scope]);

  // Reading one pass over every file: each is followed until its read says
  // nothing more remains. A hidden pane stops mid-way and resumes on show.
  const pollAll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const gen = generation.current;
    setBusy(true);
    let firstError: unknown = null;
    try {
      for (const f of filesRef.current) {
        for (let guard = 0; guard < 5_000; guard++) {
          if (gen !== generation.current || !visibleRef.current) return;
          const prev = statesRef.current.get(f.path) ?? emptyFileState();
          let read;
          try {
            read = await tfeventsRead(f.path, scope, prev.cursor);
          } catch (e) {
            firstError ??= e;
            break;
          }
          if (gen !== generation.current) return;
          const changed =
            read.reset ||
            Object.keys(read.scalars).length > 0 ||
            Object.keys(read.skipped.series).length > 0 ||
            read.skipped.nonFinite + read.skipped.oversized + read.skipped.malformed + read.skipped.dropped > 0 ||
            read.skipped.badCrc !== prev.badCrc;
          statesRef.current.set(f.path, changed ? applyRead(prev, read) : { ...prev, cursor: read.cursor });
          if (changed) setRev((n) => n + 1);
          setPercent(read.cursor.size > 0 ? Math.min(100, Math.round((read.cursor.offset / read.cursor.size) * 100)) : 100);
          if (!read.truncated) break;
        }
      }
      if (gen !== generation.current) return;
      if (firstError != null) {
        setErrorKey(describeFileErrorKey(firstError));
        setErrorDetail(String(firstError));
      } else {
        setErrorKey(null);
      }
      setLoaded(true);
    } finally {
      if (gen === generation.current) {
        inFlight.current = false;
        setBusy(false);
        setPercent(null);
      }
    }
  }, [scope]);

  // ── Live ────────────────────────────────────────────────────────────────
  // `null` until the first pass says how fresh the data is.
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    if (live !== null || !loaded) return;
    const states = filesRef.current.map((f) => statesRef.current.get(f.path) ?? emptyFileState());
    setLive(isRecent(newestWall(states), Date.now()));
  }, [live, loaded, rev]);

  // A folder is listed once it is on screen and (for a host) connected.
  useEffect(() => {
    if (isFile || files !== null || !visible || remoteDown) return;
    void discover();
  }, [isFile, files, visible, remoteDown, discover]);

  const fileCount = files?.length ?? 0;
  const canRead = files !== null && fileCount > 0 && visible && !remoteDown;
  // Catch up now: the first load, or the pane was just shown (or reconnected).
  useEffect(() => {
    if (canRead) void pollAll();
  }, [canRead, files, pollAll]);
  // ... and keep following while Live is on.
  useEffect(() => {
    if (!canRead || !live) return;
    const id = window.setInterval(() => {
      tick.current += 1;
      if (!isFile && tick.current % REDISCOVER_EVERY === 0) void discover();
      void pollAll();
    }, remote ? LIVE_REMOTE_MS : LIVE_LOCAL_MS);
    return () => window.clearInterval(id);
  }, [canRead, live, remote, isFile, pollAll, discover]);

  // ── View state ──────────────────────────────────────────────────────────
  const [smoothing, setSmoothing] = useState(DEFAULT_SMOOTHING);
  const [xMode, setXMode] = useState<XMode>("step");
  const [logY, setLogY] = useState(false);
  const [filter, setFilter] = useState("");
  const [hiddenRuns, setHiddenRuns] = useState<ReadonlySet<string>>(new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [pages, setPages] = useState<Record<string, number>>({});
  const [enlarged, setEnlarged] = useState<string | null>(null);

  const runs: TfRun[] = useMemo(
    () => (isFile ? [runForFile(path)] : groupRuns(path, (files ?? []).map((f) => f.path))),
    [isFile, path, files],
  );

  // `rev` is the signal that the ref's contents changed.
  const runStates = useMemo(
    () => runs.map((r) => r.files.map((p) => statesRef.current.get(p) ?? emptyFileState())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, rev],
  );
  const allStates = useMemo(() => runStates.flat(), [runStates]);
  const tags = useMemo(() => tagsOf(allStates), [allStates]);
  const matcher = useMemo(() => compileTagFilter(filter), [filter]);
  const groups = useMemo(() => groupTags(tags.filter(matcher.test)), [tags, matcher]);
  const unshown = useMemo(() => unshownCounts(allStates), [allStates]);
  const totals = useMemo(
    () => ({
      nonFinite: allStates.reduce((n, s) => n + s.nonFinite, 0),
      oversized: allStates.reduce((n, s) => n + s.oversized, 0),
      dropped: allStates.reduce((n, s) => n + s.dropped, 0),
      malformed: allStates.reduce((n, s) => n + s.malformed, 0),
      badCrc: allStates.some((s) => s.badCrc),
    }),
    [allStates],
  );

  const chartRuns = useCallback(
    (tag: string): ChartRun[] => {
      const out: ChartRun[] = [];
      runs.forEach((run, i) => {
        if (hiddenRuns.has(run.name)) return;
        const points = mergeRunFiles(runStates[i], tag);
        if (points.length === 0) return;
        const style = runStyle(i);
        out.push({ name: run.name, slot: style.slot, dash: style.dash, points });
      });
      return out;
    },
    [runs, runStates, hiddenRuns],
  );

  // Escape closes the enlarged chart.
  useEffect(() => {
    if (enlarged == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  const toggleRun = (name: string) =>
    setHiddenRuns((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleGroup = (g: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const refresh = () => {
    if (!isFile) void discover();
    void pollAll();
  };

  const xOptions = [
    { value: "step", label: t("tensorboard.x.step") },
    { value: "relative", label: t("tensorboard.x.relative") },
    { value: "wall", label: t("tensorboard.x.wall") },
  ];

  // ── Render ──────────────────────────────────────────────────────────────
  const waiting = files === null || (!loaded && files.length > 0 && tags.length === 0);
  const noFiles = files !== null && files.length === 0 && errorKey == null;
  const hasData = tags.length > 0;
  const enlargedRuns = enlarged != null ? chartRuns(enlarged) : [];

  return (
    <div className="file-viewer tb-viewer">
      <ViewerHeader onOpenExternally={onOpenExternally}>
        <div className="file-viewer-zoom tb-controls" role="group" aria-label={t("tensorboard.controlsAria")}>
          <button
            className={`file-viewer-zoom-btn file-viewer-zoom-text tb-live${live ? " is-on" : ""}`}
            aria-pressed={!!live}
            onClick={() => setLive(!live)}
            title={t(live ? "tensorboard.liveOnTitle" : "tensorboard.liveOffTitle", {
              seconds: (remote ? LIVE_REMOTE_MS : LIVE_LOCAL_MS) / 1000,
            })}
          >
            <span className="tb-live-dot" aria-hidden="true" />
            {t("tensorboard.live")}
            <UntestedTag id="viewer.tensorboard.live" />
          </button>
          <button
            className="file-viewer-zoom-btn file-viewer-zoom-text"
            onClick={refresh}
            disabled={busy}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshIcon />
          </button>
          <label className="tb-smooth" title={t("tensorboard.smoothingTitle")}>
            <span>{t("tensorboard.smoothing")}</span>
            <input
              type="range"
              className="gif-scrubber tb-range"
              min={0}
              max={0.99}
              step={0.01}
              value={smoothing}
              onChange={(e) => setSmoothing(Number(e.target.value))}
              aria-label={t("tensorboard.smoothing")}
            />
            <span className="file-viewer-zoom-level">{smoothing.toFixed(2)}</span>
          </label>
          <Dropdown
            className="gif-speed"
            value={xMode}
            options={xOptions}
            onChange={(v) => setXMode(v as XMode)}
            title={t("tensorboard.xAxisTitle")}
          />
          <button
            className={`file-viewer-zoom-btn file-viewer-zoom-text${logY ? " is-on" : ""}`}
            aria-pressed={logY}
            onClick={() => setLogY((v) => !v)}
            title={t("tensorboard.logYTitle")}
          >
            {t("tensorboard.logY")}
          </button>
        </div>
      </ViewerHeader>

      <div className="tb-subbar">
        <input
          type="text"
          className="tb-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("tensorboard.filterPlaceholder")}
          aria-label={t("tensorboard.filterPlaceholder")}
          aria-invalid={matcher.invalid}
          spellCheck={false}
        />
        {matcher.invalid && <span className="tb-filter-bad">{t("tensorboard.filterInvalid")}</span>}
        {runs.length > 1 && (
          <div className="tb-runs" role="group" aria-label={t("tensorboard.runsAria")}>
            {runs.map((run, i) => {
              const style = runStyle(i);
              const off = hiddenRuns.has(run.name);
              return (
                <button
                  key={run.name}
                  type="button"
                  className={`tb-run${off ? " is-off" : ""}`}
                  aria-pressed={!off}
                  onClick={() => toggleRun(run.name)}
                  title={t(off ? "tensorboard.runShowTitle" : "tensorboard.runHideTitle", { name: run.name })}
                >
                  <span
                    className="tb-swatch"
                    style={{ background: `var(--tb-series-${style.slot})` }}
                    aria-hidden="true"
                  />
                  {run.name}
                </button>
              );
            })}
            <UntestedTag id="viewer.tensorboard.runs" />
          </div>
        )}
        <span className="tb-status" aria-live="polite">
          {remoteDown
            ? t("tensorboard.notConnected")
            : busy && percent != null && percent < 100
              ? t("tensorboard.reading", { percent })
              : live
                ? t("tensorboard.liveStatus", { seconds: (remote ? LIVE_REMOTE_MS : LIVE_LOCAL_MS) / 1000 })
                : ""}
        </span>
        <UntestedTag id="viewer.tensorboard" />
      </div>

      <div className="file-viewer-body tb-body">
        {errorKey != null && !hasData ? (
          <div className="file-viewer-error">
            {t("tensorboard.readFailed", { error: `${t(errorKey)}${errorDetail ? ` (${errorDetail})` : ""}` })}
          </div>
        ) : noFiles ? (
          <div className="file-viewer-loading">{t("tensorboard.noFiles")}</div>
        ) : waiting ? (
          <div className="file-viewer-loading">
            {percent != null ? t("tensorboard.reading", { percent }) : t("common.loading")}
          </div>
        ) : !hasData ? (
          <div className="file-viewer-loading">{t("tensorboard.noScalars")}</div>
        ) : groups.length === 0 ? (
          <div className="file-viewer-loading">{t("tensorboard.noMatch")}</div>
        ) : (
          groups.map((g) => {
            const key = g.group || "\u0000";
            const isFolded = folded.has(key);
            const limit = (pages[key] ?? 1) * GROUP_PAGE;
            const shown = g.tags.slice(0, limit);
            return (
              <section key={key} className="tb-group">
                <button
                  type="button"
                  className="tb-group-head"
                  aria-expanded={!isFolded}
                  onClick={() => toggleGroup(key)}
                >
                  <span className="tb-caret" aria-hidden="true">{isFolded ? <ChevronRightIcon /> : <ChevronDownIcon />}</span>
                  <span className="tb-group-name">{g.group || t("tensorboard.ungrouped")}</span>
                  <span className="tb-group-count">{g.tags.length}</span>
                </button>
                {!isFolded && (
                  <>
                    <div className="tb-grid-wrap">
                      {shown.map((tag) => (
                        <ScalarChart
                          key={tag}
                          tag={tag}
                          runs={chartRuns(tag)}
                          xMode={xMode}
                          logY={logY}
                          smoothing={smoothing}
                          onOpen={() => setEnlarged(tag)}
                        />
                      ))}
                    </div>
                    {g.tags.length > shown.length && (
                      <button
                        type="button"
                        className="file-viewer-zoom-btn file-viewer-zoom-text tb-more"
                        onClick={() => setPages((p) => ({ ...p, [key]: (p[key] ?? 1) + 1 }))}
                      >
                        {t("tensorboard.showMore", { count: g.tags.length - shown.length })}
                      </button>
                    )}
                  </>
                )}
              </section>
            );
          })
        )}
      </div>

      <div className="tb-footer">
        {errorKey != null && hasData && (
          <span className="tb-note tb-note-warn">{t(errorKey)}</span>
        )}
        {unshown.length > 0 && (
          <span className="tb-note">
            {t("tensorboard.unshown", {
              list: unshown
                .map((u) => `${u.count} ${KIND_KEYS[u.kind] ? t(KIND_KEYS[u.kind]) : u.kind}`)
                .join(", "),
            })}
          </span>
        )}
        {totals.nonFinite > 0 && <span className="tb-note">{t("tensorboard.nonFinite", { count: totals.nonFinite })}</span>}
        {totals.oversized > 0 && <span className="tb-note">{t("tensorboard.oversized", { count: totals.oversized })}</span>}
        {totals.dropped > 0 && <span className="tb-note">{t("tensorboard.dropped", { count: totals.dropped })}</span>}
        {totals.malformed > 0 && <span className="tb-note">{t("tensorboard.malformed", { count: totals.malformed })}</span>}
        {totals.badCrc && <span className="tb-note tb-note-warn">{t("tensorboard.badCrc")}</span>}
      </div>

      {enlarged != null && (
        <div className="tb-overlay" role="dialog" aria-label={enlarged}>
          <div className="tb-overlay-bar">
            <span className="tb-overlay-title">{enlarged}</span>
            <button className="file-viewer-zoom-btn file-viewer-zoom-text" onClick={() => setEnlarged(null)}>
              {t("common.close")}
            </button>
          </div>
          <div className="tb-overlay-body">
            <ScalarChart tag={enlarged} runs={enlargedRuns} xMode={xMode} logY={logY} smoothing={smoothing} big />
            <DataTable runs={enlargedRuns} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The last rows of the enlarged chart as a table: the chart's text alternative. */
function DataTable({ runs }: { runs: readonly ChartRun[] }) {
  const t = useT();
  const rows = useMemo(() => {
    const steps = new Set<number>();
    for (const r of runs) for (const p of r.points.slice(-40)) steps.add(p[0]);
    const ordered = [...steps].sort((a, b) => b - a).slice(0, 40);
    const lookup = runs.map((r) => new Map(r.points.slice(-200).map((p) => [p[0], p[2]] as const)));
    return ordered.map((step) => ({ step, values: lookup.map((m) => m.get(step)) }));
  }, [runs]);
  if (rows.length === 0) return null;
  return (
    <details className="tb-table">
      <summary>{t("tensorboard.showData")}</summary>
      <table>
        <thead>
          <tr>
            <th>{t("tensorboard.x.step")}</th>
            {runs.map((r) => (
              <th key={r.name}>{r.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.step}>
              <td>{row.step}</td>
              {row.values.map((v, i) => (
                <td key={runs[i].name}>{v == null ? "" : formatValue(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
