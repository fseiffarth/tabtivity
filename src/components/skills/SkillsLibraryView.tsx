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
import { useDialogs } from "../common/PromptDialogs";

export interface SkillsLibraryViewProps {
  /** Absolute path to the project skills may install into, or `null` where
   *  there is no project to mean — the root scope, and the header's machine-
   *  level surface. Personal is then the only scope, and the selector that
   *  would offer a second one is not drawn. */
  projectDir: string | null;
  visible?: boolean;
}

/**
 * The Skills Library's whole UI (`docs/done/skills_plan.md`): a sources bar, the
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
  const { confirmAction, dialogs } = useDialogs();

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
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [view, setView] = useState<"browse" | "installed">("browse");

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
    } catch (e) {
      setError(String(e));
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemoveSource(source: SkillSource) {
    const ok = await confirmAction({
      title: t("skillsLibrary.removeSource"),
      body: t("skillsLibrary.confirmRemoveSource", { label: source.label }),
      confirmLabel: t("skillsLibrary.removeSource"),
      danger: true,
    });
    if (!ok) return;
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
      const ok = await confirmAction({
        title: t("skillsLibrary.reinstall"),
        body: t("skillsLibrary.confirmReinstall", { name: detail.name }),
        confirmLabel: t("skillsLibrary.reinstall"),
      });
      if (!ok) return;
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
    const ok = await confirmAction({
      title: t("skillsLibrary.uninstall"),
      body: question,
      confirmLabel: t("skillsLibrary.uninstall"),
      danger: true,
    });
    if (!ok) return;
    try {
      await uninstallSkill(personal ? PERSONAL_SKILLS : target, skill.name);
      reloadInstalled();
    } catch (e) {
      setError(String(e));
    }
  }

  const q = filter.trim().toLowerCase();
  const matches = (e: { name: string; description: string }) =>
    !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
  const installedShown = installed.filter(matches);
  const inheritedShown = inProject ? inherited.filter(matches) : [];
  const installedCount = installed.length + (inProject ? inherited.length : 0);
  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null;
  // With no source there is nothing to browse, so the form is the whole screen.
  const sourcesShown = sourcesOpen || sources.length === 0;
  const previewOpen = view === "browse" && !!selectedEntry;
  const isInstalled = !!detail && installedNames.has(detail.name);

  const installedRow = (skill: InstalledSkill, from: "target" | "personal") => (
    <div className="skills-card skills-card-static" key={`${from}:${skill.name}`}>
      <span className="skills-card-name">{skill.name}</span>
      <span className="skills-card-desc">{skill.description}</span>
      <span className="skills-card-foot">
        <button
          type="button"
          className="skills-btn danger"
          onClick={() => handleUninstall(skill, from)}
        >
          {t("skillsLibrary.uninstall")}
        </button>
      </span>
    </div>
  );

  return (
    <div className="skills-pane">
      <div className="skills-toolbar">
        <input
          className="skills-input skills-search"
          type="search"
          aria-label={t("skillsLibrary.searchPlaceholder")}
          placeholder={t("skillsLibrary.searchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="skills-source-select"
          aria-label={t("skillsLibrary.sources")}
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
        <button
          type="button"
          className="skills-btn"
          title={t("skillsLibrary.refreshTitle")}
          disabled={!selectedSource || refreshingId !== null}
          onClick={() => selectedSource && handleRefresh(selectedSource)}
        >
          {refreshingId ? t("skillsLibrary.refreshing") : t("skillsLibrary.refresh")}
        </button>
        <button
          type="button"
          className={`skills-btn${sourcesShown ? " on" : ""}`}
          aria-expanded={sourcesShown}
          onClick={() => setSourcesOpen((v) => !v)}
        >
          {t("skillsLibrary.sources")}
        </button>
      </div>

      {sourcesShown && (
        <div className="skills-sources">
          {sources.length === 0 && <div className="skills-empty">{t("skillsLibrary.noSourcesHint")}</div>}
          {sources.map((s) => (
            <div className="skills-source-row" key={s.id}>
              <span className="skills-source-label">{s.label}</span>
              <span className="skills-source-url" title={s.url}>
                {s.url}
              </span>
              <button type="button" className="skills-btn danger" onClick={() => handleRemoveSource(s)}>
                {t("skillsLibrary.remove")}
              </button>
            </div>
          ))}
          <div className="skills-add-source">
            <input
              className="skills-input"
              placeholder={t("skillsLibrary.addSourceLabelPlaceholder")}
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
            />
            <input
              className="skills-input skills-add-url"
              placeholder={t("skillsLibrary.addSourceUrlPlaceholder")}
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddSource();
              }}
            />
            <button
              type="button"
              className="skills-btn"
              disabled={addBusy || !addUrl.trim()}
              onClick={handleAddSource}
            >
              {t("skillsLibrary.add")}
            </button>
          </div>
        </div>
      )}

      {error && <ErrorNote className="skills-strip error" error={error} />}

      <div className="skills-tabs">
        <button
          type="button"
          className={`skills-tab${view === "browse" ? " on" : ""}`}
          aria-pressed={view === "browse"}
          onClick={() => setView("browse")}
        >
          {t("skillsLibrary.viewBrowse")}
        </button>
        <button
          type="button"
          className={`skills-tab${view === "installed" ? " on" : ""}`}
          aria-pressed={view === "installed"}
          onClick={() => setView("installed")}
        >
          {t("skillsLibrary.viewInstalled")}
          <span className="skills-tab-count">{installedCount}</span>
        </button>
      </div>

      <div className={`skills-body${previewOpen ? " has-preview" : ""}`}>
        <div className="skills-list-col">
          {view === "installed" ? (
            installedCount === 0 ? (
              <div className="skills-empty">{t("skillsLibrary.noInstalled")}</div>
            ) : installedShown.length + inheritedShown.length === 0 ? (
              <div className="skills-empty">{t("skillsLibrary.noMatches", { q: filter.trim() })}</div>
            ) : (
              <>
                {installedShown.length > 0 && (
                  <section className="skills-group">
                    {inProject && <h3 className="skills-group-title">{t("skillsLibrary.scopeProject")}</h3>}
                    <div className="skills-grid">{installedShown.map((s) => installedRow(s, "target"))}</div>
                  </section>
                )}
                {/* Personal skills this project already gets for free. A separate
                    group rather than merged cards: they are usable here but are
                    not this project's, they do not travel with its repo, and
                    removing one removes it from every other project too. */}
                {inheritedShown.length > 0 && (
                  <section className="skills-group">
                    <h3 className="skills-group-title">{t("skillsLibrary.inherited")}</h3>
                    <div className="skills-grid">{inheritedShown.map((s) => installedRow(s, "personal"))}</div>
                  </section>
                )}
              </>
            )
          ) : loadingCatalog ? (
            <div className="skills-empty">{t("skillsLibrary.loading")}</div>
          ) : filteredCatalog.length === 0 ? (
            <div className="skills-empty">
              {!selectedSource
                ? t("skillsLibrary.noSourcesHint")
                : q
                  ? t("skillsLibrary.noMatches", { q: filter.trim() })
                  : t("skillsLibrary.emptySource")}
            </div>
          ) : (
            <div className="skills-grid">
              {filteredCatalog.map((entry) => (
                <button
                  type="button"
                  key={`${entry.source_id}:${entry.rel_path}`}
                  className={`skills-card${
                    selectedEntry?.rel_path === entry.rel_path ? " selected" : ""
                  }`}
                  aria-pressed={selectedEntry?.rel_path === entry.rel_path}
                  onClick={() => setSelectedEntry(entry)}
                >
                  <span className="skills-card-name">{entry.name}</span>
                  <span className="skills-card-desc">{entry.description}</span>
                  <span className="skills-card-foot">
                    {installedNames.has(entry.name) ? (
                      <span className="skills-badge installed">{t("skillsLibrary.installedBadge")}</span>
                    ) : inheritedNames.has(entry.name) ? (
                      <span className="skills-badge personal" title={t("skillsLibrary.personalBadgeTitle")}>
                        {t("skillsLibrary.personalBadge")}
                      </span>
                    ) : null}
                    {entry.has_scripts && (
                      <span className="skills-badge scripts" title={t("skillsLibrary.hasScripts")}>
                        {t("skillsLibrary.scriptsBadge")}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {previewOpen && selectedEntry && (
          <aside className="skills-preview" aria-label={selectedEntry.name}>
            <div className="skills-preview-head">
              <div className="skills-preview-titles">
                <h3 className="skills-preview-name">{selectedEntry.name}</h3>
                <div className="skills-preview-meta">
                  {selectedSource && (
                    <span>{t("skillsLibrary.fromSource", { label: selectedSource.label })}</span>
                  )}
                  {isInstalled ? (
                    <span className="skills-badge installed">{t("skillsLibrary.installedBadge")}</span>
                  ) : inProject && inheritedNames.has(selectedEntry.name) ? (
                    <span className="skills-badge personal" title={t("skillsLibrary.personalBadgeTitle")}>
                      {t("skillsLibrary.personalBadge")}
                    </span>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="skills-close"
                aria-label={t("skillsLibrary.closePreview")}
                title={t("skillsLibrary.closePreview")}
                onClick={() => setSelectedEntry(null)}
              >
                ×
              </button>
            </div>
            <div className="skills-preview-scroll">
              {loadingDetail || !detail ? (
                <div className="skills-empty">{t("skillsLibrary.loading")}</div>
              ) : (
                <>
                  <p className="skills-preview-desc">{detail.description}</p>
                  {/* Already usable here through the personal scope — installing a
                      project copy is a real choice (it travels with the repo, and
                      to a remote host), not a no-op, but it must not look like
                      the only way to get the skill. */}
                  {inProject && !isInstalled && inheritedNames.has(detail.name) && (
                    <div className="skills-strip info">{t("skillsLibrary.alreadyPersonal")}</div>
                  )}
                  {detail.has_scripts && (
                    <div className="skills-strip notice">{t("skillsLibrary.hasScriptsWarning")}</div>
                  )}
                  {detail.files.length > 0 && (
                    <details className="skills-preview-files">
                      <summary>
                        {t("skillsLibrary.bundledFiles")} ({detail.files.length})
                      </summary>
                      <ul>
                        {detail.files.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </details>
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
            {/* The one install control in the feature, with its destination
                beside it: the scope is what the button means, so it is chosen
                where the click happens. A host with no project gets the sentence
                instead, since a one-option selector asks a question with one
                answer. */}
            <div className="skills-install-bar">
              <div className="skills-install-scope">
                {projectDir ? (
                  <div className="skills-seg" role="radiogroup" aria-label={t("skillsLibrary.installTo")}>
                    <span className="skills-seg-label">{t("skillsLibrary.installTo")}</span>
                    <button
                      type="button"
                      className={`skills-seg-btn${scope === "project" ? " on" : ""}`}
                      role="radio"
                      aria-checked={scope === "project"}
                      title={t("skillsLibrary.scopeProjectNote")}
                      onClick={() => setScope("project")}
                    >
                      {t("skillsLibrary.scopeProject")}
                    </button>
                    <button
                      type="button"
                      className={`skills-seg-btn${scope === "personal" ? " on" : ""}`}
                      role="radio"
                      aria-checked={scope === "personal"}
                      title={t("skillsLibrary.scopePersonalNote")}
                      onClick={() => setScope("personal")}
                    >
                      {t("skillsLibrary.scopePersonal")}
                    </button>
                  </div>
                ) : (
                  <span className="skills-seg-label">{t("skillsLibrary.scopePersonalOnly")}</span>
                )}
                {/* Stated on every personal install, because it is the one thing
                    the scope's own name does not say: personal means every
                    project on THIS machine, and no other machine. */}
                <span
                  className="skills-install-note"
                  title={inProject ? t("skillsLibrary.scopeProjectNote") : t("skillsLibrary.scopePersonalNote")}
                >
                  {inProject ? t("skillsLibrary.noteProject") : t("skillsLibrary.notePersonal")}
                </span>
              </div>
              <button
                type="button"
                className={isInstalled ? "skills-btn" : "btn-primary skills-install-btn"}
                disabled={installing || !detail}
                onClick={handleInstall}
              >
                {isInstalled ? t("skillsLibrary.reinstall") : t("skillsLibrary.install")}
              </button>
            </div>
          </aside>
        )}
      </div>
      {dialogs}
    </div>
  );
}
