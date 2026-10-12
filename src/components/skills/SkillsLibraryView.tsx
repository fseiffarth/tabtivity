import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick } from "../../lib/viewers/markdownLinks";
import {
  PERSONAL_SKILLS,
  addSkillSource,
  getSkillDetail,
  installSkill,
  listInstalledSkills,
  listSkillCatalog,
  listSkillSources,
  projectSkills,
  refreshSkillSource,
  removeSkillSource,
  uninstallSkill,
} from "../../lib/agents/skills";
import type {
  InstalledSkill,
  SkillCatalogEntry,
  SkillDetail,
  SkillSource,
} from "../../types/skills";
import { ErrorNote } from "../common/ErrorNote";

export interface SkillsLibraryViewProps {
  /** Absolute path to the project skills may install into, or `null` where
   *  there is no project to mean — the root scope, and the header's machine-
   *  level surface. Personal is then the only scope, and the selector that
   *  would offer a second one is not drawn. */
  projectDir: string | null;
  visible?: boolean;
}

/**
 * The Skills Library's whole UI (`docs/skills_plan.md`): a sources bar, the
 * install scope's already-installed skills, a browsable/filterable catalog, and
 * a preview panel that is the ONLY place the install action lives — showing a
 * skill's content before it is copied into agent-trusted territory is the one
 * piece of the original security posture worth keeping even at this scope, and
 * it costs nothing extra to build beyond putting the button here rather than on
 * the list row.
 *
 * **The catalog is machine state; only the install is scoped**, which is why
 * this is one component with a scope switch rather than two views. The sources
 * and their clones are shared by every project, so browsing needs no project at
 * all — and the same panel therefore serves the project tab and the header's
 * 🧠 menu, the "one component, two hosts" bargain `ProjectFilesView` strikes.
 *
 * The scope itself is this component's own state rather than a prop: a host
 * knows whether a project exists, not which scope the user wants for the next
 * install, and offering it *beside the install button* is what keeps the answer
 * visible at the moment it matters. It defaults to the narrower scope that is
 * available — the project when there is one — because a personal install is
 * read by every project on the machine and should be asked for rather than
 * fallen into.
 *
 * There is deliberately no manifest on this side either: `installed` is a plain
 * read of the target's `.claude/skills/*`, so a hand-authored skill shows up
 * exactly like one this UI installed, and re-installing is a plain overwrite
 * the user confirms rather than a tracked version bump. `inherited` is the same
 * read against the personal scope while a project scope is selected — without
 * it the catalog's "Installed" badge would lie by omission, reporting a skill
 * the project can already use as absent.
 */
