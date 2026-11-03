import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { formatRemoteTarget, resolveLocalMirror } from "../../types";
import { projectDirectory } from "../../lib/projects/scaffold";
import { useT } from "../../lib/i18n";
import { BoxSwatch } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { useKeyboardSteeringStore, type SteeringBaseLevel } from "../../stores/keyboardSteering";
import { PROJECT_JUMP_EVENT, type ProjectJumpDetail } from "../../lib/projects/projectJumpEvent";
import { boxColor } from "../../lib/theme/boxColor";
import { useBoxSliceStore } from "../../stores/boxSlice";

type SearchRow =
  | { kind: "project"; project: ProjectEntry }
  | { kind: "box"; box: ProjectBox }
  /** "All projects": leaves the box slice. Only offered while a box is sliced. */
  | { kind: "all" };

/** How many member names a box row spells out before it trails off. */
const MEMBER_NAMES_SHOWN = 4;

/** Location line(s) shown under a project's name — and the text the query is
 *  matched against. A remote (SSH) project lives in two places at once, so both
 *  its host target and its paired local mirror are listed; its `directory` is
 *  only an internal state dir and is never shown. */
function searchPaths(project: ProjectEntry): { label?: string; path: string }[] {
  if (project.remote) {
    const mirror = resolveLocalMirror(project);
    return [
      { label: "remote", path: formatRemoteTarget(project.remote) },
      ...(mirror ? [{ label: "local", path: mirror }] : []),
    ];
  }
  const dir = projectDirectory(project);
  return dir ? [{ path: dir }] : [];
}

function matchesQuery(project: ProjectEntry, q: string): boolean {
  return (
    project.name.toLowerCase().includes(q) ||
    searchPaths(project).some((loc) => loc.path.toLowerCase().includes(q))
  );
}

/** The names of a box's members that are known projects, in member order. */
function memberNames(box: ProjectBox, byId: ReadonlyMap<string, ProjectEntry>): string[] {
  return box.member_ids.map((id) => byId.get(id)?.name).filter((name): name is string => !!name);
}

/**
 * The project / box search box and its results popover. Owns its own
 * query state and click-outside dismissal; activation is delegated to the
 * parent via `onActivateProject` / `onOpenBox`.
 *
 * Focusing the box lists the boxes with no query needed, and while a box is
 * sliced "All projects" leads (the way out of the slice). A query matches a box
 * by its name or a member's name; a project row wears its boxes' swatches.
 *
 * Steering's jump key (`PROJECT_JUMP_EVENT`) opens it in jump mode: the open
 * projects lead the results (all of them before anything is typed), so any
 * project is a name away — an open one is switched to, an inactive one is
 * activated. A pick or Escape hands the keyboard back to steering on the
 * level it came from.
 */
