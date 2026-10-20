import { useEffect, useState } from "react";
import { resolveProjectDirectory, type ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { listInterpreters, type PyInterpreter } from "../../lib/terminal/pythonRun";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The interpreter row of the right-click-Run popovers (code viewer and file
 * tree): pick the venv/conda env/system Python a Run uses without opening the
 * project's Python interpreter window.
 *
 * It edits the same project pin as `PythonInterpreterWindow`
 * (`set_project_python`), not a per-file override: the backend owns interpreter
 * precedence, and a second place a choice could live would be a second ranking.
 * The list is the same live probe, so on a remote project it is the host's.
 * A pinned path the probe didn't find (hand-typed, or gone) stays selectable
 * as itself rather than silently reading as auto-detect.
 */
export function PythonInterpreterSelect({
  project,
  labelClassName,
  selectClassName,
}: {
  project: ProjectEntry;
  /** The host popover's own label/field classes, so the row matches its siblings. */
  labelClassName: string;
  selectClassName: string;
}) {
  const t = useT();
  const setProjectPython = useProjectsStore((s) => s.setProjectPython);
  const dir = resolveProjectDirectory(project);
  const pinned = project.python_interpreter ?? "";
  const [found, setFound] = useState<PyInterpreter[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    listInterpreters(dir)
      .then((list) => {
        if (!cancelled) setFound(list);
      })
      .catch(() => {
        if (!cancelled) setFound([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // Named conda envs are offered but never auto-picked (see the window).
  const autoPick = found?.find((i) => i.kind !== "conda");
  const pinnedUnlisted = !!pinned && !!found && !found.some((i) => i.path === pinned);

  const pick = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await setProjectPython(project.id, value || null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className={labelClassName}>
        {t("pythonInterp.runWithLabel")}
        <UntestedTag id="pythonInterp.runWithLabel" />
      </label>
      <select
        className={selectClassName}
        value={pinned}
        disabled={busy || found === null}
        onChange={(e) => void pick(e.target.value)}
        aria-label={t("pythonInterp.runWithLabel")}
      >
        <option value="">
          {found === null
            ? t("pythonInterp.looking")
            : autoPick
              ? t("pythonInterp.autoDetectWith", { path: autoPick.path })
              : t("pythonInterp.autoDetect")}
        </option>
        {found?.map((i) => (
          <option key={i.path} value={i.path}>
            {i.label} — {i.path}
          </option>
        ))}
        {pinnedUnlisted && <option value={pinned}>{pinned}</option>}
      </select>
      {error && <span className={labelClassName}>{error}</span>}
    </>
  );
}
