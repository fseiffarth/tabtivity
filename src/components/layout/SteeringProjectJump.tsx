import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { BoxSwatch } from "../common/icons/Icon";
import { useT } from "../../lib/i18n";
import { PROJECT_JUMP_EVENT, type ProjectJumpDetail } from "../../lib/projects/projectJumpEvent";
import { jumpStartRows, projectSearchRows, rowSwitches, searchPaths, type SearchRow } from "../../lib/projects/projectSearchRows";
import { recentProjectIds, trackProjectRecency } from "../../lib/projects/projectRecency";
import { boxColor } from "../../lib/theme/boxColor";
import { useBoxesStore } from "../../stores/boxes";
import { useBoxSliceStore } from "../../stores/boxSlice";
import { useKeyboardSteeringStore, type SteeringBaseLevel } from "../../stores/keyboardSteering";
import { useProjectsStore } from "../../stores/projects";

/** Up to this many results sit on the ring, each on a digit key. */
export const RING_SLOTS = 10;

/** The digit that picks ring slot `index`: keyboard order, 1–9 then 0. */
export const ringDigit = (index: number) => String((index + 1) % RING_SLOTS);

/** The ring slot a digit key picks, or null for any other key. */
function slotOfDigit(key: string): number | null {
  if (!/^[0-9]$/u.test(key)) return null;
  const digit = Number(key);
  return digit === 0 ? RING_SLOTS - 1 : digit - 1;
}

/** Where slot `index` of `count` sits: evenly round an ellipse, the first at
 *  twelve o'clock, clockwise. Percentages of the ring box. */
function ringSpot(index: number, count: number): CSSProperties {
  const angle = (2 * Math.PI * index) / count;
  return { left: `${50 + 38 * Math.sin(angle)}%`, top: `${50 - 40 * Math.cos(angle)}%` };
}

/**
 * Steering's project jump (the jump key, `/` by default): a search field in
 * the middle of the window. Before a letter is typed the ring holds the open
 * and recently used projects (`jumpStartRows`; recency from
 * `projectRecency`, tracked from mount). While a query leaves at most ten results they
 * sit on a ring round the field, each with a digit (1–9, then 0) that opens it
 * at once; more than that, they are a list under the field. ↑/↓ move the
 * highlight, Enter opens it: an open project is switched to, an inactive one
 * activated, a box sliced. A digit with no slot behind it types into the field,
 * so a name with digits stays searchable once its slot numbers run out.
 *
 * A pick that switched lands steering on the new project's tabs; Escape, or
 * picking the current project, returns to the level the key was pressed on.
 * Mounted once in `AppShell`, opened by `PROJECT_JUMP_EVENT`; a modal
 * (`DialogShell`), so steering's key handler stands aside while it is up.
 */
export function SteeringProjectJump() {
  const [level, setLevel] = useState<SteeringBaseLevel | null>(null);

  useEffect(() => trackProjectRecency(), []);

  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<ProjectJumpDetail>).detail;
      if (detail.handled) return;
      detail.handled = true;
      setLevel(detail.level);
    };
    window.addEventListener(PROJECT_JUMP_EVENT, onJump);
    return () => window.removeEventListener(PROJECT_JUMP_EVENT, onJump);
  }, []);

  if (!level) return null;
  const close = (switched: boolean) => {
    setLevel(null);
    const steering = useKeyboardSteeringStore.getState();
    steering.enter();
    if (level !== "tabs" && !switched) steering.setLevel(level);
  };
  return <JumpBox onClose={close} />;
}

