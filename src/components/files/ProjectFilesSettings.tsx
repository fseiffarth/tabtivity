import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Toggle } from "../common/Toggle";
import { Dropdown } from "../common/Dropdown";
import {
  SettingRow,
  SettingsCard,
  SettingsHeader,
  SettingsList,
  SettingsSection,
  ToggleRow,
} from "../layout/settingsUi";
import { useSettingsStore } from "../../stores/settings";
import { VIEWER_PREF_TYPES } from "../../lib/viewers/fileUtils";
import { PythonInterpreterWindow } from "../projects/PythonInterpreterWindow";
import { ProjectMigrationDialog } from "../projects/ProjectMigrationDialog";
import { SpellDictionaryPicker } from "./SpellDictionaryPicker";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { DEFAULT_LOOKAHEAD_DAYS } from "../../lib/alerts";
import type { ProjectEntry, Settings, ViewerPref } from "../../types";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The file-view filters (which endings/paths a project's tree hides) and the
 * Project Settings dialog that edits them. Shared by the side panel and the
 * "Files (Project)" tab so the two views hide the same files: the lists live on
 * the project's trusted `projects.json` entry (`get_/set_project_panel_prefs`),
 * not in either host's state — and not in the in-folder `project.json`, which
 * anything working in the tree can rewrite to hide files from you.
 */

type ProjectJson = Record<string, unknown>;

const PANEL_HIDDEN_ENDINGS_KEY = "panel_hidden_endings";
const PANEL_HIDDEN_PATHS_KEY = "panel_hidden_paths";
const PANEL_SHOWN_PATHS_KEY = "panel_shown_paths";
/** Tree grouping: does the root's scaffold get its own collapsible section, and
 *  does everything git ignores get one? Both default to ON — that is what the
 *  tree's own state used to seed, so an existing project's view is unchanged
 *  until the switch is thrown. */
const PANEL_SEPARATE_SCAFFOLD_KEY = "panel_separate_scaffold";
const PANEL_SEPARATE_GITIGNORED_KEY = "panel_separate_gitignored";
/** Folders excluded from every recursive scan. Read by the backend too — keep the
 *  spelling in step with `commands::fs::excluded_rel_set`. */
const SCAN_EXCLUDED_PATHS_KEY = "scan_excluded_paths";

/** The one spelling of a scan-exclusion path: project-relative, forward slashes,
 *  no leading/trailing separator. Mirrors the backend's `excluded_rel_set`, so a
 *  path written here matches the one the walk builds as it descends. */
export function normalizeScanPath(rel: string): string {
  return rel.replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

/** File endings that mark a project as holding Python — gates the interpreter
 *  picker, mirroring the pill's `PYTHON_ENDINGS`. */
const PYTHON_ENDINGS = new Set([".py", ".pyw", ".pyi"]);

/** Bounds on the Alerts group's lookahead, mirroring `useAlertsFeed`'s clamp.
 *  Below 1 day the group can only ever be empty; above 60 it has stopped being
 *  an alert strip and become an agenda. */
const ALERT_DAYS_MIN = 1;
const ALERT_DAYS_MAX = 60;

/** A stored boolean, where anything but an explicit `false` is the default —
 *  an absent key (every project predating the setting) means "on". */
function readBool(project: ProjectJson | null, key: string): boolean {
  return project?.[key] !== false;
}

function readStringList(project: ProjectJson | null, key: string): string[] {
  const raw = project?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function mergeEndings(...groups: string[][]): string[] {
  const endings = new Map<string, string>();
  for (const group of groups) {
    for (const ending of group) {
      const trimmed = ending.trim();
      if (!trimmed) continue;
      endings.set(trimmed.toLowerCase(), trimmed);
    }
  }
  return [...endings.values()].sort((a, b) => a.localeCompare(b));
}

export interface ProjectFileFilters {
  hiddenEndings: string[];
  hiddenPaths: string[];
  shownPaths: string[];
  availableEndings: string[];
  /** Folders the user excluded from recursive scans (see `toggleScanExcluded`). */
  scanExcluded: string[];
  /**
   * Whether the tree gives the project root's scaffold files, and everything
   * git ignores, their own collapsible sections. Per project rather than per
   * surface: the file view is mounted many times at once (the side panel, each
   * Files (Project) tab, each docked subwindow column), so the toggle these
   * replace showed one project with different sections depending on which copy
   * was last clicked — and reset itself on every remount.
   */
  separateScaffold: boolean;
  separateGitignored: boolean;
  setSeparateScaffold: (value: boolean) => void;
  setSeparateGitignored: (value: boolean) => void;
  error: string | null;
  toggleHiddenEnding: (ending: string, checked: boolean) => void;
  /**
   * Exclude/include a folder from every recursive scan: the size walk
   * (`dir_size`/`dir_size_breakdown`) and the file-churn watcher
   * (`services::usage_stats`), which both read this same list.
   *
   * Deliberately NOT the same list as `hiddenPaths`. "I don't want to look at
   * this" and "never traverse this" are different intents — a folder can be
   * hidden but still worth weighing, and one that is excluded stays visible so
   * the exclusion is discoverable and reversible from the row it applies to.
   */
  toggleScanExcluded: (relPath: string, excluded: boolean) => void;
}

/**
 * Load a project's tree-hiding lists from its `project.json`, and save endings
 * back to it. `remoteBlocked` suppresses the ending SCAN only: it walks the
 * project dir over SFTP for a remote project and would freeze the main thread
 * while the pool is down — `load_project` reads the local file and is always safe.
 */
export function useProjectFileFilters(opts: {
  localFile?: string;
  projectDir: string;
  remoteBlocked: boolean;
}): ProjectFileFilters {
  const { localFile, projectDir, remoteBlocked } = opts;
  const [prefs, setPrefs] = useState<ProjectJson | null>(null);
  const [hiddenEndings, setHiddenEndings] = useState<string[]>([]);
  const [availableEndings, setAvailableEndings] = useState<string[]>([]);
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [shownPaths, setShownPaths] = useState<string[]>([]);
  const [scanExcluded, setScanExcluded] = useState<string[]>([]);
  const [separateScaffold, setSeparateScaffoldState] = useState(true);
  const [separateGitignored, setSeparateGitignoredState] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!localFile || !projectDir) {
      setPrefs(null);
      setHiddenEndings([]);
      setAvailableEndings([]);
      setHiddenPaths([]);
      setShownPaths([]);
      setScanExcluded([]);
      setSeparateScaffoldState(true);
      setSeparateGitignoredState(true);
      return;
    }
    Promise.all([
      invoke<ProjectJson>("get_project_panel_prefs", { localFile }),
      remoteBlocked
        ? Promise.resolve<string[]>([])
        : invoke<string[]>("list_project_endings", { projectDir }).catch(() => []),
    ])
      .then(([loaded, endings]) => {
        const savedHiddenEndings = readStringList(loaded, PANEL_HIDDEN_ENDINGS_KEY);
        setPrefs(loaded);
        setHiddenEndings(savedHiddenEndings);
        setAvailableEndings(mergeEndings(endings, savedHiddenEndings));
        setHiddenPaths(readStringList(loaded, PANEL_HIDDEN_PATHS_KEY));
        setShownPaths(readStringList(loaded, PANEL_SHOWN_PATHS_KEY));
        setScanExcluded(readStringList(loaded, SCAN_EXCLUDED_PATHS_KEY).map(normalizeScanPath).filter(Boolean));
        setSeparateScaffoldState(readBool(loaded, PANEL_SEPARATE_SCAFFOLD_KEY));
        setSeparateGitignoredState(readBool(loaded, PANEL_SEPARATE_GITIGNORED_KEY));
      })
      .catch((e) => {
        setPrefs(null);
        setHiddenEndings([]);
        setAvailableEndings([]);
        setHiddenPaths([]);
        setShownPaths([]);
        setScanExcluded([]);
        setSeparateScaffoldState(true);
        setSeparateGitignoredState(true);
        setError(String(e));
      });
  }, [localFile, projectDir, remoteBlocked]);

  const saveHiddenEndings = async (nextEndings: string[]) => {
    if (!localFile || !prefs) return;
    setHiddenEndings(nextEndings);
    setPrefs({ ...prefs, [PANEL_HIDDEN_ENDINGS_KEY]: nextEndings });
    setError(null);
    try {
      await invoke("set_project_panel_prefs", {
        localFile,
        prefs: { [PANEL_HIDDEN_ENDINGS_KEY]: nextEndings },
      });
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleHiddenEnding = (ending: string, checked: boolean) => {
    const existing = new Set(hiddenEndings.map((item) => item.toLowerCase()));
    const nextEndings = checked
      ? existing.has(ending.toLowerCase())
        ? hiddenEndings
        : [...hiddenEndings, ending]
      : hiddenEndings.filter((item) => item.toLowerCase() !== ending.toLowerCase());
    void saveHiddenEndings(nextEndings);
  };

  const toggleScanExcluded = (relPath: string, excluded: boolean) => {
    const rel = normalizeScanPath(relPath);
    if (!rel || !localFile || !prefs) return;
    const next = excluded
      ? scanExcluded.includes(rel)
        ? scanExcluded
        : [...scanExcluded, rel]
      : scanExcluded.filter((item) => normalizeScanPath(item) !== rel);
    // Optimistic: the tree re-requests sizes off this list, and a failed write
    // surfaces in `error` — the alternative (await, then update) leaves the row
    // showing a size the user just asked us to stop computing.
    setScanExcluded(next);
    patchPref(SCAN_EXCLUDED_PATHS_KEY, next);
  };

  /** Optimistic single-key write, for the same reason `toggleScanExcluded` is
   *  one: the tree re-sections off these flags, and awaiting the write leaves
   *  the switch showing the old value while the file view has not moved. */
  const patchPref = (key: string, value: unknown) => {
    if (!localFile || !prefs) return;
    setPrefs({ ...prefs, [key]: value });
    setError(null);
    invoke("set_project_panel_prefs", { localFile, prefs: { [key]: value } }).catch((e) =>
      setError(String(e)),
    );
  };

  const setSeparateScaffold = (value: boolean) => {
    setSeparateScaffoldState(value);
    patchPref(PANEL_SEPARATE_SCAFFOLD_KEY, value);
  };

  const setSeparateGitignored = (value: boolean) => {
    setSeparateGitignoredState(value);
    patchPref(PANEL_SEPARATE_GITIGNORED_KEY, value);
  };

  return {
    hiddenEndings,
    hiddenPaths,
    shownPaths,
    availableEndings,
    scanExcluded,
    separateScaffold,
    separateGitignored,
    setSeparateScaffold,
    setSeparateGitignored,
    error,
    toggleHiddenEnding,
    toggleScanExcluded,
  };
}

/** Project Settings: which file endings the tree hides, plus the (global)
 *  native-viewer preferences. Portaled, so it opens the same from the panel's
 *  gear and the Files (Project) tab's. */
export function ProjectFilesSettingsDialog({
  localFile,
  project,
  filters,
  onClose,
}: {
  localFile: string;
  /** The project this gear belongs to — used to offer the Python interpreter
   *  picker (the same one the project pill opens). Null in root/box scope. */
  project: ProjectEntry | null;
  filters: ProjectFileFilters;
  onClose: () => void;
}) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const {
    availableEndings,
    hiddenEndings,
    error,
    toggleHiddenEnding,
    separateScaffold,
    separateGitignored,
    setSeparateScaffold,
    setSeparateGitignored,
  } = filters;
  const [showPython, setShowPython] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);

  const alertsOn = settings?.files_alerts ?? true;
  const alertSources = settings?.files_alerts_sources ?? {};
  const mutedCount = settings?.files_alerts_muted?.length ?? 0;
  // Merged, never replaced: each row owns one key, and writing the whole object
  // from a single checkbox would clear the other two.
  const patchAlertSources = (next: NonNullable<Settings["files_alerts_sources"]>) =>
    void updateSettings({ files_alerts_sources: { ...alertSources, ...next } });

  // Offer the Python interpreter picker on the same terms the pill does: the
  // project holds Python files (a probed ending), or it's remote (probed on the
  // host, which may hold Python the local mirror doesn't).
  const hasPython =
    !!project &&
    (!!project.remote ||
      availableEndings.some((e) => PYTHON_ENDINGS.has(e.toLowerCase())));

  return createPortal(
    <>
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog project-settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <SettingsHeader title={t("projectSettings.title")} onClose={onClose} />

        {/* `.settings-dialog` is a split-scroll FRAME: it clips (overflow:hidden,
            padding 0, gap 0) and the `.dialog-scroll` child does the scrolling.
            Without this wrapper the body renders flush to the dialog's edges
            with no spacing between sections, and everything past the frame's
            max-height is cut off with no way to reach it — which for this
            dialog is the Alerts group, "Unmute all" and the debug row. Same
            structure as EventDialog/CustomAgentDialog. */}
        <div className="dialog-scroll">
        <SettingsSection
          title={t("projectSettings.fileHiding")}
          help={t("projectSettings.fileHidingHelp")}
        />
        {availableEndings.length === 0 ? (
          <div className="settings-empty">{t("projectSettings.noEndingsFound")}</div>
        ) : (
          <div className="settings-list project-ending-list">
            {availableEndings.map((ending) => {
              const checked = hiddenEndings.some((item) => item.toLowerCase() === ending.toLowerCase());
              return (
                <button
                  type="button"
                  className={`project-ending-toggle${checked ? " is-hidden" : ""}`}
                  key={ending}
                  aria-pressed={checked}
                  onClick={() => toggleHiddenEnding(ending, !checked)}
                  title={t(
                    checked ? "projectSettings.showEndingFiles" : "projectSettings.hideEndingFiles",
                    { ending },
                  )}
                >
                  {ending}
                </button>
              );
            })}
          </div>
        )}
        {error && <ErrorNote className="settings-error" error={error} />}

        {/* Where the tree puts a project's own scaffold files and everything git
            ignores: their own collapsible sections, or in among the rest. Both
            are grouping rules, not hiding rules — nothing disappears either way
            — which is why they sit beside the endings above rather than in it.
            They live here at all because the file view is rendered many times
            over at once, so the toggle that used to sit under the tree meant
            one project could show different sections in the side panel and in a
            Files (Project) tab, and reset itself on every remount. */}
        <SettingsSection
          title={
            <>
              {t("projectSettings.treeGrouping")} <UntestedTag id="projectSettings.treeGrouping" />
            </>
          }
          help={t("projectSettings.treeGroupingHelp")}
        />
        <SettingsCard>
          <ToggleRow
            label={t("projectSettings.separateScaffold")}
            title={t("projectSettings.separateScaffoldHelp")}
            checked={separateScaffold}
            onChange={(e) => setSeparateScaffold(e.target.checked)}
          />
          <ToggleRow
            label={t("projectSettings.separateGitignored")}
            title={t("projectSettings.separateGitignoredHelp")}
            checked={separateGitignored}
            onChange={(e) => setSeparateGitignored(e.target.checked)}
          />
        </SettingsCard>

        {hasPython && project && (
          <>
            <SettingsSection
              title={t("projectSettings.python")}
              help={t("projectSettings.pythonHelp")}
            />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn"
                onClick={() => setShowPython(true)}
              >
                {project.python_interpreter ? "✓ " : ""}
                {t("projectSettings.pythonInterpreter")}
              </button>
            </div>
          </>
        )}

        {/* Step-by-step migration of an old project to the current Tabtivity
            state (scaffold files, agent-doc templates, .gitignore defaults,
            registry fields) — the reviewed, per-step counterpart of the pill's
            all-at-once "Repair scaffold files". */}
        {project && (
          <>
            <SettingsSection
              title={
                <>
                  {t("projectSettings.migration")} <UntestedTag id="projectSettings.migration" />
                </>
              }
              help={t("projectSettings.migrationHelp")}
            />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn"
                onClick={() => setShowMigrate(true)}
              >
                {t("projectSettings.migrateProject")}
              </button>
            </div>
          </>
        )}

        {/* #48 per-file-type native-viewer settings (global, not per-project).
            Toggles opt-in local autocomplete (#45) per type, plus the global
            autosave (#47). */}
        <SettingsSection
          title={t("projectSettings.nativeViewers")}
          help={t("projectSettings.nativeViewersHelp")}
        />
        <SettingsCard>
          <ToggleRow
            label={t("projectSettings.autosaveEdits")}
            checked={settings?.autosave !== false}
            onChange={(e) => void updateSettings({ autosave: e.target.checked })}
          />
          <ToggleRow
            label={t("projectSettings.highlightRecentEdits")}
            checked={settings?.change_tint !== false}
            onChange={(e) => void updateSettings({ change_tint: e.target.checked })}
          />
          {/* Which Hunspell dictionary the editors' spelling check reads —
              machine-wide, since the language you write in is not per project —
              plus the row that downloads any other language. */}
          <SpellDictionaryPicker />
        </SettingsCard>

        {/* A real table, header row and all. Every row is the SAME four-column
            grid whether or not the type supports completion — a type without it
            leaves those cells empty rather than shortening its row, which is
            what makes the toggles line up in columns you can read down. Before,
            each row was a bare flex line whose extension list stretched, so no
            two rows' controls started at the same x. */}
        <SettingsList boxed className="viewer-prefs-list">
          <div className="viewer-pref-row viewer-pref-head">
            <span>{t("projectSettings.viewerType")}</span>
            <span>{t("agents.enabled")}</span>
            <span>{t("localModel.role.autocomplete")}</span>
            <span>{t("projectSettings.completionLength")}</span>
            <span>{t("fileViewer.spellingLabel")}</span>
          </div>
          {VIEWER_PREF_TYPES.map((vt) => {
            const pref: ViewerPref = settings?.viewer_prefs?.[vt.id] ?? {};
            const enabled = pref.enabled !== false;
            const patch = (next: ViewerPref) =>
              void updateSettings({
                viewer_prefs: {
                  ...(settings?.viewer_prefs ?? {}),
                  [vt.id]: { ...pref, ...next },
                },
              });
            return (
              <div className="viewer-pref-row" key={vt.id}>
                <span className="viewer-pref-label">
                  <span className="viewer-pref-name">{t(vt.labelKey)}</span>
                  <span className="viewer-pref-exts">{vt.extensions.join(" ")}</span>
                </span>
                <Toggle
                  size="sm"
                  checked={enabled}
                  onChange={(e) => patch({ enabled: e.target.checked })}
                  aria-label={`${t(vt.labelKey)} — ${t("agents.enabled")}`}
                />
                {vt.autocomplete ? (
                  <>
                    <Toggle
                      size="sm"
                      checked={pref.autocomplete === true}
                      disabled={!enabled}
                      onChange={(e) => patch({ autocomplete: e.target.checked })}
                      aria-label={`${t(vt.labelKey)} — ${t("localModel.role.autocomplete")}`}
                    />
                    {/* #45 default completion-length mode; toggled live
                        in-editor with Shift+Tab while a suggestion shows. */}
                    <Dropdown
                      className="viewer-pref-mode"
                      value={pref.autocomplete_mode ?? "sentence"}
                      disabled={!enabled || pref.autocomplete !== true}
                      title={t("projectSettings.completionLengthTitle")}
                      onChange={(v) =>
                        patch({ autocomplete_mode: v as ViewerPref["autocomplete_mode"] })
                      }
                      options={[
                        { value: "sentence", label: t("projectSettings.sentence") },
                        { value: "block", label: t("projectSettings.block") },
                        { value: "scope", label: t("projectSettings.scope") },
                      ]}
                    />
                    {/* Dictionary (Hunspell) spell check — deterministic and
                        model-free, red-underlines typos in the editor. */}
                    <Toggle
                      size="sm"
                      checked={pref.spell_check === true}
                      disabled={!enabled}
                      onChange={(e) => patch({ spell_check: e.target.checked })}
                      aria-label={`${t(vt.labelKey)} — ${t("fileViewer.spellingLabel")}`}
                    />
                  </>
                ) : (
                  /* Three empty cells, so this row's Enabled toggle still sits
                     in the same column as every other row's. */
                  <>
                    <span className="viewer-pref-na">–</span>
                    <span className="viewer-pref-na">–</span>
                    <span className="viewer-pref-na">–</span>
                  </>
                )}
              </div>
            );
          })}
        </SettingsList>

        {/* The side panel's opt-in Alerts group (global, not per-project).
            Off by default on purpose — the file viewer is a work surface, and an
            alert strip nobody asked for is an interruption in the one panel that
            stays open all day. The per-source rows are greyed while the master
            switch is off: they only ever take a source *away*, so they mean
            nothing until there is a group to take it out of. */}
        <SettingsSection
          title={t("filesAlerts.enable")}
          help={t("filesAlerts.enableHint")}
        />
        {/* One card: the master switch, what it looks ahead, and which sources
            it draws from are one setting with three parts — the per-source rows
            only ever take a source *away*, so they mean nothing without the
            switch above them and are disabled with it. */}
        <SettingsCard>
          <ToggleRow
            label={t("agents.enabled")}
            checked={alertsOn}
            onChange={(e) => void updateSettings({ files_alerts: e.target.checked })}
          />
          <div className="settings-card-row">
            <label className="settings-card-label" htmlFor="files-alerts-days">
              {t("filesAlerts.days")}
            </label>
            <input
              id="files-alerts-days"
              type="number"
              min={ALERT_DAYS_MIN}
              max={ALERT_DAYS_MAX}
              step={1}
              disabled={!alertsOn}
              placeholder={String(DEFAULT_LOOKAHEAD_DAYS)}
              value={settings?.files_alerts_days ?? ""}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                // Out of range clears the key rather than storing a value the
                // hook would silently clamp — an unset field showing the
                // default is honest about what the group will actually do.
                void updateSettings({
                  files_alerts_days:
                    Number.isFinite(v) && v >= ALERT_DAYS_MIN && v <= ALERT_DAYS_MAX
                      ? v
                      : undefined,
                });
              }}
            />
          </div>
          <ToggleRow
            label={t("filesAlerts.sourceMail")}
            checked={alertSources.mail !== false}
            disabled={!alertsOn}
            onChange={(e) => patchAlertSources({ mail: e.target.checked })}
          />
          <ToggleRow
            label={t("filesAlerts.sourceEvents")}
            checked={alertSources.events !== false}
            disabled={!alertsOn}
            onChange={(e) => patchAlertSources({ events: e.target.checked })}
          />
          <ToggleRow
            label={t("filesAlerts.sourceTasks")}
            checked={alertSources.tasks !== false}
            disabled={!alertsOn}
            onChange={(e) => patchAlertSources({ tasks: e.target.checked })}
          />
        </SettingsCard>
        {/* The muted rows' escape hatch. The group's own 🔕 chip only counts
            mutes whose row is still live, which is the right number *there* —
            but it means a mute whose mail was unmarked or whose meeting has
            passed has no control of its own left. This one names the raw stored
            count, so the key can always be cleared from somewhere. */}
        {mutedCount > 0 && (
          <SettingRow
            label={t("filesAlerts.mutedStored", { count: mutedCount })}
            control={
              <button
                type="button"
                className="settings-btn sm"
                onClick={() => void updateSettings({ files_alerts_muted: [] })}
                title={t("filesAlerts.unmuteAllTitle")}
              >
                {t("filesAlerts.unmuteAll")}
              </button>
            }
          />
        )}

        {settings?.debug && (
          <>
            <SettingsSection title={t("projectSettings.debug")} />
            <div className="settings-link-row">
              <button
                type="button"
                className="settings-btn danger"
                onClick={() => {
                  invoke("clear_project_session", { localFile }).then(() => {
                    window.location.reload();
                  }).catch(console.error);
                }}
              >
                {t("projectSettings.clearSessionStorage")}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>

    {/* A sibling of the backdrop, not a child of it: this window portals to
        <body>, but React events bubble along the React tree — inside the
        backdrop, a mousedown on the interpreter picker's own backdrop reached
        this dialog's `onMouseDown={onClose}` and closed Project Settings too,
        so dismissing the picker threw away the dialog it was opened from. */}
    {showPython && project && (
      <PythonInterpreterWindow project={project} onClose={() => setShowPython(false)} />
    )}
    {/* Sibling for the same reason as the interpreter picker above. */}
    {showMigrate && project && (
      <ProjectMigrationDialog project={project} onClose={() => setShowMigrate(false)} />
    )}
    </>,
    document.body,
  );
}
