import { useEffect, useMemo, useState } from "react";
import { fileMtime } from "../../lib/files/fileAccess";
import { jumpToSource } from "../embed/fileViewer/sourceJump";
import { resolvePath } from "../../lib/paths";
import { REMARKS_FILE, resolveRemarkAbsPath, type ProjectRemark } from "../../lib/projects/projectRemarks";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { boardColumns, fallbackColumnId, taskFromRemark } from "../../lib/todoBoard";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { useDialogs } from "../common/PromptDialogs";
import { ArrowRightIcon, CheckboxIcon, ChevronLeftIcon, ChevronRightIcon, FileTextIcon, PencilIcon, PlusIcon, TrashIcon } from "../common/icons/Icon";
import { AddRemarkDialog } from "./AddRemarkDialog";

const EMPTY_REMARKS: ProjectRemark[] = [];

/**
 * The side panel's Remarks view: the project's `REMARKS.md`, one section per
 * file. The toolbar walks every remark in order (each step jumps to it) and
 * opens the file itself; a file's head adds a remark to that file
 * (`AddRemarkDialog`, the dialog the tree's context menu opens). A row is the
 * kit's: done box, go-to, the remark over its line, then edit, card, delete.
 */
export function RemarksPane({ projectId, projectDir, visible }: {
  projectId: string; projectDir: string; visible: boolean;
}) {
  const t = useT();
  // Edit/delete ask in the panel's own dialog, like every other side-panel
  // gesture — not in WebKitGTK's origin-titled native boxes.
  const { promptText, confirmAction, dialogs } = useDialogs();
  const entry = useProjectRemarksStore((s) => s.byProject[projectId]);
  const [cursor, setCursor] = useState(0);
  /** The file whose head "+" is open in `AddRemarkDialog`. */
  const [adding, setAdding] = useState<string | null>(null);
  const remarks = entry?.remarks ?? EMPTY_REMARKS;
  const groups = useMemo(() => {
    const out = new Map<string, ProjectRemark[]>();
    for (const remark of remarks) (out.get(remark.file) ?? out.set(remark.file, []).get(remark.file)!).push(remark);
    return [...out.entries()];
  }, [remarks]);
  const done = remarks.filter((remark) => remark.done).length;

  useEffect(() => { if (visible) void useProjectRemarksStore.getState().refreshIfStale(projectId, projectDir); }, [visible, projectId, projectDir]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void Promise.all([...new Set(remarks.filter((r) => !r.invalidPath).map((r) => r.file))].map(async (file) => {
      const abs = resolveRemarkAbsPath(projectDir, file);
      if (!abs) return [file, true] as const;
      try { await fileMtime(abs, projectId); return [file, false] as const; }
      catch { return [file, true] as const; }
    })).then((pairs) => { if (!cancelled) useProjectRemarksStore.getState().setFileMissing(projectId, Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [visible, projectId, projectDir, entry?.mtime, remarks]);

  const jump = (remark: ProjectRemark) => {
    const abs = resolveRemarkAbsPath(projectDir, remark.file);
    if (abs && !entry?.fileMissing[remark.file]) jumpToSource(abs, remark.line ?? 1);
  };
  const makeCard = async (remark: ProjectRemark) => {
    const calendar = useCalendarStore.getState();
    if (!calendar.calendars.length) await calendar.load();
    const current = useCalendarStore.getState();
    const columns = boardColumns(current.taskColumns);
    await current.createTask(taskFromRemark(remark, projectId, {
      calendarId: current.calendars[0]?.id ?? "default", columnId: fallbackColumnId(columns), now: new Date(),
    }));
  };
  const walk = (delta: number) => {
    if (!remarks.length) return;
    const next = (cursor + delta + remarks.length) % remarks.length;
    setCursor(next); jump(remarks[next]);
  };

  return <div className="project-remarks-pane">
    {dialogs}
    <div className="sp-toolbar project-remarks-walk">
      <button type="button" className="toolbar-btn toolbar-btn--sm" title={t("projectRemarks.previous")} aria-label={t("projectRemarks.previous")} onClick={() => walk(-1)}><ChevronLeftIcon /></button>
      <span className="project-remarks-position" aria-live="polite">{remarks.length ? `${cursor + 1}/${remarks.length}` : "0/0"}</span>
      <button type="button" className="toolbar-btn toolbar-btn--sm" title={t("projectRemarks.next")} aria-label={t("projectRemarks.next")} onClick={() => walk(1)}><ChevronRightIcon /></button>
      {remarks.length > 0 && <span className="sp-toolbar-meta" data-testid="remarks-counts">{t("projectRemarks.counts", { open: remarks.length - done, done })}</span>}
      <UntestedTag id="remarksPane.1" />
      <div className="sp-toolbar-end">
        <button type="button" className="toolbar-btn toolbar-btn--sm" title={t("projectRemarks.openFile")} aria-label={t("projectRemarks.openFile")} onClick={() => jumpToSource(resolvePath(projectDir, REMARKS_FILE), 1)}><FileTextIcon /></button>
      </div>
    </div>
    <div className="side-panel-scroll project-remarks-list">
      {entry?.loading ? <p className="sp-note">{t("common.loading")}</p> : entry?.error ? <p className="sp-note error-text">{entry.error}</p> : remarks.length === 0 ? (
        <p className="sp-note">{t("projectRemarks.empty")}</p>
      ) : groups.map(([file, rows]) => <section key={file} className="project-remarks-group" aria-label={file}>
        <div className="sp-head project-remarks-head">
          <span className="project-remarks-file" title={file}>{file}</span>
          <span className="sp-head-meta">{rows.length}</span>
          <span className="sp-head-end">
            <button type="button" className="toolbar-btn toolbar-btn--sm" title={t("projectRemarks.addMenu")} aria-label={t("projectRemarks.addTo", { file })} onClick={() => setAdding(file)}><PlusIcon /></button>
          </span>
        </div>
        {rows.map((remark) => {
          const missing = remark.invalidPath || !!entry?.fileMissing[file];
          const target = `${file}${remark.line != null ? `:${remark.line}` : ""}`;
          const sub = [
            remark.line != null ? t("projectRemarks.line", { line: remark.line }) : null,
            missing ? t("projectRemarks.fileMissing") : null,
          ].filter(Boolean).join(" · ");
          return <div key={`${remark.srcStart}-${remark.text}`} className={`sp-row sp-row--two project-remark-row${missing ? " missing" : ""}${remark.done ? " done" : ""}`} data-testid="project-remark-row">
            <span className="sp-row-state">
              <input type="checkbox" checked={remark.done} aria-label={t("projectRemarks.doneLabel", { text: remark.text })} onChange={(e) => void useProjectRemarksStore.getState().setDone(projectId, projectDir, remark, e.target.checked)} />
            </span>
            <span className="sp-row-act">
              <button type="button" className="btn-quiet project-remark-go" disabled={missing} title={t("projectRemarks.goTo", { target })} aria-label={t("projectRemarks.goTo", { target })} onClick={() => jump(remark)}><ArrowRightIcon /></button>
            </span>
            <span className="sp-row-text">
              <span className="project-remark-text">{remark.text}</span>
              {sub && <span className="sp-row-sub project-remark-sub">{sub}</span>}
            </span>
            <span className="sp-row-meta project-remark-actions">
              <button type="button" className="btn-quiet" title={t("projectRemarks.edit")} aria-label={t("projectRemarks.edit")} onClick={() => void promptText({
                title: t("projectRemarks.edit"),
                body: <><strong>{file}</strong>{remark.line != null ? `:${remark.line}` : ""}</>,
                label: t("projectRemarks.edit"),
                initial: remark.text,
                confirmLabel: t("common.save"),
              }, (next) => useProjectRemarksStore.getState().edit(projectId, projectDir, remark, next))}><PencilIcon /></button>
              <button type="button" className="btn-quiet" title={t("projectRemarks.makeCard")} aria-label={t("projectRemarks.makeCard")} onClick={() => void makeCard(remark)}><CheckboxIcon /></button>
              <button type="button" className="btn-quiet is-danger" title={t("projectRemarks.delete")} aria-label={t("projectRemarks.delete")} onClick={() => void (async () => {
                const ok = await confirmAction({
                  title: t("projectRemarks.delete"),
                  body: t("projectRemarks.confirmDelete"),
                  confirmLabel: t("common.delete"),
                  danger: true,
                });
                if (ok) await useProjectRemarksStore.getState().remove(projectId, projectDir, remark);
              })()}><TrashIcon /></button>
            </span>
          </div>;
        })}
      </section>)}
    </div>
    {adding !== null && <AddRemarkDialog projectId={projectId} projectDir={projectDir} file={adding} onClose={() => setAdding(null)} />}
  </div>;
}