function JumpBox({ onClose }: { onClose: (switched: boolean) => void }) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const boxes = useBoxesStore((s) => s.boxes);
  const activeId = useProjectsStore((s) => s.activeId);
  const sliceBoxId = useBoxSliceStore((s) => s.sliceBoxId);
  /** Read once per opening: the order the ring starts from. */
  const [recentIds] = useState(recentProjectIds);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const allProjectsLabel = t("projectSearch.allProjects");
  const sliced = sliceBoxId !== null && boxes.some((b) => b.id === sliceBoxId);

  const results = useMemo(
    () =>
      query.trim()
        ? projectSearchRows({ projects, boxes, query, sliced, allProjectsLabel })
        : jumpStartRows({ projects, recentIds, activeId, limit: RING_SLOTS }),
    [projects, boxes, query, sliced, allProjectsLabel, recentIds, activeId],
  );
  const ring = results.length > 0 && results.length <= RING_SLOTS;
  const current = results.length ? Math.min(selected, results.length - 1) : -1;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-result-index="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, ring]);

  const pick = (row: SearchRow) => {
    const switched = rowSwitches(row);
    if (row.kind === "all") void useBoxSliceStore.getState().leaveBox();
    else if (row.kind === "box") void useBoxSliceStore.getState().selectBox(row.box.id);
    else if (switched) void useProjectsStore.getState().setActive(row.project.id);
    onClose(switched);
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const rowName = (row: SearchRow) =>
    row.kind === "all" ? allProjectsLabel : row.kind === "box" ? row.box.name : row.project.name;
  const optionProps = (index: number) =>
    ({
      id: optionId(index),
      type: "button",
      role: "option",
      tabIndex: -1,
      "aria-selected": index === current,
      "data-result-index": index,
      onMouseEnter: () => setSelected(index),
      onClick: () => pick(results[index]),
    }) as const;

  const field = (
    <input
      className="file-paste-name steering-jump-input"
      type="search"
      role="combobox"
      autoFocus
      aria-label={t("projectSearch.label")}
      aria-autocomplete="list"
      aria-expanded={results.length > 0}
      aria-controls={listId}
      aria-activedescendant={current >= 0 ? optionId(current) : undefined}
      placeholder={t("projectSearch.jumpPlaceholder")}
      value={query}
      onChange={(e) => {
        setQuery(e.target.value);
        setSelected(0);
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
        const slot = ring ? slotOfDigit(e.key) : null;
        if (slot !== null && results[slot]) {
          e.preventDefault();
          pick(results[slot]);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          if (results.length) setSelected((current + step + results.length) % results.length);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (current >= 0) pick(results[current]);
        }
      }}
    />
  );

  return (
    <DialogShell className="steering-jump-dialog" onDismiss={() => onClose(false)}>
      <h2 className="steering-prompt-head">
        <span className="steering-prompt-title">{t("steering.jumpProject.label")}</span>
        <UntestedTag id="steering.jumpRing" />
      </h2>
      {/* One tree for both shapes, the field first in it: a switch between
          ring and list must not remount the field and drop its caret. */}
      <div className={ring ? "steering-jump-stage is-ring" : "steering-jump-stage"}>
        <div className="steering-jump-center">{field}</div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t("projectSearch.resultsLabel")}
          className={ring ? "steering-jump-ring" : results.length ? "steering-prompt-list steering-jump-list" : "steering-jump-ring"}
        >
          {ring
            ? results.map((row, index) => (
                <button
                  key={rowKey(row)}
                  {...optionProps(index)}
                  className={index === current ? "steering-prompt-chip steering-jump-slot on" : "steering-prompt-chip steering-jump-slot"}
                  style={ringSpot(index, results.length)}
                  data-inactive={row.kind === "project" && row.project.status === "inactive" ? "" : undefined}
                >
                  <kbd>{ringDigit(index)}</kbd>
                  {row.kind === "box" && <BoxSwatch className="project-search-box-swatch" color={boxColor(row.box)} />}
                  <span className="steering-jump-slot-name">{rowName(row)}</span>
                </button>
              ))
            : results.map((row, index) => {
                const where = row.kind === "project" ? searchPaths(row.project)[0] : undefined;
                return (
                  <button key={rowKey(row)} {...optionProps(index)} className="terminal-reader-option">
                    <span className="terminal-reader-option-label">
                      <span className="steering-jump-row-name">
                        {row.kind === "box" && <BoxSwatch className="project-search-box-swatch" color={boxColor(row.box)} />}
                        {rowName(row)}
                        {row.kind === "project" && row.project.status !== "inactive" && (
                          <span className="project-search-path-label">{t("projectSearch.openTag")}</span>
                        )}
                      </span>
                      {where && <small title={where.path}>{where.path}</small>}
                    </span>
                  </button>
                );
              })}
        </div>
        {results.length === 0 && <small className="steering-prompt-note">{t("projectSearch.noProjects")}</small>}
      </div>
      <div className="file-delete-actions">
        <span className="steering-prompt-hint">
          {ring && (
            <span><kbd>1–0</kbd> {t("steering.jump.hintDigit")}</span>
          )}
          <span><kbd>↑ ↓</kbd> {t("steering.jump.hintMove")}</span>
          <span><kbd>{t("steering.prompt.keyEnter")}</kbd> {t("steering.jump.hintOpen")}</span>
          <span><kbd>{t("steering.prompt.keyEsc")}</kbd> {t("steering.prompt.hintBack")}</span>
        </span>
      </div>
    </DialogShell>
  );
}

function rowKey(row: SearchRow): string {
  return row.kind === "all" ? "all" : row.kind === "box" ? `box:${row.box.id}` : row.project.id;
}
