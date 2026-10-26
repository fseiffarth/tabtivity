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

const EMPTY_REMARKS: ProjectRemark[] = [];

export function RemarksPane({ projectId, projectDir, visible }: {
  projectId: string; projectDir: string; visible: boolean;
}) {
  const t = useT();
  // Edit/delete ask in the panel's own dialog, like every other side-panel
  // gesture — not in WebKitGTK's origin-titled native boxes.
  const { promptText, confirmAction, dialogs } = useDialogs();
  const entry = useProjectRemarksStore((s) => s.byProject[projectId]);
  const [cursor, setCursor] = useState(0);
  const remarks = entry?.remarks ?? EMPTY_REMARKS;
  const groups = useMemo(() => {
    const out = new Map<string, ProjectRemark[]>();
    for (const remark of remarks) (out.get(remark.file) ?? out.set(remark.file, []).get(remark.file)!).push(remark);
    return [...out.entries()];
  }, [remarks]);

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
    <div className="project-remarks-walk">
      <button title={t("projectRemarks.previous")} onClick={() => walk(-1)}>‹</button>
      <span>{remarks.length ? `${cursor + 1}/${remarks.length}` : "0/0"}</span>
      <button title={t("projectRemarks.next")} onClick={() => walk(1)}>›</button>
      <UntestedTag id="remarksPane.1" />
    </div>
    {entry?.loading ? <p>{t("common.loading")}</p> : entry?.error ? <p className="error-text">{entry.error}</p> : remarks.length === 0 ? (
      <div className="empty-state"><p>{t("projectRemarks.empty")}</p><button onClick={() => jumpToSource(resolvePath(projectDir, REMARKS_FILE), 1)}>{t("projectRemarks.openFile")}</button></div>
    ) : groups.map(([file, rows]) => <section key={file} className="project-remarks-group">
      <h3>{file}</h3>
      {rows.map((remark) => {
        const missing = remark.invalidPath || entry?.fileMissing[file];
        return <div key={`${remark.srcStart}-${remark.text}`} className={`project-remark-row${missing ? " missing" : ""}`}>
          <input type="checkbox" checked={remark.done} onChange={(e) => void useProjectRemarksStore.getState().setDone(projectId, projectDir, remark, e.target.checked)} />
          <button className="project-remark-target" disabled={missing} onClick={() => jump(remark)}>{file}{remark.line != null ? `:${remark.line}` : ""}</button>
          <span className="project-remark-text">{remark.text}</span>
          {missing && <small>{t("projectRemarks.fileMissing")}</small>}
          <button title={t("projectRemarks.edit")} onClick={() => void promptText({
            title: t("projectRemarks.edit"),
            body: <><strong>{file}</strong>{remark.line != null ? `:${remark.line}` : ""}</>,
            label: t("projectRemarks.edit"),
            initial: remark.text,
            confirmLabel: t("common.save"),
          }, (next) => useProjectRemarksStore.getState().edit(projectId, projectDir, remark, next))}>✎</button>
          <button title={t("projectRemarks.delete")} onClick={() => void (async () => {
            const ok = await confirmAction({
              title: t("projectRemarks.delete"),
              body: t("projectRemarks.confirmDelete"),
              confirmLabel: t("common.delete"),
              danger: true,
            });
            if (ok) await useProjectRemarksStore.getState().remove(projectId, projectDir, remark);
          })()}>×</button>
          <button onClick={() => void makeCard(remark)}>{t("projectRemarks.makeCard")}</button>
        </div>;
      })}
    </section>)}
  </div>;
}