export function SkillsLibraryView({ projectDir, visible = true }: SkillsLibraryViewProps) {
  const t = useT();

  const [scope, setScope] = useState<"project" | "personal">(
    projectDir ? "project" : "personal",
  );
  // A host whose project resolves late (or goes away) must not leave the scope
  // pointing at a project that isn't there — the target would carry an empty
  // dir, which the backend refuses.
  useEffect(() => {
    if (!projectDir) setScope("personal");
  }, [projectDir]);

  const inProject = scope === "project" && !!projectDir;
  const target = useMemo(
    () => (inProject && projectDir ? projectSkills(projectDir) : PERSONAL_SKILLS),
    [inProject, projectDir],
  );

  const [sources, setSources] = useState<SkillSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [inherited, setInherited] = useState<InstalledSkill[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<SkillCatalogEntry | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);

  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  const [addLabel, setAddLabel] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const reloadInstalled = useCallback(() => {
    listInstalledSkills(target)
      .then(setInstalled)
      .catch((e) => setError(String(e)));
    // The personal list is read as well while a project is the target, because
    // a personally-installed skill IS available in this project — a catalog
    // badge that ignored it would report an available skill as missing. In the
    // personal scope it would be the same list twice, so it is not read.
    if (inProject) {
      listInstalledSkills(PERSONAL_SKILLS)
        .then(setInherited)
        .catch((e) => setError(String(e)));
    } else {
      setInherited([]);
    }
  }, [target, inProject]);

  // Sources load once the tab is first shown; the installed lists re-read
  // whenever the scope moves, since they are what the scope selects.
  useEffect(() => {
    if (!visible) return;
    listSkillSources()
      .then((list) => {
        setSources(list);
        setSelectedSourceId((prev) => prev || list[0]?.id || "");
      })
      .catch((e) => setError(String(e)));
    // Deliberately once per mount (not re-run on every `visible` flip): a
    // background tab keeps its already-loaded list, matching diskusage/files.
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    reloadInstalled();
  }, [visible, reloadInstalled]);

  // The catalog is re-derived from the source's cache on every selection —
  // nothing about it is persisted, and no clone/pull happens here (only an
  // explicit Refresh click does that).
  useEffect(() => {
    if (!selectedSourceId) {
      setCatalog([]);
      return;
    }
    setLoadingCatalog(true);
    setSelectedEntry(null);
    setDetail(null);
    listSkillCatalog(selectedSourceId)
      .then(setCatalog)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingCatalog(false));
  }, [selectedSourceId]);

  useEffect(() => {
    if (!selectedEntry) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    getSkillDetail(selectedEntry.source_id, selectedEntry.rel_path)
      .then(setDetail)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingDetail(false));
  }, [selectedEntry]);

  /** In the scope the install button aims at — the only set "Reinstall" and the
   *  overwrite confirm may read, since those are about *this* target's copy. */
  const installedNames = useMemo(() => new Set(installed.map((s) => s.name)), [installed]);
  /** Present personally while a project is the target: usable here already, but
   *  not this project's own copy, so it is badged differently and never turns
   *  the install button into a "Reinstall" for a folder it would not touch. */
  const inheritedNames = useMemo(() => new Set(inherited.map((s) => s.name)), [inherited]);

  const filteredCatalog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  const detailHtml = useMemo(() => (detail ? renderMarkdown(detail.body) : ""), [detail]);

  async function handleAddSource() {
    if (!addUrl.trim()) return;
    setAddBusy(true);
    setError("");
    try {
      const created = await addSkillSource(addLabel.trim() || addUrl.trim(), addUrl.trim());
      setSources((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
      setSelectedSourceId(created.id);
      setAddLabel("");
      setAddUrl("");
      setAddOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemoveSource(source: SkillSource) {
    if (!window.confirm(t("skillsLibrary.confirmRemoveSource", { label: source.label }))) return;
    try {
      await removeSkillSource(source.id);
      const remaining = sources.filter((s) => s.id !== source.id);
      setSources(remaining);
      if (selectedSourceId === source.id) {
        setSelectedSourceId(remaining[0]?.id ?? "");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRefresh(source: SkillSource) {
    setRefreshingId(source.id);
    setError("");
    try {
      await refreshSkillSource(source.id);
      if (source.id === selectedSourceId) {
        setLoadingCatalog(true);
        setCatalog(await listSkillCatalog(source.id));
        setLoadingCatalog(false);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshingId(null);
    }
  }

  async function handleInstall() {
    if (!selectedEntry || !detail) return;
    if (installedNames.has(detail.name)) {
      if (!window.confirm(t("skillsLibrary.confirmReinstall", { name: detail.name }))) return;
    }
    setInstalling(true);
    setError("");
    try {
      await installSkill(target, selectedEntry.source_id, selectedEntry.rel_path);
      reloadInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  /** Uninstall names the scope it removes from — the personal rows carry their
   *  own button, and a row that says "this reaches every project" must not be
   *  removable by a confirm that talks about this one. */
  async function handleUninstall(skill: InstalledSkill, from: "target" | "personal") {
    const personal = from === "personal" || !inProject;
    const question = personal
      ? t("skillsLibrary.confirmUninstallPersonal", { name: skill.name })
      : t("skillsLibrary.confirmUninstall", { name: skill.name });
    if (!window.confirm(question)) return;
    try {
      await uninstallSkill(personal ? PERSONAL_SKILLS : target, skill.name);
      reloadInstalled();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="skills-pane">
      <div className="skills-toolbar">
        <span className="skills-title">{t("skillsLibrary.title")}</span>
        <select
          className="skills-source-select"
          value={selectedSourceId}
          onChange={(e) => setSelectedSourceId(e.target.value)}
          disabled={sources.length === 0}
        >
          {sources.length === 0 && <option value="">{t("skillsLibrary.noSources")}</option>}
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {sources.map((s) =>
          s.id === selectedSourceId ? (
            <button
              key={s.id}
              className="skills-btn small"
              disabled={refreshingId === s.id}
              onClick={() => handleRefresh(s)}
            >
              {refreshingId === s.id ? t("skillsLibrary.refreshing") : t("skillsLibrary.refresh")}
            </button>
          ) : null,
        )}
        {selectedSourceId && (
          <button
            className="skills-btn small danger"
            onClick={() => {
              const source = sources.find((s) => s.id === selectedSourceId);
              if (source) handleRemoveSource(source);
            }}
          >
            {t("skillsLibrary.removeSource")}
          </button>
        )}
        <span className="skills-toolbar-spacer" />
        <button className="skills-btn small" onClick={() => setAddOpen((v) => !v)}>
          {t("skillsLibrary.addSource")}
        </button>
      </div>

      {addOpen && (
        <div className="skills-add-source">
          <input
            className="skills-input"
            placeholder={t("skillsLibrary.addSourceLabelPlaceholder")}
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
          />
          <input
            className="skills-input"
            placeholder={t("skillsLibrary.addSourceUrlPlaceholder")}
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddSource();
            }}
          />
          <button className="skills-btn small" disabled={addBusy || !addUrl.trim()} onClick={handleAddSource}>
            {t("skillsLibrary.add")}
          </button>
        </div>
      )}

      {/* The scope, in its own row rather than folded into the toolbar: it is
          not another source control, it is what the install button means. Drawn
          only where there is a second scope to choose — a host with no project
          gets the sentence instead, since a one-option selector is chrome that
          asks a question with one answer. */}
      <div className="skills-scope-row">
        {projectDir ? (
          <>
            <span className="skills-scope-label">{t("skillsLibrary.installTo")}</span>
            <div className="skills-scope-choices" role="radiogroup" aria-label={t("skillsLibrary.installTo")}>
              <button
                type="button"
                className={`skills-scope-btn${scope === "project" ? " on" : ""}`}
                role="radio"
                aria-checked={scope === "project"}
                onClick={() => setScope("project")}
              >
                {t("skillsLibrary.scopeProject")}
              </button>
              <button
                type="button"
                className={`skills-scope-btn${scope === "personal" ? " on" : ""}`}
                role="radio"
                aria-checked={scope === "personal"}
                onClick={() => setScope("personal")}
              >
                {t("skillsLibrary.scopePersonal")}
              </button>
            </div>
          </>
        ) : (
          <span className="skills-scope-label">{t("skillsLibrary.scopePersonalOnly")}</span>
        )}
        {/* Stated on every personal install, because it is the one thing the
            scope's own name does not say: personal means every project on THIS
            machine, and no other machine — a remote project's agents run on the
            host, where this folder does not exist. */}
        <span className="skills-scope-note">
          {inProject ? t("skillsLibrary.scopeProjectNote") : t("skillsLibrary.scopePersonalNote")}
        </span>
      </div>

      {error && <ErrorNote className="skills-strip error" error={error} />}

      <div className="skills-body">
        <div className="skills-list-col">
          <section className="skills-installed">
            <div className="skills-section-title">
              {inProject ? t("skillsLibrary.installed") : t("skillsLibrary.installedPersonal")}
            </div>
            {installed.length === 0 ? (
              <div className="skills-empty">{t("skillsLibrary.noInstalled")}</div>
            ) : (
              installed.map((skill) => (
                <div className="skills-installed-row" key={skill.name}>
                  <div className="skills-installed-info">
                    <span className="skills-installed-name">{skill.name}</span>
                    <span className="skills-installed-desc">{skill.description}</span>
                  </div>
                  <button
                    className="skills-btn small danger"
                    onClick={() => handleUninstall(skill, "target")}
                  >
                    {t("skillsLibrary.uninstall")}
                  </button>
                </div>
              ))
            )}
          </section>

          {/* Personal skills this project already gets for free. A separate
              section rather than merged rows: they are usable here but are not
              this project's, they do not travel with its repo, and removing one
              removes it from every other project too. */}
          {inProject && inherited.length > 0 && (
            <section className="skills-installed">
              <div className="skills-section-title">{t("skillsLibrary.inherited")}</div>
              {inherited.map((skill) => (
                <div className="skills-installed-row" key={skill.name}>
                  <div className="skills-installed-info">
                    <span className="skills-installed-name">{skill.name}</span>
                    <span className="skills-installed-desc">{skill.description}</span>
                  </div>
                  <button
                    className="skills-btn small danger"
                    onClick={() => handleUninstall(skill, "personal")}
                  >
                    {t("skillsLibrary.uninstall")}
                  </button>
                </div>
              ))}
            </section>
          )}

          <input
            className="skills-input skills-filter"
            placeholder={t("skillsLibrary.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <div className="skills-catalog">
            {loadingCatalog ? (
              <div className="skills-empty">{t("skillsLibrary.loading")}</div>
            ) : filteredCatalog.length === 0 ? (
              <div className="skills-empty">{t("skillsLibrary.noCatalog")}</div>
            ) : (
              filteredCatalog.map((entry) => (
                <div
                  key={`${entry.source_id}:${entry.rel_path}`}
                  className={`skills-catalog-row${
                    selectedEntry?.rel_path === entry.rel_path ? " selected" : ""
                  }`}
                  onClick={() => setSelectedEntry(entry)}
                >
                  <div className="skills-catalog-row-head">
                    <span className="skills-catalog-name">{entry.name}</span>
                    {installedNames.has(entry.name) ? (
                      <span className="skills-badge">{t("skillsLibrary.installedBadge")}</span>
                    ) : inheritedNames.has(entry.name) ? (
                      <span className="skills-badge personal" title={t("skillsLibrary.personalBadgeTitle")}>
                        {t("skillsLibrary.personalBadge")}
                      </span>
                    ) : null}
                    {entry.has_scripts && <span className="skills-scripts-dot" title={t("skillsLibrary.hasScripts")} />}
                  </div>
                  <div className="skills-catalog-desc">{entry.description}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="skills-preview">
          {!selectedEntry ? (
            <div className="skills-empty skills-preview-empty">{t("skillsLibrary.noSelection")}</div>
          ) : loadingDetail || !detail ? (
            <div className="skills-empty">{t("skillsLibrary.loading")}</div>
          ) : (
            <>
              <div className="skills-preview-head">
                <span className="skills-preview-name">{detail.name}</span>
                {/* The button names its destination. It is the only install
                    control in the feature and the scope can be changed two rows
                    above it, so a bare "Install" would be the one word that
                    cannot say where the copy lands. */}
                <button className="skills-btn primary" disabled={installing} onClick={handleInstall}>
                  {installedNames.has(detail.name)
                    ? inProject
                      ? t("skillsLibrary.reinstallProject")
                      : t("skillsLibrary.reinstallPersonal")
                    : inProject
                      ? t("skillsLibrary.installProject")
                      : t("skillsLibrary.installPersonal")}
                </button>
              </div>
              <div className="skills-preview-desc">{detail.description}</div>
              {/* Already usable here through the personal scope — installing a
                  project copy is a real choice (it travels with the repo, and to
                  a remote host), not a no-op, but it must not look like the only
                  way to get the skill. */}
              {inProject && !installedNames.has(detail.name) && inheritedNames.has(detail.name) && (
                <div className="skills-strip notice">{t("skillsLibrary.alreadyPersonal")}</div>
              )}
              {detail.has_scripts && (
                <div className="skills-strip notice">{t("skillsLibrary.hasScriptsWarning")}</div>
              )}
              {detail.files.length > 0 && (
                <div className="skills-preview-files">
                  <div className="skills-section-title">{t("skillsLibrary.bundledFiles")}</div>
                  <ul>
                    {detail.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
              {/* A skill body has no file here to resolve links against:
                  anchors scroll, nothing navigates the app window away. */}
              <div
                className="skills-preview-body markdown-body"
                onClick={(e) => onMarkdownLinkClick(e)}
                dangerouslySetInnerHTML={{ __html: detailHtml }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
