import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectBox, ProjectEntry } from "../../types";
import { formatRemoteTarget, resolveLocalMirror } from "../../types";
import { projectDirectory } from "./scaffold";
import { useT } from "../../lib/i18n";
import { HexagonIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { useKeyboardSteeringStore, type SteeringBaseLevel } from "../../stores/keyboardSteering";
import { PROJECT_JUMP_EVENT, type ProjectJumpDetail } from "../../lib/projects/projectJumpEvent";

type SearchRow =
  | { kind: "project"; project: ProjectEntry }
  | { kind: "box"; box: ProjectBox };

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

/**
 * The inactive-project / box search box and its results popover. Owns its own
 * query state and click-outside dismissal; activation is delegated to the
 * parent via `onActivateProject` / `onOpenBox`.
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
  /** Jump mode's steering level to return to; null outside jump mode. */
  const [jumpBack, setJumpBack] = useState<SteeringBaseLevel | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const results = useMemo<SearchRow[]>(() => {
    const q = query.trim().toLowerCase();
    const openRows: SearchRow[] = jumpBack
      ? projects
          .filter((p) => p.status !== "inactive" && (!q || matchesQuery(p, q)))
          .sort((a, b) => a.position - b.position)
          .map((project) => ({ kind: "project", project }))
      : [];
    if (!q) return openRows;
    // Boxes first (distinct rows), then matching inactive projects. Boxes are
    // opt-in: a box's members stay independently searchable below.
    const boxRows: SearchRow[] = boxes
      .filter((b) => b.name.toLowerCase().includes(q))
      .sort((a, b) => a.position - b.position)
      .map((box) => ({ kind: "box", box }));
    const projectRows: SearchRow[] = projects
      .filter((p) => p.status === "inactive" && matchesQuery(p, q))
      .sort((a, b) => a.position - b.position)
      .map((project) => ({ kind: "project", project }));
    return [...openRows, ...boxRows, ...projectRows];
  }, [projects, boxes, query, jumpBack]);

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
      setQuery("");
      setSelected(0);
      inputRef.current.focus();
    };
    window.addEventListener(PROJECT_JUMP_EVENT, onJump);
    return () => window.removeEventListener(PROJECT_JUMP_EVENT, onJump);
  }, []);

  /** Leave jump mode for steering, on the level the jump started from. */
  const backToSteering = () => {
    if (!jumpBack) return;
    setJumpBack(null);
    inputRef.current?.blur();
    const steering = useKeyboardSteeringStore.getState();
    steering.enter();
    if (jumpBack !== "tabs") steering.setLevel(jumpBack);
  };

  const activateSearchResult = (row: SearchRow) => {
    setQuery("");
    if (row.kind === "box") {
      onOpenBox(row.box.id);
    } else if (row.project.status !== "current") {
      onActivateProject(row.project.id);
    }
    backToSteering();
  };

  return (
    <div className="project-search-wrap" ref={searchRef} onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="project-search-entry"
        type="search"
        placeholder={t(jumpBack ? "projectSearch.jumpPlaceholder" : "projectSearch.placeholder")}
        value={query}
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
            backToSteering();
          }
        }}
      />
      {(query.trim() || jumpBack) && (
        <div className="project-search-popover" ref={resultsRef}>
          {jumpBack && (
            <div className="project-search-jump-head">
              <UntestedTag id="steering.jumpProject" />
            </div>
          )}
          <div className="menu-scroll-region">
            {results.length === 0 ? (
              <div className="project-search-empty">{t("projectSearch.noProjects")}</div>
            ) : (
              results.map((row, index) =>
                row.kind === "box" ? (
                  <button
                    key={`box:${row.box.id}`}
                    data-result-index={index}
                    className={`project-search-row is-box${index === selected ? " is-selected" : ""}`}
                    onClick={() => activateSearchResult(row)}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span>
                      <HexagonIcon className="project-box-badge" /> {row.box.name}
                    </span>
                    <small>
                      {t(row.box.member_ids.length === 1 ? "projectSearch.boxMemberOne" : "projectSearch.boxMemberMany", {
                        count: row.box.member_ids.length,
                      })}
                    </small>
                  </button>
                ) : (
                  <button
                    key={row.project.id}
                    data-result-index={index}
                    className={`project-search-row${index === selected ? " is-selected" : ""}`}
                    onClick={() => activateSearchResult(row)}
                    onMouseEnter={() => setSelected(index)}
                  >
                    <span className="project-search-name">
                      {row.project.name}
                      {row.project.status !== "inactive" && (
                        <span className="project-search-path-label">{t("projectSearch.openTag")}</span>
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
                ),
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
