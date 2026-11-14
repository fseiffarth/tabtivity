import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { projectDocsStatus } from "../../lib/projects/projectDocs";
import { useProjectsStore } from "../../stores/projects";

/**
 * What the header's amber "no scaffold" tag opens: the default files the project
 * folder lacks, and Repair (the same `repair_project_scaffold` the project pill's
 * menu runs — it only ever adds, never overwrites).
 *
 * The names come from `project_docs_status`. The tag also fires when only the
 * `.gitignore` is missing (a git project), which the status does not list, so a
 * status with every default present means exactly that. No status (unreachable)
 * falls back to a sentence that names no file.
 */
export function ScaffoldTagPopover({
  projectId, x, y, onClose, onRepaired,
}: {
  projectId: string;
  x: number;
  y: number;
  onClose: () => void;
  /** After a repair ran (whatever it added), so the caller can re-ask whether anything is still missing. */
  onRepaired: () => void;
}) {
  const t = useT();
  const repairProjectScaffold = useProjectsStore((s) => s.repairProjectScaffold);
  const [names, setNames] = useState<string[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    projectDocsStatus(projectId)
      .then((status) => {
        if (cancelled) return;
        if (!status) { setNames(null); return; }
        const missing = status.filter((s) => s.isDefault && s.state === "missing").map((s) => s.name);
        setNames(missing.length > 0 ? missing : [".gitignore"]);
      })
      .catch(() => { if (!cancelled) setNames(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function repair() {
    if (busy) return;
    setBusy(true);
    try {
      await repairProjectScaffold(projectId);
    } catch {
      // The store reports through its toast; a failed repair leaves the tag.
    } finally {
      setBusy(false);
      onRepaired();
      onClose();
    }
  }

  return (
    <ContextMenuPortal x={x} y={y} keepBelow onClose={onClose}>
      <div className="context-menu-group" data-testid="scaffold-tag-popover">
        <div className="context-menu-group-label">{t("projectType.scaffoldPopoverTitle")}</div>
        <div className="context-menu-note">
          {names === undefined
            ? t("projectType.scaffoldPopoverLoading")
            : names === null
              ? t("projectType.scaffoldPopoverUnknown")
              : t("projectType.scaffoldPopoverMissing", { names: names.join(", ") })}
        </div>
        <button type="button" className="untested" disabled={busy} onClick={() => void repair()}>
          {t(busy ? "projectType.scaffoldRepairing" : "projectType.scaffoldRepair")}
          <UntestedTag id="projectType.scaffoldPopover" />
        </button>
      </div>
    </ContextMenuPortal>
  );
}
