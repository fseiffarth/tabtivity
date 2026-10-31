import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowsHorizontalIcon, ArrowUpIcon, TrashIcon } from "../../../src/components/common/icons/Icon";
import { formatBytes } from "../../../src/lib/formatBytes";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { deleteSideOf, mtimeDivergenceCue, splitByDeleteSide, splitByNewerSide, withoutChangedOnBoth } from "../../../src/lib/remote/divergedRows";
import { isUntested } from "../../../src/lib/untested";
import { parseUnifiedDiff } from "../../../src/lib/viewers/diff";
import type { SyncEntryStatus } from "../../../src/stores/remote/sync";
import { ApiError, getDiverged, getDivergedDiff, previewDiverged, resolveDiverged, type DivergedList, type DivergedRow, type SyncDirection, type SyncOp, type SyncPreview } from "../api";
import { useBackLayer } from "../backStack";
import { OptionSheet } from "../components/OptionSheet";
import { describeFailure } from "../connection";

type Translate = ReturnType<typeof useT>;

/** Names one question lists: a heading over the files it is about. */
interface NameList { heading: string; names: string[]; more?: number }

/** A confirmation waiting on its second tap: what it says, then what it runs. */
interface Ask { title: string; lines: string[]; lists: NameList[]; label: string; steps: { op: SyncOp; ids: string[] }[] }

/** A file's diff as the sheet holds it once asked for. */
type DiffState = { loading: true } | { loading?: false; diff: string; cut: boolean } | { loading?: false; error: string };

/** A row as the rules shared with the desktop's orange view read it. */
function statusOf(row: DivergedRow): SyncEntryStatus {
  return {
    state: row.state,
    selected: true,
    isDir: false,
    auto: false,
    excluded: false,
    hostMtime: row.host_mtime ?? null,
    localMtime: row.local_mtime ?? null,
    hostDiverged: row.host_diverged,
    localDiverged: row.local_diverged,
    hostChecked: row.host_checked,
  };
}

/** What a preview says, in the desktop's own sentences. `null`: it failed,
 * which is said and never reads as nothing to lose. */
function previewLines(t: Translate, direction: SyncDirection, preview: SyncPreview | null, why: string): string[] {
  if (!preview) return [t("syncConfirm.previewFailed", { error: why })];
  const lines = [t("syncConfirm.willTransfer", { count: preview.files, size: formatBytes(preview.bytes) })];
  if (preview.tracked > 0) lines.push(t("syncConfirm.trackedAsCommits", { count: preview.tracked }));
  if (!preview.exact) lines.push(t("syncConfirm.notInspected"));
  else if (preview.overwrites > 0) lines.push(t(direction === "pull" ? "syncConfirm.overwritesLocal" : "syncConfirm.overwritesHost", { count: preview.overwrites }));
  return lines;
}

/** The files a transfer would lose changes in, by name. */
function lossList(t: Translate, direction: SyncDirection, preview: SyncPreview | null): NameList[] {
  if (!preview || preview.destructive_total === 0) return [];
  return [{
    heading: t(direction === "pull" ? "syncConfirm.lossLocalTitle" : "syncConfirm.lossHostTitle", { count: preview.destructive_total }),
    names: preview.destructive,
    more: preview.destructive_total - preview.destructive.length,
  }];
}

/**
 * A remote project's diverged files, the desktop's orange view at phone width
 * (the project screen's drawer): the files whose local and host copies
 * disagree, and the new files only the local copy holds. The window does the
 * work over its SSH session (`lib/mobileDiverged`), so this needs it open. A
 * tap on a file compares the two copies; the three-way merge stays on the
 * desktop, and so does the host scan for files only the host holds.
 *
 * Every take-a-side and deletion asks first with the desktop's confirmation,
 * priced by the same preview, and the window checks each file against a fresh
 * status pass before it moves anything. Without `project_sync` the list is
 * read-only.
 */
