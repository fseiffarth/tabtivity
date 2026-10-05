import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { renderMarkdown, taskSourceLines, toggleTaskCheckbox } from "../../lib/viewers/markdown";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The dev build's Todo view: the checkout's `todo/*.md` groups, each folding
 * open into its rendered markdown whose task boxes toggle the file like the
 * markdown viewer's preview does (`toggleTaskCheckbox`).
 *
 * Backed by `services::dev_todo`. Agents edit these files constantly, so a
 * click's write is compare-and-swap against the text shown; when the file
 * moved underneath, the click is re-applied to the task with the same line in
 * the new text (if exactly one), and otherwise the fresh text is shown and the
 * click dropped with a note.
 */

export interface TodoGroup {
  name: string;
  title: string;
  open: number;
  done: number;
}

type WriteOutcome = { kind: "written" } | { kind: "changed"; current: string };

let availability: Promise<boolean> | null = null;

/** Whether this binary has a checkout to read todos from. Asked once per
 *  window; a backend without the command (a hot-reloaded window ahead of its
 *  binary) answers no. */
export function useDevTodoAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    availability ??= invoke<TodoGroup[] | null>("dev_todo_groups")
      .then((groups) => Array.isArray(groups))
      .catch(() => false);
    let live = true;
    void availability.then((ok) => { if (live) setAvailable(ok); });
    return () => { live = false; };
  }, []);
  return available;
}

/** Test seam: forget the cached answer. */
export function resetDevTodoAvailability(): void {
  availability = null;
}

const DONE_RE = /^\s*[-*+]\s+\[[xX]\]/;

function counts(text: string): { open: number; done: number } {
  const lines = taskSourceLines(text);
  const done = lines.filter((line) => DONE_RE.test(line)).length;
  return { open: lines.length - done, done };
}

function GroupBody({ text, onToggle }: { text: string; onToggle: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const box = target.closest?.("li.task-item > input[data-md-task]") as HTMLInputElement | null;
    if (box && ref.current) {
      // The box shows what the file holds: no native toggle, the re-render
      // from the written text flips it.
      e.preventDefault();
      const index = Array.from(
        ref.current.querySelectorAll<HTMLInputElement>("li.task-item > input[data-md-task]"),
      ).indexOf(box);
      if (index >= 0) onToggle(index);
      return;
    }
    // Links would navigate the whole webview away; this view only toggles.
    if (target.closest?.("a")) e.preventDefault();
  };
  return (
    <div
      ref={ref}
      className="markdown-body dev-todo-body"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function DevTodoView({ active }: { active: boolean }) {
  const t = useT();
  const [groups, setGroups] = useState<TodoGroup[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const readGroup = useCallback(async (name: string) => {
    try {
      const text = await invoke<string>("dev_todo_read", { name });
      setTexts((all) => ({ ...all, [name]: text }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const reload = useCallback(async () => {
    setNotice(null);
    try {
      setGroups((await invoke<TodoGroup[] | null>("dev_todo_groups")) ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    await Promise.all(openRef.current.map(readGroup));
  }, [readGroup]);

  // Hidden, it reads nothing; each show catches up with what agents changed.
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  const toggleOpen = (name: string) => {
    if (open.includes(name)) {
      setOpen(open.filter((n) => n !== name));
      return;
    }
    setOpen([...open, name]);
    void readGroup(name);
  };

  const applyText = (name: string, text: string) => {
    setTexts((all) => ({ ...all, [name]: text }));
    const c = counts(text);
    setGroups((all) => all?.map((g) => (g.name === name ? { ...g, ...c } : g)) ?? all);
  };

  const onToggle = async (name: string, index: number) => {
    let base = texts[name];
    if (base == null) return;
    const line = taskSourceLines(base)[index];
    let at = index;
    setNotice(null);
    // Three tries: each lost race re-finds the task by its line in the new text.
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = toggleTaskCheckbox(base, at);
      if (next == null) return;
      let outcome: WriteOutcome;
      try {
        outcome = await invoke<WriteOutcome>("dev_todo_write", { name, expected: base, next });
      } catch (e) {
        setError(String(e));
        applyText(name, base);
        return;
      }
      if (outcome.kind === "written") {
        applyText(name, next);
        return;
      }
      base = outcome.current;
      const same = taskSourceLines(base).flatMap((l, i) => (l === line ? [i] : []));
      if (same.length !== 1) {
        applyText(name, base);
        setNotice(t("devTodo.changed"));
        return;
      }
      at = same[0];
    }
    applyText(name, base);
    setNotice(t("devTodo.changed"));
  };

  return (
    <div className="side-panel-scroll dev-todo-view">
      <div className="dev-todo-head">
        <strong>{t("devTodo.title")}</strong>
        <UntestedTag id="devTodo.title" />
        <button
          className="toolbar-btn toolbar-btn--sm"
          style={{ marginLeft: "auto" }}
          onClick={() => void reload()}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          ↻
        </button>
      </div>
      {error && <ErrorNote className="project-dialog-error" error={error} />}
      {notice && <div className="dev-todo-notice">{notice}</div>}
      {groups == null ? (
        <div className="file-tree-empty">{t("common.loading")}</div>
      ) : groups.length === 0 ? (
        <div className="file-tree-empty">{t("devTodo.empty")}</div>
      ) : (
        groups.map((g) => {
          const unfolded = open.includes(g.name);
          const text = texts[g.name];
          return (
            <section key={g.name} className="dev-todo-group">
              <button
                className={`dev-todo-group-head${unfolded ? " open" : ""}`}
                aria-expanded={unfolded}
                title={`todo/${g.name}`}
                onClick={() => toggleOpen(g.name)}
              >
                <span className="dev-todo-chevron" aria-hidden="true">{unfolded ? "▾" : "▸"}</span>
                <span className="dev-todo-group-title">{g.title}</span>
                <span className="dev-todo-count" title={t("devTodo.counts", { open: g.open, done: g.done })}>
                  {g.open}
                </span>
              </button>
              {unfolded && (text == null
                ? <div className="file-tree-empty">{t("common.loading")}</div>
                : <GroupBody text={text} onToggle={(index) => void onToggle(g.name, index)} />)}
            </section>
          );
        })
      )}
    </div>
  );
}
