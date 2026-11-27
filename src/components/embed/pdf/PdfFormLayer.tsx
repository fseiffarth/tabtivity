/**
 * One sheet's form fields (#pdf-forms): a click target over each widget and, while a
 * text or choice field is being filled, its editor. The value itself is painted by
 * the page canvas from pdf.js's annotation storage (`formFields.ts`), so this layer
 * draws nothing of a field at rest except the optional tint.
 */
import { useEffect, useRef, useState } from "react";
import { bigPointsToCssRect } from "../../../lib/viewers/tex/tex";
import { useT } from "../../../lib/i18n";
import type { FormValue, PdfFormField } from "./formFields";
import type { FieldFocus } from "./usePdfForm";
import { scrollIntoPdfBox } from "./scrollBox";

/** The text a field shows while its sheet repaints with the committed value, so the
 *  old one does not flash up between the editor closing and the new pixels. */
interface Settling {
  id: string;
  text: string;
  paints: number;
}

export function PdfFormLayer({
  fields,
  scale,
  valueOf,
  highlight,
  focus,
  paints,
  onCommit,
  onStep,
  onSaveRequest,
}: {
  fields: readonly PdfFormField[];
  scale: number;
  valueOf: (field: PdfFormField) => FormValue;
  /** Tint every field (the toolbar's Highlight fields). */
  highlight: boolean;
  /** Tab landed on a field of this sheet: open it. */
  focus: FieldFocus | null;
  /** Bumped by every paint of the sheet's canvas — the end of a {@link Settling}. */
  paints: number;
  onCommit: (field: PdfFormField, value: FormValue) => void;
  onStep: (fromId: string, dir: 1 | -1) => void;
  /** Ctrl+S inside an editor: the value is committed first, then this saves. */
  onSaveRequest: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [settling, setSettling] = useState<Settling | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // The repaint with the new value has landed: the canvas shows it now.
  useEffect(() => {
    if (settling && paints > settling.paints) setSettling(null);
  }, [paints, settling]);

  // Tab arrived here. A text or choice field opens its editor; a box takes the focus
  // (Space toggles it, as on any check box). Consumed by nonce.
  useEffect(() => {
    if (!focus) return;
    const f = fields.find((x) => x.id === focus.id);
    if (!f) return;
    if (f.kind === "text" || f.kind === "choice") setEditing(f.id);
    else {
      const el = layerRef.current?.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(f.id)}"]`);
      el?.focus({ preventScroll: true });
      if (el && !inView(el)) scrollIntoPdfBox(el, "center");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, fields]);

  const finishText = (f: PdfFormField, text: string) => {
    setEditing(null);
    if (text !== valueOf(f)) {
      setSettling({ id: f.id, text, paints });
      onCommit(f, text);
    }
  };

  return (
    <div className={`file-viewer-pdf-form-layer${highlight ? " is-tinted" : ""}`} ref={layerRef}>
      {fields.map((f) => {
        const css = bigPointsToCssRect(f.rect, scale);
        const box = { left: css.left, top: css.top, width: css.width, height: css.height };
        const title = f.label || f.name || undefined;
        const value = valueOf(f);
        if (editing === f.id && f.kind === "text") {
          return (
            <TextEditor
              key={f.id}
              field={f}
              box={box}
              scale={scale}
              initial={typeof value === "string" ? value : ""}
              ariaLabel={title ?? t("pdfForm.fieldLabel")}
              onDone={(text) => finishText(f, text)}
              onCancel={() => setEditing(null)}
              onTab={(text, dir) => {
                finishText(f, text);
                onStep(f.id, dir);
              }}
              onSave={(text) => {
                finishText(f, text);
                window.setTimeout(onSaveRequest, 0);
              }}
            />
          );
        }
        if (editing === f.id && f.kind === "choice") {
          return (
            <ChoiceEditor
              key={f.id}
              field={f}
              box={box}
              scale={scale}
              initial={Array.isArray(value) ? value : []}
              ariaLabel={title ?? t("pdfForm.fieldLabel")}
              onDone={(v) => {
                setEditing(null);
                onCommit(f, v);
              }}
              onCancel={() => setEditing(null)}
              onTab={(v, dir) => {
                setEditing(null);
                onCommit(f, v);
                onStep(f.id, dir);
              }}
            />
          );
        }
        const on = value === true;
        return (
          <span key={f.id} className="file-viewer-pdf-field-slot" style={box}>
            <button
              type="button"
              data-field-id={f.id}
              className={`file-viewer-pdf-field is-${f.kind}${f.required ? " is-required" : ""}`}
              title={title}
              aria-label={title ?? t("pdfForm.fieldLabel")}
              role={f.kind === "checkbox" ? "checkbox" : f.kind === "radio" ? "radio" : undefined}
              aria-checked={f.kind === "checkbox" || f.kind === "radio" ? on : undefined}
              onClick={(e) => {
                // Ctrl/⌘ is reverse search over the whole page (the link layer's rule).
                if (e.ctrlKey || e.metaKey) return;
                if (f.kind === "checkbox") onCommit(f, !on);
                else if (f.kind === "radio") onCommit(f, true);
                else setEditing(f.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  e.stopPropagation();
                  onStep(f.id, e.shiftKey ? -1 : 1);
                }
              }}
            />
            {settling?.id === f.id && (
              <span
                className={`file-viewer-pdf-field-settling${f.multiLine ? " is-multiline" : ""}`}
                style={textStyle(f, css.height, scale)}
                aria-hidden="true"
              >
                {f.password ? "•".repeat(settling.text.length) : settling.text}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Is `el` inside the reader's scroll box's visible area? */
function inView(el: HTMLElement): boolean {
  const box = el.closest<HTMLElement>(".file-viewer-pdf-scroll");
  if (!box) return true;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return r.top >= b.top && r.bottom <= b.bottom && r.left >= b.left && r.right <= b.right;
}

/** The editor's type size: the field's own, or — for an auto-sized field (0) — what
 *  fits its height, the way pdf.js sizes the appearance it paints. */
function textStyle(f: PdfFormField, cssHeight: number, scale: number): React.CSSProperties {
  const auto = f.multiLine ? 12 * scale : Math.max(8, cssHeight * 0.66);
  const size = f.fontSize ? Math.min(f.fontSize * scale, f.multiLine ? Infinity : cssHeight) : auto;
  return {
    fontSize: `${size}px`,
    textAlign: f.align === 1 ? "center" : f.align === 2 ? "right" : "left",
  };
}

type Box = { left: number; top: number; width: number; height: number };

function TextEditor({
  field,
  box,
  scale,
  initial,
  ariaLabel,
  onDone,
  onCancel,
  onTab,
  onSave,
}: {
  field: PdfFormField;
  box: Box;
  scale: number;
  initial: string;
  ariaLabel: string;
  onDone: (text: string) => void;
  onCancel: () => void;
  onTab: (text: string, dir: 1 | -1) => void;
  onSave: (text: string) => void;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // The editor closes exactly once: Enter, Tab, Escape or Ctrl+S already did it
  // when the blur that follows unmounting arrives.
  const closed = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
    if (!inView(el)) scrollIntoPdfBox(el, "center");
  }, []);
  const close = (fn: () => void) => {
    if (closed.current) return;
    closed.current = true;
    fn();
  };
  const common = {
    ref,
    className: `file-viewer-pdf-field-editor${field.multiLine ? " is-multiline" : ""}`,
    style: { ...box, ...textStyle(field, box.height, scale) },
    defaultValue: initial,
    "aria-label": ariaLabel,
    spellCheck: false,
    ...(field.maxLen ? { maxLength: field.maxLen } : {}),
    onBlur: () => close(() => onDone(ref.current?.value ?? initial)),
    onKeyDown: (e: React.KeyboardEvent) => {
      const text = ref.current?.value ?? initial;
      if (e.key === "Escape") {
        // Stops here: the viewer's own Escape (close find, leave a tool) is not what
        // a reader backing out of a field means.
        e.preventDefault();
        e.stopPropagation();
        close(onCancel);
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        close(() => onTab(text, e.shiftKey ? -1 : 1));
      } else if (e.key === "Enter" && !field.multiLine) {
        e.preventDefault();
        close(() => onDone(text));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        close(() => onSave(text));
      }
    },
  };
  return field.multiLine ? (
    <textarea {...common} />
  ) : (
    <input {...common} type={field.password ? "password" : "text"} />
  );
}

function ChoiceEditor({
  field,
  box,
  scale,
  initial,
  ariaLabel,
  onDone,
  onCancel,
  onTab,
}: {
  field: PdfFormField;
  box: Box;
  scale: number;
  initial: readonly string[];
  ariaLabel: string;
  onDone: (value: string[]) => void;
  onCancel: () => void;
  onTab: (value: string[], dir: 1 | -1) => void;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const selected = () =>
    // The blank row a field with nothing chosen opens on is not a choice.
    Array.from(ref.current?.selectedOptions ?? []).map((o) => o.value).filter((v) => v !== "");
  const close = (fn: () => void) => {
    if (closed.current) return;
    closed.current = true;
    fn();
  };
  const listBox = !field.combo;
  return (
    <select
      ref={ref}
      className="file-viewer-pdf-field-editor is-choice"
      style={{ ...box, fontSize: `${Math.max(10, Math.min(14 * scale, box.height * 0.7))}px` }}
      aria-label={ariaLabel}
      multiple={field.multiSelect}
      size={listBox ? Math.max(2, Math.min(field.options?.length ?? 2, 8)) : undefined}
      defaultValue={field.multiSelect ? [...initial] : initial[0] ?? ""}
      onChange={() => {
        // A drop-down or a single-choice list is done the moment a row is picked; a
        // multi-select list stays open for more rows and is committed on leaving.
        if (!field.multiSelect) close(() => onDone(selected()));
      }}
      onBlur={() => close(() => onDone(selected()))}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(onCancel);
        } else if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          close(() => onTab(selected(), e.shiftKey ? -1 : 1));
        }
      }}
    >
      {!field.multiSelect && !initial.length && <option value="" />}
      {(field.options ?? []).map((o, i) => (
        <option key={`${i}:${o.value}`} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
