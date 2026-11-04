/**
 * The command palette: one box that finds a tab, a project, a file, an action
 * or a setting. `#` narrows it to files, which is what the Quick open chord
 * opens it on. Enter opens the row, Ctrl+Enter opens a tab or file in a new
 * subwindow beside the focused one, Esc closes. No agent and no model: it only
 * ranks what the renderer already holds, so it needs no backend of its own.
 *
 * Mounted once by `QuickOpen`, and in a popout by `DetachedCenterPanel`, where
 * `local` scopes it to that window's tabs: a popout has no project strip or
 * settings dialog to send a pick to.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { attentionStateClass, busyStateClass, useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { scopeDisplayName, useBoxesStore } from "../../stores/boxes";
import { useBoxSliceStore } from "../../stores/boxSlice";
import { boxColor } from "../../lib/theme/boxColor";
import { useSettingsStore } from "../../stores/settings";
import { ROOT_SCOPE, useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs/types";
import { fuzzyMatch, fuzzyRank } from "../../lib/fuzzy";
import { loadQuickOpenIndex, type QuickOpenNote } from "../../lib/files/quickOpenIndex";
import { basename, resolvePath } from "../../lib/paths";
import { IS_MAC } from "../../lib/platform";
import { chordLabel, chordMatches, resolveChord, SHORTCUT_DEFS, type ShortcutAction, type ShortcutMap } from "../../lib/shortcuts/shortcuts";
import { runShortcutAction } from "../../lib/shortcuts/runAction";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { useT } from "../../lib/i18n";
import { voiceInputOffered } from "../../lib/voice/desktopVoice";
import { experimentalEnabled } from "../../lib/experimental";
import { openTexWorkspace } from "../../lib/viewers/tex/openTexWorkspace";
import { hasActiveModal, useModalFocus } from "../../hooks/useModalFocus";
import { isEditableTarget } from "../../hooks/useKeyboard";
import { resolveProjectDirectory } from "../../types";
import { openLinkedFile, viewerForPath } from "../embed/fileViewer/openLinked";
import { TabStatusMark, statusMarkSlots } from "../tabs/TabLocalityBadges";
import { UntestedTag } from "../common/UntestedTag";
import { BoxSwatch } from "../common/icons/Icon";
import { useQuickCreateBox } from "../projects/useQuickCreateBox";
import { searchSettings, type NavEntry } from "./settingsIndex";

/** Opens the palette; a `CustomEvent` detail of `{ filter: "#" }` opens it on
 *  that filter. Every door (the chord, Quick open's chord, the menus) fires this. */
export const OPEN_PALETTE_EVENT = "app:open-palette";

const FILE_FILTER = "#";
/** Rows shown per group, and when the whole box is one group of files. */
const GROUP_LIMIT = 6;
const FILE_LIMIT = 50;

/** The groups an action is offered from: what acts on the window. A key that
 *  only means something inside a terminal or editor stays out. */
const ACTION_GROUPS = new Set(["navigation", "tabs", "newTab", "view"]);
/** The numbered agent chords are the + menu's slots: their label is a number,
 *  which says nothing here. The palette opening itself says less. */
const HIDDEN_ACTIONS = /^agentTab[2-9]$|^commandPalette$/;

export interface LocalPaletteTabs {
  tabs: readonly TabEntry[];
  scope: string;
  activate: (key: string) => void;
}

interface Row {
  id: string;
  group: string;
  label: ReactNode;
  /** The text the fuzzy highlight is drawn over; the row's label otherwise. */
  text: string;
  detail?: ReactNode;
  run: (beside: boolean) => void;
}

/** The label with the fuzzy-matched characters emphasised. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const positions = useMemo(() => {
    if (!query) return null;
    const match = fuzzyMatch(query, text);
    return match ? new Set(match.positions) : null;
  }, [text, query]);
  if (!positions || positions.size === 0) return <>{text}</>;
  return (
    <>
      {text.split("").map((ch, i) =>
        positions.has(i) ? (
          <span key={i} className="command-palette-hl">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/** Open `rel` of the active project; `beside` splits it off the focused subwindow. */
