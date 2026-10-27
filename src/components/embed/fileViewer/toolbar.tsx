import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { invokeTrusted } from "../../../lib/execTrust";
import { PrinterIcon } from "../../common/PrinterIcon";
import { SaveIcon } from "../../common/SaveIcon";
import {
  formatJsonText,
  isInProcessJson,
  formatLangForPath,
  validationLangForPath,
} from "../../../lib/viewers/format";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { useT } from "../../../lib/i18n";

/** Save control shared by every editable viewer (#47). The outline disk matches
 * the printer mark beside it; dirty/clean state is carried by the button color
 * and enabled state, while an in-flight write swaps the mark for a spinner. */
export function SaveButton({
  isDirty,
  saving,
  save,
  title,
}: {
  isDirty: boolean;
  saving: boolean;
  save: () => void;
  title?: string;
}) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <button
      className={`file-viewer-save${isDirty ? " is-dirty" : ""}${saving ? " is-saving" : ""}`}
      onClick={save}
      disabled={!isDirty || saving}
      aria-label={t("common.save")}
      title={
        saving
          ? t("common.saving")
          : title ?? (isDirty ? chordHint(t("fileViewer.saveWithShortcut"), "editorSave") : t("fileViewer.noUnsavedChanges"))
      }
    >
      {saving ? (
        <span className="file-viewer-save-spinner" aria-hidden="true" />
      ) : (
        <SaveIcon />
      )}
    </button>
  );
}

/** Print button shared by every content viewer. Renders the viewer's content to
 *  a clean paginated document and hands it to the platform print dialog (which
 *  offers "Save as PDF") — see `lib/viewers/print`. `busy` covers async sources
 *  like the PDF viewer, which rasterises its pages before printing. */
export function PrintButton({
  onPrint,
  busy = false,
  disabled = false,
}: {
  onPrint: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <button
      className={`file-viewer-print${busy ? " is-busy" : ""}`}
      onClick={onPrint}
      disabled={disabled || busy}
      title={busy ? t("pdfViewer.preparing") : t("pdfViewer.printLabel")}
      aria-label={t("pdfViewer.printLabel")}
    >
      {busy ? (
        <span className="file-viewer-save-spinner" aria-hidden="true" />
      ) : (
        <PrinterIcon />
      )}
    </button>
  );
}

/** Undo/redo toolbar buttons shared by the editable viewers (#46). */
export function UndoRedoButtons({
  undo,
  redo,
  canUndo,
  canRedo,
}: {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <div className="file-viewer-history" role="group" aria-label={t("fileViewer.editHistory")}>
      <button
        className="file-viewer-history-btn"
        onClick={undo}
        disabled={!canUndo}
        aria-label={t("common.undo")}
        title={chordHint(t("fileViewer.undoShortcut"), "editorUndo")}
      >
        ↶
      </button>
      <button
        className="file-viewer-history-btn"
        onClick={redo}
        disabled={!canRedo}
        aria-label={t("common.redo")}
        title={chordHint(t("fileViewer.redoShortcut"), "editorRedo")}
      >
        ↷
      </button>
    </div>
  );
}

// ── Per-format extras: format, validation, preview, markup toolbar ───────────

/**
 * "Format document" support for the editable text viewers. JSON is prettified
 * in-process; every other recognised type shells out to an external formatter
 * (prettier/black/rustfmt/gofmt) via the backend, which is probed once per path
 * so the button can disable itself when no tool is installed. A formatted result
 * is written back through `setDraft`, so it lands as one undo step.
 */
