import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { basename, relativePathWithin } from "../../lib/paths";
import { parseUnifiedDiff, type DiffLine } from "../../lib/viewers/diff";
import { disabledViewers, type FileEntry } from "../../lib/viewers/fileUtils";
import { readerRequest } from "../../lib/agents/agentReader";
import { watchedReads } from "../../lib/agents/transcriptWatch";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import { DiffLineRow } from "../embed/DiffView";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { openFileEntry } from "../files/openFileEntry";
import { openTabInScope } from "../tabs/tabScopeContext";
import { UntestedTag } from "../common/UntestedTag";
import { ArrowUpRightIcon } from "../common/icons/Icon";
import { Dropdown } from "../common/Dropdown";
import { chatMoment, chatTime } from "../../../mobile-web/src/terminal/chatTimes";

/**
 * The Reader's Changes panel: the files the conversation on screen changed,
 * as the diffs its CLI recorded (`agent_tab_changes`, `services::agent_changes`
 * — Claude's applied edits, Codex's file changes, OpenCode's edit tools),
 * shown in a dedicated full-width tab. Newest first; a file row narrows
 * the list to that file's changes. Reads while shown, as the chat does, and
 * follows it into an open subagent. Portaled with the Reader over the
 * pane, so the pane's mouse handling leaves it alone (`SIGN_IN_CARD_CLASS`).
 */

/** Pair each contiguous replacement run; keep context and metadata in order. */
export function splitDiffRows(lines: readonly DiffLine[]): { before?: DiffLine; after?: DiffLine; note?: string }[] {
  const rows: { before?: DiffLine; after?: DiffLine; note?: string }[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (line.type === "del" || line.type === "add") {
      const before: DiffLine[] = [];
      const after: DiffLine[] = [];
      while (at < lines.length && (lines[at].type === "del" || lines[at].type === "add")) {
        const item = lines[at++];
        (item.type === "del" ? before : after).push(item);
      }
      for (let index = 0; index < Math.max(before.length, after.length); index++) rows.push({ before: before[index], after: after[index] });
    } else {
      rows.push(line.type === "context" ? { before: line, after: line } : { note: line.text });
      at++;
    }
  }
  return rows;
}


export interface FileChange {
  path: string;
  kind: "edit" | "add" | "delete" | "write";
  diff: string;
  added: number;
  removed: number;
  at?: string;
  cut?: boolean;
  movedTo?: string;
}

interface AgentChanges {
  available: boolean;
  reason?: string;
  version?: string;
  unchanged?: boolean;
  changes: FileChange[];
  truncated: boolean;
  /** The read's watch is armed (`lib/agents/transcriptWatch`). */
  watched?: boolean;
}

const KIND_KEY: Record<FileChange["kind"], TranslationKey> = {
  edit: "terminal.changes.kind.edit",
  add: "terminal.changes.kind.add",
  delete: "terminal.changes.kind.delete",
  write: "terminal.changes.kind.write",
};

function reasonKey(changes: AgentChanges | null): TranslationKey {
  if (!changes) return "terminal.changes.loading";
  if (changes.reason === "no_subagent") return "terminal.changes.noSubagent";
  if (changes.reason === "unsupported") return "terminal.changes.unsupported";
  return "terminal.changes.unreadable";
}

/** `path` as shown: inside the tab's folder relative to it, else whole. */
function shownPath(base: string | undefined, path: string): string {
  return (base && relativePathWithin(base, path)) || path;
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="terminal-changes-counts">
      <span className="add">+{added}</span>
      <span className="del">−{removed}</span>
    </span>
  );
}

/** Each change's card key, in the store's order: when and which file, with a
 * count for the same file twice in one moment — stable as newer ones arrive. */
