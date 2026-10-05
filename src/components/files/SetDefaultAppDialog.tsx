import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../../lib/i18n";
import { patchDefaultApps } from "../../lib/defaultApps";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";

interface InstalledApp {
  name: string;
  exec: string;
  icon: string | null;
}

type Scope = "project" | "global";

interface Props {
  /** File extension including the leading dot, e.g. ".blend". */
  ext: string;
  /** File name, for the dialog heading. */
  fileName: string;
  /** The project whose map the project scope edits; null disables that scope. */
  projectId: string | null;
  onClose: () => void;
}

/**
 * Whether an installed-app row corresponds to the current exec: true when the
 * exec is exactly the app's command, or that command followed by extra args — a
 * multi-word invocation such as a sharun AppImage's binary selector
 * (`/opt/…AppImage kicad <file>`) or a Flatpak launcher line. Keeps such a
 * working exec highlighted, and lets a re-select preserve its trailing args
 * instead of stripping them back to the bare `.desktop` value.
 */
export function execMatchesApp(exec: string, appExec: string): boolean {
  const e = exec.trim().split(/\s+/).filter(Boolean);
  const a = appExec.trim().split(/\s+/).filter(Boolean);
  if (a.length === 0 || a.length > e.length) return false;
  return a.every((token, i) => token === e[i]);
}

/**
 * Assign the default app for a file extension, scoped to this project or set
 * globally. A project-scoped mapping overrides the global one for that project
 * (matching the backend's resolution precedence). The search box lists installed
 * applications (parsed from .desktop entries); a manual exec field and a native
 * file picker cover apps not on the list.
 */