function openProjectFile(projectDir: string, rel: string, beside: boolean) {
  const path = resolvePath(projectDir, rel);
  const viewer = viewerForPath(path);
  // A `.tex` opens (or focuses) the single TeX workspace for its document,
  // consistent with the file tree; every other type opens its viewer tab.
  if (viewer === "tex") {
    void openTexWorkspace(path);
    return;
  }
  const label = basename(path);
  const tabs = useTabsStore.getState();
  const focused = tabs.focusedGroupId;
  if (beside && focused) {
    tabs.splitWithNewTab({ label, cmd: "", cwd: projectDir, kind: "embed", embedPath: path, viewer }, focused, "right");
    return;
  }
  openLinkedFile(undefined, projectDir, { path, viewer, label });
}

/** Show the tab; `beside` moves it next to the focused subwindow when both are
 *  in the scope on screen. */
function showTab(scope: string, key: string, beside: boolean) {
  const tabs = useTabsStore.getState();
  // A root tab is never moved into the workspace's layout: root is shown by
  // its own window, `jumpToTab` opens that.
  if (beside && scope === tabs.scope && scope !== ROOT_SCOPE && tabs.focusedGroupId) {
    tabs.splitWithTab(key, tabs.focusedGroupId, "right");
    return;
  }
  jumpToTab(scope, key);
}

function statusClassOf(scope: string, tab: TabEntry): string {
  const activity = useActivityStore.getState();
  const ptyId = `${scope}:${tab.key}`;
  if (activity.busyByTab[ptyId]) return busyStateClass(activity.busyKindByTab[ptyId], tab.kind);
  return attentionStateClass(activity.attentionByTab[ptyId] ?? null);
}