export function ProjectSearch({
  projects,
  boxes,
  onActivateProject,
  onOpenBox,
}: {
  projects: ProjectEntry[];
  boxes: ProjectBox[];
  onActivateProject: (projectId: string) => void;
  onOpenBox: (boxId: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  /** The field has focus (or was clicked): the empty-query list is open. */
  const [focused, setFocused] = useState(false);
  const sliceBoxId = useBoxSliceStore((s) => s.sliceBoxId);
  const leaveBox = useBoxSliceStore((s) => s.leaveBox);
  /** Jump mode's steering level to return to; null outside jump mode. */
  const [jumpBack, setJumpBack] = useState<SteeringBaseLevel | null>(null);
  const listId = useId();
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  /** A project's boxes, in box order: the swatches its row wears. */
  const boxesOfProject = useMemo(() => {
    const out = new Map<string, ProjectBox[]>();
    for (const box of [...boxes].sort((a, b) => a.position - b.position)) {
      for (const id of box.member_ids) out.set(id, [...(out.get(id) ?? []), box]);
    }
    return out;
  }, [boxes]);
  const allProjectsLabel = t("projectSearch.allProjects");
  const sliced = sliceBoxId !== null && boxes.some((b) => b.id === sliceBoxId);

  const results = useMemo<SearchRow[]>(() => {
    const q = query.trim().toLowerCase();
    const openRows: SearchRow[] = q || jumpBack
      ? projects
          .filter((p) => p.status !== "inactive" && (!q || matchesQuery(p, q)))
          .sort((a, b) => a.position - b.position)
          .map((project) => ({ kind: "project", project }))
      : [];
    // A box matches by its own name or by a member's name: "which box was
    // alpha in?" is a question the search should answer.
    const boxRows: SearchRow[] = boxes
      .filter(
        (b) =>
          !q ||
          b.name.toLowerCase().includes(q) ||
          memberNames(b, projectById).some((name) => name.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.position - b.position)
      .map((box) => ({ kind: "box", box }));
    // The way out of a slice. Empty field: first row. Typed: last, and only
    // while the query starts its name, so it never takes Enter from a match.
    const allRows: SearchRow[] =
      sliced && (!q || allProjectsLabel.toLowerCase().startsWith(q)) ? [{ kind: "all" }] : [];
    if (!q) {
      // Focused with nothing typed: the way out, then the boxes. Jump mode keeps
      // the open projects leading, as before (Enter there lands on a project).
      return jumpBack ? [...openRows, ...allRows, ...boxRows] : [...allRows, ...boxRows];
    }
    // Open projects, boxes, then matching inactive projects. Boxes are
    // opt-in: a box's members stay independently searchable below.
    const projectRows: SearchRow[] = projects
      .filter((p) => p.status === "inactive" && matchesQuery(p, q))
      .sort((a, b) => a.position - b.position)
      .map((project) => ({ kind: "project", project }));
    return [...openRows, ...boxRows, ...projectRows, ...allRows];
  }, [projects, boxes, query, jumpBack, projectById, sliced, allProjectsLabel]);
  const typed = !!query.trim();
  const expanded = typed || !!jumpBack || (focused && results.length > 0);
  const optionId = (row: SearchRow) =>
    `${listId}-${row.kind}-${row.kind === "box" ? row.box.id : row.kind === "project" ? row.project.id : "all"}`;
  const selectedRow = results[selected];
  const selectedName =
    selectedRow?.kind === "box"
      ? selectedRow.box.name
      : selectedRow?.kind === "all"
        ? allProjectsLabel
        : selectedRow?.project.name;

  // A narrowed query can remove the currently highlighted row. Keep the
  // selection valid so Enter always picks a visible result.
  useEffect(() => {
    setSelected((index) => (results.length === 0 ? 0 : Math.min(index, results.length - 1)));
  }, [results]);

  useEffect(() => {
    const row = resultsRef.current?.querySelector<HTMLElement>(`[data-result-index="${selected}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [results, selected]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) {
        setQuery("");
        setSelected(0);
        setJumpBack(null);
        setFocused(false);
        // Clicked away from a jump: steering no longer waits for it.
        const steering = useKeyboardSteeringStore.getState();
        if (steering.handedTo === "jump") steering.dropHandoff();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<ProjectJumpDetail>).detail;
      if (detail.handled || !inputRef.current) return;
      detail.handled = true;
      setJumpBack(detail.level);
      setFocused(true);
      setQuery("");
      setSelected(0);
      inputRef.current.focus();
    };
    window.addEventListener(PROJECT_JUMP_EVENT, onJump);
    return () => window.removeEventListener(PROJECT_JUMP_EVENT, onJump);
  }, []);

  /** Leave jump mode for steering, on the level the jump started from — or
   *  on the tabs of a project it switched to, as steering's own switches land. */
  const backToSteering = (switched = false) => {
    if (!jumpBack) return;
    setJumpBack(null);
    inputRef.current?.blur();
    const steering = useKeyboardSteeringStore.getState();
    steering.enter();
    if (jumpBack !== "tabs" && !switched) steering.setLevel(jumpBack);
  };

  const activateSearchResult = (row: SearchRow) => {
    setQuery("");
    setFocused(false);
    const switched = row.kind !== "project" || row.project.status !== "current";
    if (row.kind === "all") {
      void leaveBox();
    } else if (row.kind === "box") {
      onOpenBox(row.box.id);
    } else if (switched) {
      onActivateProject(row.project.id);
    }
    backToSteering(switched);
  };

  return (
    <div className="project-search-wrap" ref={searchRef} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="project-search-entry"
        type="search"
        role="combobox"
        aria-label={t("projectSearch.label")}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && selectedRow ? optionId(selectedRow) : undefined}
        placeholder={t(jumpBack ? "projectSearch.jumpPlaceholder" : "projectSearch.placeholder")}
        value={query}
        onFocus={() => setFocused(true)}
        // A pick leaves focus in the field; a click on it opens the list again.
        onClick={() => setFocused(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((index) =>
              results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            const row = results[selected];
            if (row) activateSearchResult(row);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setQuery("");
            setSelected(0);
            setFocused(false);
            backToSteering();
          }
        }}
      />
      {expanded && (
        <div className="project-search-popover" ref={resultsRef}>
          {jumpBack && (
            <div className="project-search-jump-head">
              <UntestedTag id="steering.jumpProject" />
            </div>
          )}
          <div className="menu-scroll-region" id={listId} role="listbox" aria-label={t("projectSearch.resultsLabel")}>
            {results.length === 0 ? (
              <div className="project-search-empty">{t("projectSearch.noProjects")}</div>
            ) : (
              results.map((row, index) => {
                const optionProps = {
                  id: optionId(row),
                  role: "option",
                  "aria-selected": index === selected,
                  "data-result-index": index,
                  onMouseEnter: () => setSelected(index),
                } as const;
                // With nothing typed the boxes sit under a heading of their own.
                const heading =
                  !typed && row.kind === "box" && results[index - 1]?.kind !== "box" ? (
                    <div className="project-search-group" role="presentation">
                      {t("projectSearch.groupBoxes")} <UntestedTag id="projectSearch.boxes" />
                    </div>
                  ) : null;
                if (row.kind === "all") {
                  return (
                    <button
                      key="all"
                      {...optionProps}
                      className={`project-search-row is-all${index === selected ? " is-selected" : ""}`}
                      onClick={() => activateSearchResult(row)}
                    >
                      <span className="project-search-name">{allProjectsLabel}</span>
                      <small>{t("projectSearch.allProjectsHint")}</small>
                    </button>
                  );
                }
                if (row.kind === "box") {
                  const names = memberNames(row.box, projectById);
                  const count = t(
                    row.box.member_ids.length === 1 ? "projectSearch.boxMemberOne" : "projectSearch.boxMemberMany",
                    { count: row.box.member_ids.length },
                  );
                  const shown = names.slice(0, MEMBER_NAMES_SHOWN).join(", ") + (names.length > MEMBER_NAMES_SHOWN ? ", …" : "");
                  return (
                    <Fragment key={`box:${row.box.id}`}>
                      {heading}
                      <button
                        {...optionProps}
                        className={`project-search-row is-box${index === selected ? " is-selected" : ""}`}
                        onClick={() => activateSearchResult(row)}
                      >
                        <span className="project-search-name">
                          <BoxSwatch className="project-search-box-swatch" color={boxColor(row.box)} /> {row.box.name}
                        </span>
                        <small title={names.join(", ")}>{shown ? `${count}: ${shown}` : count}</small>
                      </button>
                    </Fragment>
                  );
                }
                const memberOf = boxesOfProject.get(row.project.id) ?? [];
                return (
                  <button
                    key={row.project.id}
                    {...optionProps}
                    className={`project-search-row${index === selected ? " is-selected" : ""}`}
                    onClick={() => activateSearchResult(row)}
                  >
                    <span className="project-search-name">
                      {row.project.name}
                      {row.project.status !== "inactive" && (
                        <span className="project-search-path-label">{t("projectSearch.openTag")}</span>
                      )}
                      {memberOf.length > 0 && (
                        <span className="project-search-boxes" title={memberOf.map((b) => b.name).join(", ")}>
                          {memberOf.map((b) => (
                            <BoxSwatch key={b.id} className="project-search-box-swatch" color={boxColor(b)} />
                          ))}
                        </span>
                      )}
                    </span>
                    {searchPaths(row.project).map((loc) => (
                      <small key={loc.label ?? "dir"} title={loc.path}>
                        {loc.label && (
                          <span className="project-search-path-label">{loc.label}</span>
                        )}
                        <span className="project-search-path">{loc.path}</span>
                      </small>
                    ))}
                  </button>
                );
              })
            )}
          </div>
          <span className="project-search-status" role="status" aria-live="polite">
            {selectedName ? t("projectSearch.selectedResult", { name: selectedName }) : t("projectSearch.noProjects")}
          </span>
        </div>
      )}
    </div>
  );
}