export function SetDefaultAppDialog({ ext, fileName, projectId, onClose }: Props) {
  const t = useT();
  const [scope, setScope] = useState<Scope>(projectId ? "project" : "global");
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [iconDataUrls, setIconDataUrls] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState("");
  const [exec, setExec] = useState("");
  const [globalApps, setGlobalApps] = useState<Record<string, string>>({});
  const [projectApps, setProjectApps] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Once the user picks a scope radio themselves, stop auto-selecting it.
  const userPickedScope = useRef(false);

  useEffect(() => {
    invoke<InstalledApp[]>("list_installed_apps")
      .then(setApps)
      .catch((e) => setError(String(e)));
    invoke<Record<string, string>>("get_default_apps")
      .then(setGlobalApps)
      .catch(() => setGlobalApps({}));
    // The project map comes from the trusted registry, never the in-folder
    // project.json (writable by agents, containers, git pulls).
    if (projectId) {
      invoke<Record<string, string>>("get_project_default_apps", { projectId })
        .then(setProjectApps)
        .catch(() => setProjectApps({}));
    }
  }, [projectId]);

  // Open in whichever scope already maps this extension, so reopening the dialog
  // surfaces the saved value instead of an empty project-scope field (a mapping
  // saved Global would otherwise be invisible while the default scope is
  // "project"). Project wins over global, matching the resolution precedence.
  // Deferred to the maps loading, and disabled once the user picks a scope.
  useEffect(() => {
    if (userPickedScope.current) return;
    if (projectId && projectApps[ext]) setScope("project");
    else if (globalApps[ext]) setScope("global");
  }, [ext, projectId, projectApps, globalApps]);

  // Seed the exec field with whatever the chosen scope currently maps this
  // extension to, so the dialog opens showing the present value.
  useEffect(() => {
    const current = scope === "project" ? projectApps[ext] : globalApps[ext];
    setExec(current ?? "");
  }, [scope, ext, projectApps, globalApps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.exec.toLowerCase().includes(q),
    );
  }, [apps, query]);

  // Resolve icons lazily for the apps currently shown. The backend caches per
  // exec, so re-filtering as the user types only resolves newly-revealed apps.
  // Works on both platforms: on Windows `list_installed_apps` returns icon=null
  // and the resolver extracts the shell icon; on Linux it resolves the theme name.
  useEffect(() => {
    let cancelled = false;
    const execs = filtered
      .map((a) => a.exec)
      .filter((exec) => exec && !(exec in iconDataUrls));
    if (execs.length === 0) return;
    Promise.all(
      [...new Set(execs)].map(async (exec) => {
        try {
          return [exec, await invoke<string | null>("resolve_app_icon", { exec })] as const;
        } catch {
          return [exec, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setIconDataUrls((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [filtered, iconDataUrls]);

  const otherScopeValue = scope === "project" ? globalApps[ext] : undefined;

  const chooseExecutable = async () => {
    const picked = await open({ directory: false, multiple: false });
    if (typeof picked === "string") setExec(picked);
  };

  // Select an installed app. Preserve a working multi-word exec when the user
  // re-selects the same app it already resolves to — clicking KiCad must not
  // strip the `kicad` binary selector its sharun AppImage needs to open a file.
  const pickApp = (appExec: string) => {
    setExec((prev) => (execMatchesApp(prev, appExec) ? prev : appExec));
  };

  const save = async (nextExec: string | null) => {
    setBusy(true);
    setError(null);
    try {
      if (scope === "global") {
        // One entry, not the whole map: another window or the phone saving
        // meanwhile keeps its entries (headless owner plan, H1b).
        const next = { ...globalApps };
        if (nextExec) next[ext] = nextExec;
        else delete next[ext];
        await patchDefaultApps(nextExec ? { set: { [ext]: nextExec } } : { remove: [ext] }, () => next);
      } else {
        if (!projectId) throw new Error(t("setDefaultApp.errNoProjectFile"));
        const map = { ...projectApps };
        if (nextExec) map[ext] = nextExec;
        else delete map[ext];
        await invoke("set_project_default_apps", { projectId, defaultApps: map });
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-dialog set-default-app-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-title-row">
          <h2>{t("setDefaultApp.title", { ext })} <UntestedTag id="setDefaultApp.patch" /></h2>
          <button type="button" className="dialog-close-btn" onClick={onClose}>×</button>
        </div>
        <p className="settings-help">
          {t("setDefaultApp.bodyPre")} <strong>{fileName}</strong> {t("setDefaultApp.bodyMid")}{" "}
          <code>{ext}</code> {t("setDefaultApp.bodyPost")}
        </p>

        <div className="set-default-app-scope">
          <label
            className={projectId ? "" : "disabled"}
            title={projectId ? "" : t("common.noProjectSelected")}
          >
            <input
              type="radio"
              name="default-app-scope"
              checked={scope === "project"}
              disabled={!projectId}
              onChange={() => {
                userPickedScope.current = true;
                setScope("project");
              }}
            />
            {t("setDefaultApp.thisProjectOnly")}
          </label>
          <label>
            <input
              type="radio"
              name="default-app-scope"
              checked={scope === "global"}
              onChange={() => {
                userPickedScope.current = true;
                setScope("global");
              }}
            />
            {t("setDefaultApp.globalAllProjects")}
          </label>
        </div>
        {scope === "project" && otherScopeValue && (
          <p className="settings-help">
            {t("setDefaultApp.overridesPre")}
            <code>{otherScopeValue}</code>
            {t("setDefaultApp.overridesPost")}
          </p>
        )}

        <input
          className="set-default-app-search"
          placeholder={t("setDefaultApp.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="set-default-app-list">
          {filtered.length === 0 ? (
            <div className="settings-empty">{t("setDefaultApp.noMatchingApps")}</div>
          ) : (
            filtered.map((a) => (
              <button
                type="button"
                key={`${a.exec}:${a.name}`}
                className={`set-default-app-row${execMatchesApp(exec, a.exec) ? " selected" : ""}`}
                onClick={() => pickApp(a.exec)}
                title={a.exec}
              >
                {iconDataUrls[a.exec] ? (
                  <img className="set-default-app-icon" src={iconDataUrls[a.exec]!} alt="" />
                ) : (
                  <span className="set-default-app-icon set-default-app-icon-placeholder" />
                )}
                <span className="set-default-app-text">
                  <span className="set-default-app-name">{a.name}</span>
                  <span className="set-default-app-exec">{a.exec}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="set-default-app-manual">
          <input
            value={exec}
            placeholder={t("setDefaultApp.execPlaceholder")}
            onChange={(e) => setExec(e.target.value)}
          />
          <button type="button" onClick={() => void chooseExecutable()} title={t("setDefaultApp.browseTitle")}>
            …
          </button>
        </div>

        {error && <ErrorNote className="settings-error" error={error} />}

        <div className="set-default-app-actions">
          <button type="button" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button
            type="button"
            className="danger"
            disabled={busy || !(scope === "project" ? projectApps[ext] : globalApps[ext])}
            onClick={() => void save(null)}
            title={t("setDefaultApp.removeMappingTitle")}
          >
            {t("setDefaultApp.clear")}
          </button>
          <button
            type="button"
            disabled={busy || !exec.trim()}
            onClick={() => void save(exec.trim())}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
