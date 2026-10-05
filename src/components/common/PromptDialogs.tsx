import { useModalFocus } from "../../hooks/useModalFocus";
import { type ReactNode, useCallback, useId, useLayoutEffect, useState } from "react";
import { UntestedTag } from "./UntestedTag";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import type { UntestedId } from "../../lib/untested";
import { ErrorNote } from "./ErrorNote";

/**
 * The three shapes every in-app question takes — ask for a name, ask yes/no,
 * say something happened — in Tabtivity's own chrome.
 *
 * `RenameDialog` replaced one `window.prompt()` because WebKitGTK draws it as a
 * bare browser alert headed with the page origin ("localhost:1420 says" in a dev
 * window, a blank system box in a packaged one): themeless, unable to say which
 * folder the file is in, and throwing the typed name away when the operation
 * fails. Every *other* side-panel gesture kept the native box, so the panel
 * asked its questions two different ways depending on which one you clicked —
 * a rename in Tabtivity's dialog, "New File" next to it in the browser's.
 *
 * So the rename dialog's chrome is generalized here rather than copied a
 * seventh time: `.file-delete-dialog` is the file-operation family's surface
 * (accent top rail, canonical header, right-aligned actions), and these are the
 * same family of question. `RenameDialog` is now a thin wrapper over
 * `TextPromptDialog`, so the two can no longer drift apart.
 *
 * Two ways to use them: mount a component directly when the dialog is a piece
 * of the view's state (what `RenameDialog` does), or call `useDialogs()` and
 * `await` it where a `window.prompt`/`confirm`/`alert` used to sit inline —
 * which keeps the straight-line shape of the handlers that had one.
 */

/** A `window.prompt` replacement. */
export type TextPromptSpec = {
  title: ReactNode;
  /** Prose above the field. Newlines survive (`.file-delete-body`). */
  body?: ReactNode;
  /** Field label — screen-reader only; the title carries the visible question. */
  label: string;
  /** Pre-filled value. */
  initial?: string;
  /** Confirm button text; defaults to "Save". */
  confirmLabel?: string;
  /** Select the stem instead of the whole value on focus — renaming a file
   *  almost never means renaming ".tsx". */
  selectStem?: boolean;
  /** A value that means "no change": confirm stays disabled while it is typed. */
  unchanged?: string;
  /** Accept an empty value (a lock reason, say) rather than requiring text. */
  allowEmpty?: boolean;
  /** Refuse a value with a message shown next to the field. */
  validate?: (value: string) => string | null;
};

/** A `window.confirm` replacement. */
export type ConfirmSpec = {
  title: ReactNode;
  body: ReactNode;
  /** Confirm button text; defaults to "OK". */
  confirmLabel?: string;
  /** Paints the confirm button as the destructive action. */
  danger?: boolean;
};

/** One entry of a pick-one question. */
export type ChoiceOption = {
  id: string;
  label: ReactNode;
  /** Secondary text beside the label (a branch name, a size). */
  detail?: ReactNode;
  /** Tooltip — the full path behind a short label. */
  hint?: string;
  /** The option Enter picks straight away; painted as the current one. */
  current?: boolean;
};

/** A pick-one question the browser never had a box for. */
export type ChoiceSpec = {
  title: ReactNode;
  body?: ReactNode;
  options: ChoiceOption[];
  /** The asking feature's row in the untested register (`lib/untested`):
   *  set → the title wears the pill until that row is stamped tested. */
  untested?: UntestedId;
};

/** A `window.alert` replacement. */
export type MessageSpec = {
  title: ReactNode;
  body: ReactNode;
  /** Reports a failure (the message rides the error box). */
  error?: boolean;
};

/** The dialog frame every one of these wears — portaled, backdrop-dismissed.
 *  Exported for a question too specific for the helpers below. */
export function DialogShell({
  onDismiss,
  children,
  className,
}: {
  onDismiss: () => void;
  children: ReactNode;
  /** Extra class beside `file-delete-dialog` (a wider box, say). */
  className?: string;
}) {
  const ref = useModalFocus(onDismiss);
  const titleId = useId();
  useLayoutEffect(() => {
    const heading = ref.current?.querySelector("h2");
    if (heading) heading.id = titleId;
  }, [ref, titleId]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div
        ref={ref}
        tabIndex={-1}
        aria-labelledby={titleId}
        className={className ? `file-delete-dialog ${className}` : "file-delete-dialog"}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
        <UntestedTag id="desktop.modalFocus" />
      </div>
    </div>,
    document.body,
  );
}