export function DivergedSheet({ projectId, label, onClose, onChanged }: { projectId: string; label: string; onClose: () => void; onChanged: () => void }) {
  useBackLayer(onClose);
  const t = useT();
  const [list, setList] = useState<DivergedList | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // A bulk take-a-side leaves true conflicts to their own rows, as the desktop's
  // tick does by default.
  const [excludeBoth, setExcludeBoth] = useState(true);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [working, setWorking] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    try {
      const next = await getDiverged(projectId, controller.signal);
      if (controller.signal.aborted) return;
      setList(next);
      setError("");
      // A token opens a file on any list, but a diff is of the bytes then.
      setDiffs({});
      setOpenId(null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(t("mobile.diverged.failed", { error: describeFailure(cause) }));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);

  // No polling: each read stats every tracked file on the host.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const rows = useMemo(() => list?.rows ?? [], [list]);
  const amber = useMemo(() => rows.filter((row) => row.state === "amber"), [rows]);
  const fresh = useMemo(() => rows.filter((row) => row.state === "localnew"), [rows]);
  const byPath = useMemo(() => Object.fromEntries(rows.map((row) => [row.path, statusOf(row)])), [rows]);
  const idOf = useMemo(() => new Map(rows.map((row) => [row.path, row.id])), [rows]);
  const ids = useCallback((paths: string[]) => paths.flatMap((path) => idOf.get(path) ?? []), [idOf]);
  const amberNames = useMemo(() => amber.map((row) => row.path), [amber]);
  const bulk = useMemo(() => excludeBoth ? withoutChangedOnBoth(byPath, amberNames) : amberNames, [excludeBoth, byPath, amberNames]);
  const newer = useMemo(() => splitByNewerSide(byPath, bulk), [byPath, bulk]);
  const deletable = useMemo(() => splitByDeleteSide(byPath, amberNames), [byPath, amberNames]);

  const canAct = !!list?.writes && !!list.connected && !working;

  const run = async (steps: Ask["steps"]) => {
    setWorking(true);
    setNotice("");
    setError("");
    try {
      let done = 0;
      let failed = 0;
      let skipped = 0;
      for (const step of steps) {
        const outcome = await resolveDiverged(projectId, step.op, step.ids);
        done += outcome.done;
        failed += outcome.failed;
        skipped += outcome.skipped;
      }
      setNotice([
        done > 0 ? t("mobile.diverged.resultDone", { count: done }) : "",
        failed > 0 ? t("mobile.diverged.resultFailed", { count: failed }) : "",
        skipped > 0 ? t("mobile.diverged.resultSkipped", { count: skipped }) : "",
      ].filter(Boolean).join(" "));
    } catch (cause) {
      // A refusal is an answer. Anything else left the transfer running or
      // finished, which this phone cannot tell.
      setError(cause instanceof ApiError && cause.status >= 400 && cause.status < 500 ? describeFailure(cause) : t("mobile.diverged.outcomeUnknown"));
    } finally {
      setWorking(false);
      onChanged();
      void load();
    }
  };

  /** One transfer's question, priced first: a preview that fails still asks. */
  const askTransfer = async (direction: SyncDirection, paths: string[], isNew: boolean) => {
    const single = paths.length === 1;
    const name = paths[0] ?? "";
    setWorking(true);
    let preview: SyncPreview | null = null;
    let why = "";
    try {
      preview = await previewDiverged(projectId, direction, ids(paths));
    } catch (cause) {
      why = describeFailure(cause);
    }
    setWorking(false);
    const body: TranslationKey = direction === "pull"
      ? (single ? "syncConfirm.pullFile" : "syncConfirm.pullSelected")
      : isNew
        ? (single ? "syncConfirm.pushFileNew" : "syncConfirm.pushSelectedNew")
        : (single ? "syncConfirm.pushFile" : "syncConfirm.pushSelected");
    setAsk({
      title: t(direction === "pull" ? "syncConfirm.pullTitle" : "syncConfirm.pushTitle"),
      lines: [
        t(body, { name, count: paths.length }),
        ...(isNew ? [] : [t("syncConfirm.forceNote")]),
        ...previewLines(t, direction, preview, why),
      ],
      lists: lossList(t, direction, preview),
      label: t(direction === "pull" ? "syncConfirm.confirmPull" : isNew ? "syncConfirm.confirmPushNew" : "syncConfirm.confirmPush"),
      steps: [{ op: direction, ids: ids(paths) }],
    });
  };

  /** Take the newer copies: one question over both directions, as the desktop asks it. */
  const askNewer = async () => {
    const directions = [["pull", newer.host], ["push", newer.local]] as const;
    setWorking(true);
    const priced = await Promise.all(directions.filter(([, paths]) => paths.length > 0).map(async ([direction, paths]) => {
      try {
        return { direction, paths, preview: await previewDiverged(projectId, direction, ids(paths)), why: "" };
      } catch (cause) {
        return { direction, paths, preview: null, why: describeFailure(cause) };
      }
    }));
    setWorking(false);
    setAsk({
      title: t("syncConfirm.newerTitle"),
      lines: [
        t("syncConfirm.newerBody", { count: newer.host.length + newer.local.length }),
        ...priced.flatMap(({ direction, paths, preview, why }) => [
          t(direction === "pull" ? "syncConfirm.newerPull" : "syncConfirm.newerPush", { count: paths.length }),
          ...previewLines(t, direction, preview, why),
        ]),
      ],
      lists: priced.flatMap(({ direction, preview }) => lossList(t, direction, preview)),
      label: t("syncConfirm.confirmNewer"),
      steps: priced.map(({ direction, paths }) => ({ op: direction, ids: ids(paths) })),
    });
  };

  /** Complete deletions: each named, since each removes the file's last copy. */
  const askDelete = (split: { host: string[]; local: string[] }) => {
    const sides = [["host", split.host], ["local", split.local]] as const;
    const present = sides.filter(([, paths]) => paths.length > 0);
    const only = present.length === 1 && present[0][1].length === 1 ? present[0] : null;
    setAsk({
      title: t(present[0]?.[0] === "host" ? "syncConfirm.deleteHostTitle" : "syncConfirm.deleteLocalTitle"),
      lines: only ? [t(only[0] === "host" ? "syncConfirm.deleteHostBody" : "syncConfirm.deleteLocalBody", { name: only[1][0] })] : [],
      lists: only ? [] : present.map(([side, paths]) => ({
        heading: t(side === "host" ? "syncConfirm.deleteHostSelectedBody" : "syncConfirm.deleteLocalSelectedBody", { count: paths.length }),
        names: paths,
      })),
      label: t("mobile.diverged.delete"),
      steps: present.map(([side, paths]) => ({ op: side === "host" ? "delete_host" as const : "delete_local" as const, ids: ids(paths) })),
    });
  };

  const toggleDiff = async (row: DivergedRow) => {
    if (openId === row.id) {
      setOpenId(null);
      return;
    }
    setOpenId(row.id);
    if (diffs[row.id] && !("error" in diffs[row.id])) return;
    setDiffs((held) => ({ ...held, [row.id]: { loading: true } }));
    try {
      const { diff, cut } = await getDivergedDiff(projectId, row.id);
      setDiffs((held) => ({ ...held, [row.id]: { diff, cut } }));
    } catch (cause) {
      setDiffs((held) => ({ ...held, [row.id]: { error: t("mobile.diverged.diffFailed", { error: describeFailure(cause) }) } }));
    }
  };

  return <>
    <div className="sheet-backdrop" role="presentation" onClick={onClose}><section className="option-sheet git-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.diverged.title", { label })} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.gitSheet.close")}>✕</button>
        <h2>{t("mobile.diverged.title", { label })} {isUntested("mobile.project.diverged") && <small>{t("mobile.newTab.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>

      {error && <p className="sheet-note error" role="alert">{error}</p>}
      {notice && <p className="sheet-note" role="status">{notice}</p>}
      {busy && !list && !error && <p className="sheet-note">{t("mobile.diverged.loading")}</p>}
      {list && !list.connected && <p className="sheet-note">{t("mobile.diverged.notConnected")}</p>}
      {list && !list.writes && rows.length > 0 && <p className="sheet-note">{t("mobile.diverged.readOnly")}</p>}
      {list && rows.length === 0 && list.hidden === 0 && <p className="sheet-note">{t("projectFilesView.noDivergedFiles")}</p>}

      {rows.length > 0 && <div className="git-body">
        {amber.length > 0 && <>
          <h3 className="git-section">{t("projectFilesView.divergedCount", { count: amber.length })}</h3>
          {list?.writes && <div className="diverged-bulk">
            <label className="diverged-exclude">
              <input type="checkbox" checked={excludeBoth} onChange={(event) => setExcludeBoth(event.target.checked)} />
              {t("projectFilesView.excludeBothChanged")}
            </label>
            <div className="diverged-actions">
              <button disabled={!canAct || bulk.length === 0} aria-label={t("projectFilesView.takeRemoteAllAria")} onClick={() => void askTransfer("pull", bulk, false)}><ArrowDownIcon /> {t("mobile.diverged.useHost")}</button>
              <button disabled={!canAct || bulk.length === 0} aria-label={t("projectFilesView.keepLocalAllAria")} onClick={() => void askTransfer("push", bulk, false)}><ArrowUpIcon /> {t("mobile.diverged.useLocal")}</button>
              <button disabled={!canAct || newer.host.length + newer.local.length === 0} aria-label={t("projectFilesView.takeNewerAllAria")} onClick={() => void askNewer()}><ArrowsHorizontalIcon /> {t("mobile.diverged.useNewer")}</button>
              <button className="danger" disabled={!canAct || deletable.host.length + deletable.local.length === 0} aria-label={t("projectFilesView.deleteAllAria")} onClick={() => askDelete(deletable)}><TrashIcon /> {t("mobile.diverged.delete")}</button>
            </div>
          </div>}
          <ul className="git-rows">
            {amber.map((row) => {
              const status = byPath[row.path];
              const cue = mtimeDivergenceCue(t, status.hostMtime, status.localMtime, status.hostDiverged, status.localDiverged, status.hostChecked);
              const noHost = status.hostMtime == null;
              const noLocal = status.localMtime == null;
              const goneBoth = noHost && noLocal;
              const deleteSide = deleteSideOf(status);
              return <li key={row.id} className="diverged-row">
                <button className="diverged-name" disabled={goneBoth} aria-expanded={openId === row.id} aria-label={t("mobile.diverged.compare", { path: row.path })} onClick={() => void toggleDiff(row)}>
                  <span aria-hidden="true">± </span>{row.path}
                </button>
                <small className={`diverged-cue ${cue.tone}`}>{cue.text}</small>
                {openId === row.id && <>
                  <small className="diverged-when">{cue.title}</small>
                  <DiffBody state={diffs[row.id]} />
                </>}
                {list?.writes && (goneBoth
                  ? <div className="diverged-actions">
                    <button disabled={!canAct} onClick={() => void run([{ op: "forget", ids: [row.id] }])}>{t("projectFilesView.forgetFile")}</button>
                  </div>
                  : <div className="diverged-actions">
                    <button disabled={!canAct || noHost} aria-label={t("projectFilesView.takeRemoteAria")} onClick={() => void askTransfer("pull", [row.path], false)}><ArrowDownIcon /> {t("mobile.diverged.useHost")}</button>
                    <button disabled={!canAct || noLocal} aria-label={t("projectFilesView.keepLocalAria")} onClick={() => void askTransfer("push", [row.path], false)}><ArrowUpIcon /> {t("mobile.diverged.useLocal")}</button>
                    {deleteSide && <button className="danger" disabled={!canAct} aria-label={t(deleteSide === "host" ? "projectFilesView.deleteHostAria" : "projectFilesView.deleteLocalAria")} onClick={() => askDelete(deleteSide === "host" ? { host: [row.path], local: [] } : { host: [], local: [row.path] })}><TrashIcon /> {t("mobile.diverged.delete")}</button>}
                  </div>)}
              </li>;
            })}
          </ul>
        </>}

        {fresh.length > 0 && <>
          <h3 className="git-section">{t("projectFilesView.newLocalCount", { count: fresh.length })}</h3>
          {list?.writes && <div className="diverged-actions">
            <button disabled={!canAct} aria-label={t("projectFilesView.uploadNewAllAria")} onClick={() => void askTransfer("push", fresh.map((row) => row.path), true)}><ArrowUpIcon /> {t("mobile.diverged.uploadAll")}</button>
          </div>}
          <ul className="git-rows">
            {fresh.map((row) => <li key={row.id} className="diverged-row">
              <span className="diverged-name"><span aria-hidden="true">+ </span>{row.path}</span>
              {list?.writes && <div className="diverged-actions">
                <button disabled={!canAct} aria-label={t("projectFilesView.uploadNewAria")} onClick={() => void askTransfer("push", [row.path], true)}><ArrowUpIcon /> {t("mobile.diverged.upload")}</button>
              </div>}
            </li>)}
          </ul>
        </>}
      </div>}

      {!!list && list.total > rows.length && <p className="sheet-note">{t("mobile.diverged.moreOnDesktop", { count: list.total - rows.length })}</p>}
      {!!list && list.hidden > 0 && <p className="sheet-note">{t("mobile.diverged.hidden", { count: list.hidden })}</p>}

      <div className="mobile-schedule-actions">
        <button disabled={busy || working} onClick={() => void load()}>↻ {t("mobile.gitSheet.refresh")}</button>
        <button className="primary" onClick={onClose}>{t("mobile.gitSheet.done")}</button>
      </div>
    </section></div>

    {ask && <OptionSheet
        title={ask.title}
        options={[{ key: "confirm", label: ask.label, current: false }]}
        waiting=""
        busy={working}
        onPick={() => { const { steps } = ask; setAsk(null); void run(steps); }}
        onClose={() => setAsk(null)}
      >
        <div className="diverged-ask">
          {ask.lines.map((line, index) => <p className="sheet-note" key={index}>{line}</p>)}
          {ask.lists.map((names, index) => <div key={index}>
            <p className="sheet-note error">{names.heading}</p>
            <ul>{names.names.map((name) => <li key={name}>{name}</li>)}</ul>
            {!!names.more && names.more > 0 && <p className="sheet-note">{t("syncConfirm.andMore", { count: names.more })}</p>}
          </div>)}
        </div>
    </OptionSheet>}
  </>;
}

/** The two copies of one file, as the chat's Diffs view draws a change. */
function DiffBody({ state }: { state: DiffState | undefined }) {
  const t = useT();
  const lines = useMemo(() => {
    if (!state || !("diff" in state) || !state.diff) return [];
    return parseUnifiedDiff(state.diff.replace(/\n$/u, "")).flatMap((file) => file.hunks).flatMap((hunk) => hunk.lines);
  }, [state]);
  if (!state || "loading" in state && state.loading) return <small className="diverged-when">{t("mobile.diverged.comparing")}</small>;
  if ("error" in state) return <p className="sheet-note error" role="alert">{state.error}</p>;
  if (!("diff" in state)) return null;
  if (lines.length === 0) return <small className="diverged-when">{t(state.diff ? "mobile.diverged.binary" : "mobile.diverged.noDifference")}</small>;
  return <div className="chat-change-diff">
    {lines.map((line, index) => line.type === "hunk" || line.type === "meta" || line.type === "nonewline"
      ? <div className="chat-diff-line note" key={index}><code>{line.text}</code></div>
      : <div className={`chat-diff-line ${line.type}`} key={index}>
        <span aria-hidden="true">{line.type === "add" ? line.newNo : line.oldNo}</span>
        <code>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}{line.text}</code>
      </div>)}
    {state.cut && <small className="chat-change-note">{t("mobile.diverged.diffCut")}</small>}
  </div>;
}