export function useFormatter(path: string, draft: string, setDraft: (v: string) => void) {
  const t = useT();
  const lang = useMemo(() => formatLangForPath(path), [path]);
  const inProcess = useMemo(() => isInProcessJson(path), [path]);
  const enabled = inProcess || lang != null;
  // JSON (in-process) is always available; an external formatter is probed.
  const [available, setAvailable] = useState(inProcess);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!lang) {
      setAvailable(inProcess);
      return;
    }
    let cancelled = false;
    invoke<boolean>("formatter_available", { lang, path })
      .then((ok) => { if (!cancelled) setAvailable(inProcess || ok); })
      .catch(() => { if (!cancelled) setAvailable(inProcess); });
    return () => { cancelled = true; };
  }, [lang, path, inProcess]);

  // Auto-dismiss a finished status after a few seconds.
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), 6000);
    return () => window.clearTimeout(id);
  }, [status]);

  const run = useCallback(async () => {
    if (busy) return;
    const text = draftRef.current;
    setStatus(null);
    if (inProcess) {
      const res = formatJsonText(text);
      if (res.ok) {
        if (res.text !== text) setDraft(res.text);
      } else {
        setStatus(t("fileViewer.cantFormat", { error: res.error }));
      }
      return;
    }
    if (!lang) return;
    setBusy(true);
    try {
      const out = await invokeTrusted<string>("format_source", { text, lang, path });
      if (out !== text) setDraft(out);
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("formatter-unavailable")) {
        setAvailable(false);
        setStatus(t("fileViewer.noFormatterInstalled"));
      } else {
        setStatus(msg.length > 240 ? `${msg.slice(0, 240)}…` : msg);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, inProcess, lang, path, setDraft, t]);

  return { enabled, available, busy, status, run };
}

/** "Format" toolbar button; disabled when no formatter is available or while a
 *  format is in flight. Keeps editor focus so the document stays the target. */
export function FormatButton({
  available,
  busy,
  run,
}: {
  available: boolean;
  busy: boolean;
  run: () => void;
}) {
  const t = useT();
  return (
    <button
      className="file-viewer-format-btn"
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      disabled={!available || busy}
      title={available ? t("fileViewer.formatDocument") : t("fileViewer.noFormatterFound")}
      aria-label={t("fileViewer.formatDocument")}
    >
      {busy ? <span className="file-viewer-save-spinner" aria-hidden="true" /> : t("fileViewer.formatBtn")}
    </button>
  );
}

interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
}

/** Debounced backend syntax check for JSON/YAML; returns the first parse error
 *  (or null when valid / not a checked type). Re-runs as the draft changes. */
export function useSyntaxCheck(path: string, draft: string, loaded: boolean): SyntaxIssue | null {
  const lang = useMemo(() => validationLangForPath(path), [path]);
  const [issue, setIssue] = useState<SyntaxIssue | null>(null);
  useEffect(() => {
    if (!lang || !loaded) {
      setIssue(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      invoke<SyntaxIssue | null>("check_syntax", { text: draft, lang })
        .then((r) => { if (!cancelled) setIssue(r ?? null); })
        .catch(() => { if (!cancelled) setIssue(null); });
    }, 500);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [lang, draft, loaded]);
  return lang ? issue : null;
}

/** Inline parse-error banner for JSON/YAML, with a jump to the offending line. */
export function ValidationBanner({
  issue,
  onJump,
}: {
  issue: SyntaxIssue | null;
  onJump: (line: number, column: number) => void;
}) {
  const t = useT();
  if (!issue) return null;
  const where = issue.line
    ? issue.column
      ? t("fileViewer.validationAtLineCol", { line: issue.line, column: issue.column })
      : t("fileViewer.validationAtLine", { line: issue.line })
    : "";
  return (
    <div className="file-viewer-validation" role="alert">
      <span className="file-viewer-validation-dot" aria-hidden="true" />
      <span className="file-viewer-validation-msg">
        {issue.message}
        {where}
      </span>
      {issue.line > 0 && (
        <button
          className="file-viewer-validation-jump"
          onClick={() => onJump(issue.line, issue.column)}
        >
          {t("fileViewer.goToLine")}
        </button>
      )}
    </div>
  );
}

/** Reusable Preview/Edit (Source) segmented toggle, styled like the existing
 *  markdown mode buttons. */
export function ModeToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="file-viewer-modes">
      {options.map((o) => (
        <button
          key={o.value}
          className={`file-viewer-mode${value === o.value ? " active" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "Compare" toolbar toggle. When active the editor body is replaced by the
 *  three-column compare/merge view (old commit ⇄ live content ⇄ editable result). */
export function CompareButton({ active, toggle }: { active: boolean; toggle: () => void }) {
  const t = useT();
  return (
    <button
      className={`file-viewer-format-btn file-viewer-compare-btn${active ? " active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={active ? t("fileViewer.compareCloseTitle") : t("fileViewer.compareOpenTitle")}
      aria-label={t("fileViewer.compareToggleLabel")}
      aria-pressed={active}
    >
      {t("fileViewer.compareBtn")}
    </button>
  );
}