export function TextPromptDialog({
  title,
  body,
  label,
  initial = "",
  confirmLabel,
  selectStem = false,
  unchanged,
  allowEmpty = false,
  validate,
  onCancel,
  onSubmit,
}: TextPromptSpec & {
  onCancel: () => void;
  /** Performs the operation. Rejecting keeps the dialog open with the reason on
   *  it — the typed value is usually one character away from working, and
   *  closing would make the user type it again. Resolving leaves closing to the
   *  caller (which unmounts this). */
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = value.trim();
  const submittable = !busy && (allowEmpty || trimmed.length > 0) && trimmed !== unchanged;

  async function submit() {
    if (!submittable) return;
    const complaint = validate?.(trimmed) ?? null;
    if (complaint) {
      setError(complaint);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <DialogShell onDismiss={() => !busy && onCancel()}>
      <h2>{title}</h2>
      {body != null && <p className="file-delete-body">{body}</p>}
      <input
        className="file-paste-name"
        autoFocus
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={busy}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        onFocus={(e) => {
          const dot = selectStem ? initial.lastIndexOf(".") : -1;
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
      />
      {error && <ErrorNote id={errorId} role="alert" className="file-delete-path file-delete-error" error={error} />}
      <div className="file-delete-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button type="button" onClick={submit} disabled={!submittable}>
          {confirmLabel ?? t("common.save")}
        </button>
      </div>
    </DialogShell>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmSpec & { onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <DialogShell onDismiss={onCancel}>
      <h2>{title}</h2>
      <p className="file-delete-body">{body}</p>
      <div className="file-delete-actions">
        <button type="button" autoFocus={danger} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={danger ? "danger" : undefined}
          autoFocus={!danger}
          onClick={onConfirm}
        >
          {confirmLabel ?? t("common.ok")}
        </button>
      </div>
    </DialogShell>
  );
}

export function MessageDialog({
  title,
  body,
  error = false,
  onClose,
}: MessageSpec & { onClose: () => void }) {
  const t = useT();
  return (
    <DialogShell onDismiss={onClose}>
      <h2>{title}</h2>
      <p className={`file-delete-body${error ? " file-delete-error-text" : ""}`}>{body}</p>
      <div className="file-delete-actions">
        <button type="button" autoFocus onClick={onClose}>
          {t("common.ok")}
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * Pick one of a few named things. Each option is its own button — the whole
 * row, not a radio plus a confirm — because the question is always "which
 * one", never "are you sure": one click answers it, Escape or the backdrop
 * declines it. The `current` option takes focus so Enter is the default.
 */
export function ChoiceDialog({
  title,
  body,
  options,
  untested,
  onCancel,
  onPick,
}: ChoiceSpec & { onCancel: () => void; onPick: (id: string) => void }) {
  const t = useT();
  const focusId = options.find((o) => o.current)?.id ?? options[0]?.id;
  return (
    <DialogShell onDismiss={onCancel}>
      <h2>
        {title}
        {untested && <UntestedTag id={untested} />}
      </h2>
      {body != null && <p className="file-delete-body">{body}</p>}
      <div className="file-delete-choices" role="listbox" aria-label={typeof title === "string" ? title : undefined}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="option"
            aria-selected={!!o.current}
            className={`file-delete-choice${o.current ? " current" : ""}`}
            title={o.hint}
            autoFocus={o.id === focusId}
            onClick={() => onPick(o.id)}
          >
            <span className="file-delete-choice-label">{o.label}</span>
            {o.detail != null && <span className="file-delete-choice-detail">{o.detail}</span>}
          </button>
        ))}
      </div>
      <div className="file-delete-actions">
        <button type="button" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </DialogShell>
  );
}

type Pending =
  | { kind: "prompt"; spec: TextPromptSpec; run?: (v: string) => Promise<void>; done: (v: string | null) => void }
  | { kind: "confirm"; spec: ConfirmSpec; done: (v: boolean) => void }
  | { kind: "choice"; spec: ChoiceSpec; done: (v: string | null) => void }
  | { kind: "message"; spec: MessageSpec; done: () => void };

/**
 * `await`-able dialogs for handlers that used to call the browser's.
 *
 * One slot, not a queue: these are answers to a gesture the user just made, and
 * the flows that chain them (confirm → act → report) `await` each in turn, so a
 * second question can only exist once the first is answered.
 *
 * Mount `dialogs` once in the component's tree. `promptText` resolves to the
 * trimmed value or `null` if dismissed; pass `run` to perform the work from
 * inside the dialog, so a failure keeps it open with the typed value intact
 * instead of discarding it.
 */
export function useDialogs() {
  const [pending, setPending] = useState<Pending | null>(null);

  const promptText = useCallback(
    (spec: TextPromptSpec, run?: (value: string) => Promise<void>) =>
      new Promise<string | null>((resolve) =>
        setPending({ kind: "prompt", spec, run, done: resolve }),
      ),
    [],
  );
  const confirmAction = useCallback(
    (spec: ConfirmSpec) =>
      new Promise<boolean>((resolve) => setPending({ kind: "confirm", spec, done: resolve })),
    [],
  );
  const showMessage = useCallback(
    (spec: MessageSpec) =>
      new Promise<void>((resolve) => setPending({ kind: "message", spec, done: resolve })),
    [],
  );
  const chooseOption = useCallback(
    (spec: ChoiceSpec) =>
      new Promise<string | null>((resolve) =>
        setPending({ kind: "choice", spec, done: resolve }),
      ),
    [],
  );

  let dialogs: ReactNode = null;
  if (pending?.kind === "prompt") {
    const { spec, run, done } = pending;
    dialogs = (
      <TextPromptDialog
        {...spec}
        onCancel={() => {
          setPending(null);
          done(null);
        }}
        onSubmit={async (value) => {
          // Awaited *before* closing: a rejection is the dialog's to show.
          await run?.(value);
          setPending(null);
          done(value);
        }}
      />
    );
  } else if (pending?.kind === "confirm") {
    const { spec, done } = pending;
    dialogs = (
      <ConfirmDialog
        {...spec}
        onCancel={() => {
          setPending(null);
          done(false);
        }}
        onConfirm={() => {
          setPending(null);
          done(true);
        }}
      />
    );
  } else if (pending?.kind === "choice") {
    const { spec, done } = pending;
    dialogs = (
      <ChoiceDialog
        {...spec}
        onCancel={() => {
          setPending(null);
          done(null);
        }}
        onPick={(id) => {
          setPending(null);
          done(id);
        }}
      />
    );
  } else if (pending?.kind === "message") {
    const { spec, done } = pending;
    dialogs = (
      <MessageDialog
        {...spec}
        onClose={() => {
          setPending(null);
          done();
        }}
      />
    );
  }

  return { promptText, confirmAction, showMessage, chooseOption, dialogs };
}