export function CommandPalette({ local }: { local?: LocalPaletteTabs }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [note, setNote] = useState<QuickOpenNote>(null);
  const overrides = useSettingsStore((s) => s.settings?.keyboard_shortcuts) as ShortcutMap | undefined;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // A palette re-opened over a slow listing keeps only the newer answer.
  const fetchToken = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setInput("");
    setSelected(0);
  }, []);
  const modalRef = useModalFocus(close, open);
  // The "New box…" action: the name prompt outlives the palette (a pick closes
  // it first), so its host is rendered on both sides of `open`.
  const { quickCreateBox, dialogs: quickCreateDialogs } = useQuickCreateBox();
  // Read at pick time: the rows are built once per opening and must not follow
  // the prompt hook's identity.
  const quickCreateRef = useRef(quickCreateBox);
  quickCreateRef.current = quickCreateBox;

  const projectDir = useCallback((): string => {
    const { projects, activeId } = useProjectsStore.getState();
    const project = projects.find((p) => p.id === activeId);
    return project ? resolveProjectDirectory(project) : "";
  }, []);

  const show = useCallback(
    (filter: string) => {
      setInput(filter);
      setSelected(0);
      setOpen(true);
      if (local) return;
      const dir = projectDir();
      const token = ++fetchToken.current;
      setFiles([]);
      setNote(null);
      if (!dir) return;
      setFilesLoading(true);
      void loadQuickOpenIndex(dir).then((index) => {
        if (token !== fetchToken.current) return;
        setFiles(index.files);
        setNote(index.note);
        setFilesLoading(false);
      });
    },
    [local, projectDir],
  );

  useEffect(() => {
    const onOpen = (e: Event) => show((e as CustomEvent<{ filter?: string } | undefined>).detail?.filter ?? "");
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
  }, [show]);

  // The chord, past the field gate: from an editable target the key stays that
  // field's or terminal's own. Bubble phase, so anything that claimed it wins.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || open || hasActiveModal() || isEditableTarget(e.target)) return;
      if (!chordMatches(resolveChord("commandPalette", overrides), e)) return;
      e.preventDefault();
      show("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, overrides, show]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filesOnly = input.startsWith(FILE_FILTER);
  const query = (filesOnly ? input.slice(FILE_FILTER.length) : input).trim();

  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    const out: Row[] = [];
    const take = (group: string, items: Row[], limit = GROUP_LIMIT) => {
      out.push(...fuzzyRank(query, items, (row) => row.text).slice(0, limit).map((row) => ({ ...row, group })));
    };

    if (local) {
      take(t("palette.group.tabs"), local.tabs.map((tab) => tabRow(local.scope, tab, null, () => local.activate(tab.key))));
      return out;
    }

    const { projects, activeId, setActive } = useProjectsStore.getState();
    const { boxes } = useBoxesStore.getState();
    const dir = projectDir();
    if (!filesOnly) {
      const tabs = useTabsStore.getState();
      const byScope: Record<string, readonly TabEntry[]> = { ...tabs.tabsByScope, [tabs.scope]: tabs.tabs };
      // A box scope's tabs name their box, like a project's name their project.
      const name = (scope: string) => scopeDisplayName(scope, projects, boxes, t);
      take(
        t("palette.group.tabs"),
        Object.entries(byScope).flatMap(([scope, list]) =>
          list.map((tab) => tabRow(scope, tab, name(scope), (beside) => showTab(scope, tab.key, beside))),
        ),
      );
      take(
        t("palette.group.projects"),
        projects.map((project) => ({
          id: `project:${project.id}`,
          group: "",
          label: project.name,
          text: project.name,
          run: () => void setActive(project.id),
        })),
      );
      take(
        t("palette.group.boxes"),
        [...boxes]
          .sort((a, b) => a.position - b.position)
          .map((box) => ({
            id: `box:${box.id}`,
            group: "",
            label: (
              <>
                <BoxSwatch className="command-palette-box-swatch" color={boxColor(box)} />
                <Highlighted text={box.name} query={query} />
              </>
            ),
            text: box.name,
            detail: t(box.member_ids.length === 1 ? "projectSearch.boxMemberOne" : "projectSearch.boxMemberMany", {
              count: box.member_ids.length,
            }),
            run: () => void useBoxSliceStore.getState().selectBox(box.id),
          })),
      );
    }
    if (dir) {
      const active = projects.find((p) => p.id === activeId);
      take(
        t("palette.group.files", { project: active?.name ?? "" }),
        files.map((rel) => ({
          id: `file:${rel}`,
          group: "",
          label: rel,
          text: rel,
          run: (beside) => openProjectFile(dir, rel, beside),
        })),
        filesOnly ? FILE_LIMIT : GROUP_LIMIT,
      );
    }
    if (filesOnly) return out;

    // Box actions lead the Actions group (one heading: same label, adjacent).
    // "Add X to Box" needs a typed query, or a blank palette would list one row
    // per box; the other two are short and always offered.
    const actionsHead = t("palette.group.actions");
    const sliceId = useBoxSliceStore.getState().sliceBoxId;
    const current = projects.find((p) => p.id === activeId);
    const boxActions: Row[] = [
      {
        id: "boxaction:new",
        group: "",
        label: t("palette.action.newBox"),
        text: t("palette.action.newBox"),
        run: () => void quickCreateRef.current(),
      },
      ...(sliceId && boxes.some((b) => b.id === sliceId)
        ? [
            {
              id: "boxaction:showAll",
              group: "",
              label: t("palette.action.showAllProjects"),
              text: t("palette.action.showAllProjects"),
              run: () => void useBoxSliceStore.getState().leaveBox(),
            },
          ]
        : []),
      ...(query && current
        ? [...boxes]
            .sort((a, b) => a.position - b.position)
            .filter((box) => !box.member_ids.includes(current.id))
            .map((box) => {
              const label = t("palette.action.addToBox", { project: current.name, box: box.name });
              return {
                id: `boxaction:add:${box.id}`,
                group: "",
                label,
                text: label,
                run: () => void useBoxesStore.getState().addToBox(current.id, box.id),
              };
            })
        : []),
    ];
    take(actionsHead, boxActions);
    take(
      actionsHead,
      SHORTCUT_DEFS.filter((def) => ACTION_GROUPS.has(def.group) && !def.context && !HIDDEN_ACTIONS.test(def.action)).map(
        (def) => actionRow(def.action, t(def.labelKey), overrides),
      ),
    );
    // Settings are only worth a row once something is typed: a blank box would
    // otherwise list the whole index.
    if (query) {
      const settings = useSettingsStore.getState().settings;
      const shown = (entry: NavEntry) =>
        (entry !== "assistant" || experimentalEnabled(settings, "assistant")) &&
        (entry !== "voice" || voiceInputOffered());
      out.push(
        ...searchSettings(query, t, shown)
          .slice(0, GROUP_LIMIT)
          .map((hit) => ({
            id: `setting:${hit.value}`,
            group: t("palette.group.settings"),
            label: hit.label,
            text: hit.label,
            detail: hit.trail,
            run: () => {
              const page = hit.page;
              const target = page.startsWith("settings-anchor-")
                ? { panel: "main", anchor: page }
                : { panel: page };
              const reveal = hit.path ? { path: hit.path, open: hit.open } : undefined;
              window.dispatchEvent(new CustomEvent("app:open-settings", { detail: { ...target, reveal } }));
            },
          })),
      );
    }
    return out;
    // `open` re-reads the stores once per opening: a row list that followed
    // them live would move under the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, filesOnly, files, local, overrides, t]);

  useEffect(() => {
    setSelected((s) => (rows.length === 0 ? 0 : Math.min(s, rows.length - 1)));
  }, [rows]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected, rows]);

  const pick = useCallback(
    (row: Row | undefined, beside: boolean) => {
      if (!row) return;
      close();
      row.run(beside);
    },
    [close],
  );

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((s) => (rows.length === 0 ? 0 : (s + step + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[selected], IS_MAC ? e.metaKey : e.ctrlKey);
    }
  };

  if (!open) return <>{quickCreateDialogs}</>;

  const emptyLine = () => {
    if (filesLoading) return t("quickOpen.loading");
    if (note === "declined") return t("search.hostDeclined");
    if (note) return t("projectFilesPane.disconnectedHostOnly", { host: note.host });
    if (filesOnly && files.length === 0) return t("quickOpen.noFiles");
    return t("quickOpen.noMatches");
  };

  let lastGroup: string | null = null;
  return (
    <>
    <div
      className="modal-backdrop command-palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("palette.title")} className="project-dialog dialog-framed command-palette">
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder={t("palette.placeholder")}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setInput(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onInputKey}
        />
        <div className="command-palette-list dialog-scroll" ref={listRef}>
          {rows.length === 0 ? (
            <div className="command-palette-empty" role="status">
              {emptyLine()}
            </div>
          ) : (
            rows.map((row, idx) => {
              const head = row.group !== lastGroup ? row.group : null;
              lastGroup = row.group;
              return (
                <div key={row.id}>
                  {head && <div className="command-palette-group">{head}</div>}
                  <div
                    data-idx={idx}
                    className={`command-palette-row${idx === selected ? " selected" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(row, IS_MAC ? e.metaKey : e.ctrlKey);
                    }}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <span className="command-palette-label">
                      {typeof row.label === "string" ? <Highlighted text={row.label} query={query} /> : row.label}
                    </span>
                    {row.detail && <span className="command-palette-detail">{row.detail}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="command-palette-footer">
          <span>
            <kbd>↵</kbd> {t("palette.footerOpen")}
          </span>
          <span>
            <kbd>{chordLabel({ key: "Enter", ctrl: true })}</kbd> {t("palette.footerBeside")}
          </span>
          <span>
            <kbd>{chordLabel({ key: "Escape" })}</kbd> {t("palette.footerClose")}
          </span>
          <UntestedTag id="desktop.palette" />
          <UntestedTag id="palette.boxes" />
        </div>
      </div>
    </div>
    {quickCreateDialogs}
    </>
  );
}

function tabRow(scope: string, tab: TabEntry, scopeName: string | null, run: Row["run"]): Row {
  const stateClass = statusClassOf(scope, tab);
  return {
    id: `tab:${scope}:${tab.key}`,
    group: "",
    label: (
      <>
        <TabStatusMark stateClass={stateClass} slots={statusMarkSlots(tab.kind)} />
        {tab.label}
      </>
    ),
    text: tab.label,
    detail: scopeName ?? undefined,
    run,
  };
}

function actionRow(action: ShortcutAction, label: string, overrides: ShortcutMap | undefined): Row {
  const chord = resolveChord(action, overrides);
  return {
    id: `action:${action}`,
    group: "",
    label,
    text: label,
    detail: chord.key ? <kbd>{chordLabel(chord)}</kbd> : undefined,
    run: () => {
      // After the palette's own teardown, so the chord lands on the window and
      // not on a modal still on top.
      window.setTimeout(() => runShortcutAction(action, overrides), 0);
    },
  };
}