function changeKeys(list: FileChange[]): string[] {
  const seen = new Map<string, number>();
  return list.map((change) => {
    const base = `${change.at ?? ""}|${change.path}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  });
}

/** One change, with its time and diff. The first existing edit opens on entry;
 * newly arriving edits stay folded and marked new until opened. */
const ChangeCard = memo(function ChangeCard({ change, cardKey, fresh, base, use24h, split, initialOpen, onOpenFile, onOpenDiff, onUnfold }: {
  change: FileChange;
  cardKey: string;
  fresh: boolean;
  base: string | undefined;
  use24h: boolean;
  split: boolean;
  initialOpen: boolean;
  onOpenFile: (path: string, newSubwindow: boolean) => void;
  onOpenDiff: (path: string) => void;
  onUnfold: (cardKey: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(initialOpen);
  // Without its final newline, which would parse as one more (empty) row.
  const files = useMemo(() => (open ? parseUnifiedDiff(change.diff.replace(/\n$/u, "")) : []), [open, change.diff]);
  const shown = shownPath(base, change.path);
  const name = basename(shown);
  const folder = shown.slice(0, shown.length - name.length);
  const moment = chatMoment(change.at);
  const openable = change.kind !== "delete" && !change.movedTo;
  return (
    <section className={`terminal-changes-card ${change.kind}${fresh ? " fresh" : ""}`}>
      <div className="terminal-changes-card-head">
        <button
          type="button"
          className="terminal-changes-fold"
          aria-expanded={open}
          title={t(open ? "terminal.changes.collapse" : "terminal.changes.expand")}
          onClick={() => {
            if (!open) onUnfold(cardKey);
            setOpen(!open);
          }}
        >
          <span className={open ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
          {fresh && <span className="terminal-changes-new">{t("terminal.changes.new")}</span>}
          <span className="terminal-changes-kind">{t(KIND_KEY[change.kind])}</span>
          <span className="terminal-changes-path" title={change.path}>
            {folder && <small>{folder}</small>}
            <strong>{name}</strong>
          </span>
        </button>
        <Counts added={change.added} removed={change.removed} />
        {moment && <small className="terminal-changes-time">{chatTime(moment, use24h)}</small>}
        {openable && (
          <button
            type="button"
            className="terminal-changes-open"
            title={t("terminal.changes.openDiff")}
            aria-label={t("terminal.changes.openDiff")}
            onClick={() => onOpenDiff(change.path)}
          >
            ±
          </button>
        )}
        {openable && (
          <button
            type="button"
            className="terminal-changes-open"
            title={`${t("terminal.changes.open")} · ${t("terminal.pathLink.newSubwindow")}`}
            aria-label={t("terminal.changes.open")}
            onClick={(event) => onOpenFile(change.path, event.ctrlKey || event.metaKey)}
          >
            <ArrowUpRightIcon />
          </button>
        )}
      </div>
      {change.movedTo && (
        <small className="terminal-changes-note">{t("terminal.changes.moved", { path: shownPath(base, change.movedTo) })}</small>
      )}
      {open && change.kind === "write" && <small className="terminal-changes-note">{t("terminal.changes.writeHint")}</small>}
      {open && (
        <div className="terminal-changes-diff">
          {files.flatMap((file) => file.hunks).map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={hunkIndex}>
              {split ? <div className="terminal-changes-split">
                <div className="terminal-changes-split-heading"><span>{t("terminal.changes.before")}</span><span>{t("terminal.changes.after")}</span></div>
                {splitDiffRows(hunk.lines).map((row, index) => row.note !== undefined
                  ? <div className="terminal-changes-split-note" key={index}>{row.note}</div>
                  : <div className="terminal-changes-split-row" key={index}>
                    <div className={row.before?.type === "del" ? "del" : ""}><span>{row.before?.oldNo}</span><code>{row.before?.text}</code></div>
                    <div className={row.after?.type === "add" ? "add" : ""}><span>{row.after?.newNo}</span><code>{row.after?.text}</code></div>
                  </div>)}
              </div> : hunk.lines.map((line, lineIndex) => <DiffLineRow line={line} key={lineIndex} />)}
            </div>
          ))}
          {change.cut && <small className="terminal-changes-note">{t("terminal.changes.cut")}</small>}
        </div>
      )}
    </section>
  );
});

export function TerminalReaderChanges({ scope, tab, cwd, visible, subagent, subagentTitle, chat, chatTitle, onClose }: {
  scope: string;
  tab: TabEntry;
  cwd: string | undefined;
  visible: boolean;
  /** The open subagent's handle: its changes are shown instead. */
  subagent: string | undefined;
  subagentTitle: string | undefined;
  /** An earlier chat the Reader shows (`lib/agents/agentChats`): its changes
   * are shown instead. */
  chat?: string;
  chatTitle?: string;
  onClose: () => void;
}) {
  const t = useT();
  const use24h = useUse24h();
  const [read, setRead] = useState<{ key: string; changes: AgentChanges } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const viewerPrefs = useSettingsStore((state) => state.settings?.viewer_prefs);
  const disabled = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const base = tab.cwd || cwd;
  /** Whose changes a read belongs to — a read of another conversation is
   * never drawn under this one. */
  const readKey = `${tab.sessionId ?? ""}|${chat ?? ""}|${subagent ?? ""}`;
  /** The cards of the last read, and those that arrived after the panel's
   * first read of this conversation — what it already held is not new. */
  const seenRef = useRef<{ key: string; cards: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<{ key: string; cards: Set<string> } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let version: string | undefined;
    const stop = watchedReads(async (watch) => {
      const args = readerRequest(scope, tabRef.current, cwd, version, 0, subagent, chat);
      if (!args) {
        setRead({ key: readKey, changes: { available: false, reason: "no_session", changes: [], truncated: false } });
        return false;
      }
      const next = await invoke<AgentChanges>("agent_tab_changes", { ...args, limit: null, watch })
        .catch((): AgentChanges => ({ available: false, reason: "read_failed", changes: [], truncated: false }));
      if (cancelled) return next.watched === true;
      if (!next.unchanged) version = next.version;
      if (!next.unchanged && next.available) {
        const keys = changeKeys(next.changes);
        const seen = seenRef.current;
        const arrived = seen?.key === readKey ? keys.filter((key) => !seen.cards.has(key)) : [];
        seenRef.current = { key: readKey, cards: new Set(keys) };
        if (arrived.length) {
          setFresh((previous) => ({
            key: readKey,
            cards: new Set([...(previous?.key === readKey ? previous.cards : []), ...arrived]),
          }));
        }
      }
      setRead((previous) => (next.unchanged && previous?.key === readKey ? previous : { key: readKey, changes: next }));
      return next.watched === true;
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, scope, cwd, subagent, chat, readKey]);

  const changes = read?.key === readKey ? read.changes : null;
  const list = useMemo(() => (changes?.available ? changes.changes : []), [changes]);
  /** Every file changed, with its totals, in the order first changed. */
  const files = useMemo(() => {
    const byPath = new Map<string, { path: string; added: number; removed: number; count: number }>();
    for (const change of list) {
      const file = byPath.get(change.path) ?? { path: change.path, added: 0, removed: 0, count: 0 };
      file.added += change.added;
      file.removed += change.removed;
      file.count += 1;
      byPath.set(change.path, file);
    }
    return [...byPath.values()];
  }, [list]);
  const filter = picked && files.some((file) => file.path === picked) ? picked : null;
  /** Newest first, keyed by the change itself so a card keeps its fold as
   * newer ones arrive above it. */
  const cards = useMemo(() => {
    const keys = changeKeys(list);
    const keyed = list.map((change, index) => ({ change, key: keys[index] }));
    return keyed.filter(({ change }) => !filter || change.path === filter).reverse();
  }, [list, filter]);
  const freshCards = fresh?.key === readKey ? fresh.cards : null;
  const unfold = useCallback((cardKey: string) => {
    setFresh((previous) => {
      if (!previous?.cards.has(cardKey)) return previous;
      const cards = new Set(previous.cards);
      cards.delete(cardKey);
      return { key: previous.key, cards };
    });
  }, []);

  // Ctrl (⌘) + click opens the file in a new subwindow.
  const openFile = (path: string, newSubwindow: boolean) => {
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    const entry: FileEntry = {
      name,
      path,
      is_dir: false,
      size: 0,
      extension: dot > 0 ? name.slice(dot).toLowerCase() : null,
      mime: null,
    };
    openFileEntry({
      entry,
      projectDir: base ?? "",
      projectId: scope === "root" ? null : scope,
      origin: "reader_changes",
      external: false,
      disabled,
      scope,
      newSubwindow,
    });
  };

  /** The file in the diff viewer (whole file unless the user narrowed it), as
   * the file tree's Show diff opens it: a re-open re-reads. */
  const openDiff = (path: string) => {
    const sameDiff = (t: TabEntry) => t.kind === "embed" && t.viewer === "diff" && t.embedPath === path;
    openTabInScope(
      scope,
      { label: basename(path), cmd: "", cwd: base ?? "", kind: "embed", embedPath: path, viewer: "diff" },
      sameDiff,
      { replace: true },
    );
  };

  return (
    <aside className={`terminal-changes terminal-changes-tab ${SIGN_IN_CARD_CLASS}`} aria-label={t("terminal.changes.title")} tabIndex={-1}>
      <header className="terminal-changes-head">
        <strong>{t("terminal.changes.title")}</strong>
        <UntestedTag id="terminal.reader.changes" />
        {list.length > 0 && (
          <small>{t("terminal.changes.summary", { files: files.length, edits: list.length })}</small>
        )}
        <Dropdown className="terminal-changes-view" value={split ? "split" : "unified"}
          options={[{ value: "split", label: t("terminal.changes.split") }, { value: "unified", label: t("terminal.changes.unified") }]}
          onChange={(value) => setSplit(value === "split")} />
        <button type="button" className="terminal-changes-close" onClick={onClose} title={t("terminal.changes.close")} aria-label={t("terminal.changes.close")}>
          ✕
        </button>
      </header>
      {subagent ? (
        <small className="terminal-changes-scope" title={subagentTitle}>{t("terminal.changes.subagent", { name: subagentTitle ?? "" })}</small>
      ) : chat && (
        <small className="terminal-changes-scope" title={chatTitle}>{t("terminal.changes.chat", { name: chatTitle ?? "" })}</small>
      )}
      <div className="terminal-changes-body">
      {files.length > 0 && (
        <div className="terminal-changes-files" role="listbox" aria-label={t("terminal.changes.files")}>
          <button type="button" role="option" aria-selected={!filter} className={!filter ? "active" : undefined} onClick={() => setPicked(null)}>
            <span className="terminal-changes-path"><strong>{t("terminal.changes.allFiles")}</strong></span>
          </button>
          {files.map((file) => {
            const shown = shownPath(base, file.path);
            return (
              <button
                type="button"
                role="option"
                key={file.path}
                aria-selected={filter === file.path}
                className={filter === file.path ? "active" : undefined}
                title={file.path}
                onClick={() => setPicked(filter === file.path ? null : file.path)}
              >
                <span className="terminal-changes-path"><strong>{shown}</strong></span>
                {file.count > 1 && <small>×{file.count}</small>}
                <Counts added={file.added} removed={file.removed} />
              </button>
            );
          })}
        </div>
      )}
      <div className="terminal-changes-list">
        {!changes?.available ? (
          <div className="terminal-reader-empty">{t(reasonKey(changes))}</div>
        ) : list.length === 0 ? (
          <div className="terminal-reader-empty">{t("terminal.changes.empty")}</div>
        ) : (
          cards.map(({ change, key }, index) => (
            <ChangeCard
              key={key}
              change={change}
              cardKey={key}
              fresh={!!freshCards?.has(key)}
              base={base}
              use24h={use24h}
              split={split}
              initialOpen={index === 0 && !freshCards?.has(key)}
              onOpenFile={openFile}
              onOpenDiff={openDiff}
              onUnfold={unfold}
            />
          ))
        )}
        {changes?.available && changes.truncated && (
          <small className="terminal-changes-note">{t("terminal.changes.truncated")}</small>
        )}
      </div>
      </div>
    </aside>
  );
}
