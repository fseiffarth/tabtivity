/**
 * The PDF's own form fields (#pdf-forms): which widgets the viewer lets the reader
 * fill, where they sit, what they hold, and what one edit writes.
 *
 * One truth for a value: the document's pdf.js **annotation storage**. The page
 * render already runs in `ENABLE_STORAGE` (`ANNOT_MODE`), and in that mode pdf.js
 * paints a text field, a choice and a check box FROM the storage — so a value set
 * there is drawn on the canvas, in the field's own font and appearance, by the same
 * code that will later write it into the file (`applyFormValues` in `pdfDoc.ts`).
 * The layer over the page (`PdfFormLayer`) is only a click target and, while a
 * field is being typed into, an editor; it never paints a value of its own.
 *
 * What is NOT here, deliberately: a field's JavaScript (format, keystroke,
 * calculate, validate actions) never runs — the viewer runs no script a document
 * carries — so a field that formats its value in Acrobat keeps what was typed.
 * Push buttons (they are only actions) and signature fields are not offered.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SyncRect } from "../../../lib/viewers/tex/tex";
import { rectFromAnnotation, type RectViewport } from "./links";

/** What a field is, as far as filling it goes. */
export type PdfFieldKind = "text" | "checkbox" | "radio" | "choice";

/**
 * A field's value in the shape pdf.js's annotation storage takes it (`{ value }`):
 * a text field's string; a check box's or one radio widget's on/off; a choice's
 * selected export values (one for a combo box).
 */
export type FormValue = string | boolean | readonly string[];

/** One fillable widget on a sheet. A field shown in two places (the same name on
 *  two pages) is two of these, with one `name`. */
export interface PdfFormField {
  /** pdf.js's annotation id — the storage key, and stable across the in-place
   *  saves this viewer makes (neither writer renumbers an existing object). */
  id: string;
  /** The fully qualified field name; widgets sharing one hold one value. */
  name: string;
  kind: PdfFieldKind;
  /** Big points from the sheet's top-left, in its TURNED space — the link layer's
   *  space, multiplied into CSS pixels by `bigPointsToCssRect`. */
  rect: SyncRect;
  /** The value in the file, before anything was typed. */
  initial: FormValue;
  multiLine?: boolean;
  /** Characters a text field accepts; absent = no limit. */
  maxLen?: number;
  password?: boolean;
  /** A check box's or radio widget's "on" export value. */
  onValue?: string;
  /** A choice field's options, in the file's order. */
  options?: readonly { value: string; label: string }[];
  /** A drop-down (as opposed to a list box). */
  combo?: boolean;
  multiSelect?: boolean;
  /** The field's own font size in points; 0 or absent = auto. */
  fontSize?: number;
  /** 0 left, 1 centred, 2 right. */
  align?: 0 | 1 | 2;
  /** The field's tooltip (`/TU`). */
  label?: string;
  required?: boolean;
}

/** The slice of a pdf.js annotation record a field is read from. */
export interface RawWidget {
  id?: string;
  annotationType?: number;
  subtype?: string;
  rect?: number[];
  fieldType?: string | null;
  fieldName?: string;
  fieldValue?: unknown;
  readOnly?: boolean;
  hidden?: boolean;
  multiLine?: boolean;
  maxLen?: number;
  password?: boolean;
  comb?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string | null;
  options?: { exportValue?: string; displayValue?: string }[];
  combo?: boolean;
  multiSelect?: boolean;
  textAlignment?: number | null;
  defaultAppearanceData?: { fontSize?: number };
  alternativeText?: string;
  required?: boolean;
}

/** One widget as `getFieldObjects()` lists it, which is the only view of a field's
 *  OTHER widgets — the ones on sheets nobody has scrolled to. */
export interface FieldObjectRef {
  id: string;
  type: string;
  exportValues?: string;
  page?: number;
}

/** Field name → its widgets, document-wide. */
export type FieldIndex = ReadonlyMap<string, readonly FieldObjectRef[]>;

/** The `getFieldObjects()` types a reader can fill. */
const FILLABLE_TYPES = new Set(["text", "checkbox", "radiobutton", "combobox", "listbox"]);

/** A widget too small to hit is not offered (a producer's 0×0 placeholder). */
const MIN_FIELD_SIDE = 2;

/**
 * Read one annotation record into a field, or `null` when it is not one a reader
 * can fill: not a widget, a push button, a signature, read-only, hidden, or with
 * no usable box. Pure.
 */
export function fieldFromAnnotation(
  pageNumber: number,
  raw: RawWidget,
  viewport: RectViewport,
): PdfFormField | null {
  if (raw.subtype !== "Widget" || !raw.id || !Array.isArray(raw.rect) || raw.rect.length < 4) {
    return null;
  }
  if (raw.readOnly || raw.hidden) return null;
  const kind = kindOf(raw);
  if (!kind) return null;
  const rect = rectFromAnnotation(pageNumber, raw.rect, viewport);
  if (rect.w < MIN_FIELD_SIDE || rect.h < MIN_FIELD_SIDE) return null;
  const base = {
    id: raw.id,
    name: raw.fieldName ?? "",
    kind,
    rect,
    initial: initialValue(kind, raw),
    ...(raw.alternativeText ? { label: raw.alternativeText } : {}),
    ...(raw.required ? { required: true } : {}),
  };
  const fontSize = raw.defaultAppearanceData?.fontSize;
  switch (kind) {
    case "text":
      return {
        ...base,
        ...(raw.multiLine ? { multiLine: true } : {}),
        ...(typeof raw.maxLen === "number" && raw.maxLen > 0 ? { maxLen: raw.maxLen } : {}),
        ...(raw.password ? { password: true } : {}),
        ...(typeof fontSize === "number" && fontSize > 0 ? { fontSize } : {}),
        ...(raw.textAlignment === 1 || raw.textAlignment === 2 ? { align: raw.textAlignment } : {}),
      };
    case "checkbox":
      return { ...base, onValue: raw.exportValue ?? "Yes" };
    case "radio":
      return { ...base, onValue: raw.buttonValue ?? "" };
    case "choice":
      return {
        ...base,
        options: (raw.options ?? []).map((o) => ({
          value: o.exportValue ?? o.displayValue ?? "",
          label: o.displayValue ?? o.exportValue ?? "",
        })),
        ...(raw.combo ? { combo: true } : {}),
        ...(raw.multiSelect && !raw.combo ? { multiSelect: true } : {}),
        ...(typeof fontSize === "number" && fontSize > 0 ? { fontSize } : {}),
      };
  }
}

function kindOf(raw: RawWidget): PdfFieldKind | null {
  switch (raw.fieldType) {
    case "Tx":
      // A comb field (one character per box) is a text field all the same; pdf.js
      // draws the boxes from the value.
      return "text";
    case "Btn":
      if (raw.pushButton) return null;
      if (raw.checkBox) return "checkbox";
      if (raw.radioButton) return "radio";
      return null;
    case "Ch":
      return "choice";
    default:
      // "Sig" and anything unknown.
      return null;
  }
}

/** The value a field holds in the file — pdf.js's own reading of it, the one its
 *  render falls back to when the storage has nothing. */
export function initialValue(kind: PdfFieldKind, raw: RawWidget): FormValue {
  switch (kind) {
    case "text":
      return typeof raw.fieldValue === "string" ? raw.fieldValue : "";
    case "checkbox":
      return raw.fieldValue != null && raw.fieldValue === raw.exportValue;
    case "radio":
      return raw.fieldValue != null && raw.buttonValue != null && raw.fieldValue === raw.buttonValue;
    case "choice":
      if (Array.isArray(raw.fieldValue)) return raw.fieldValue.filter((v): v is string => typeof v === "string");
      return typeof raw.fieldValue === "string" && raw.fieldValue ? [raw.fieldValue] : [];
  }
}

/** Two values are the same edit (so committing one changes nothing). */
export function sameFormValue(a: FormValue | undefined, b: FormValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * Every storage write one edit makes: the widget itself and each other widget of the
 * same field, document-wide, so a name shown on two pages shows the same value on
 * both and a radio group keeps one button on. Pure.
 *
 * - text and choice: every widget of the field takes the value.
 * - a check box: checking it turns on the widgets with the same export value and off
 *   the ones with another (check boxes that share a name and differ in export value
 *   are how many forms build a radio group); unchecking turns the field off.
 * - a radio button: it and any twin with its export value go on, the rest off.
 */
export function fieldWrites(
  field: Pick<PdfFormField, "id" | "name" | "kind" | "onValue">,
  value: FormValue,
  index: FieldIndex,
): Map<string, FormValue> {
  const out = new Map<string, FormValue>([[field.id, value]]);
  const siblings = (index.get(field.name) ?? []).filter((s) => s.id !== field.id);
  for (const s of siblings) {
    switch (field.kind) {
      case "text":
        if (s.type === "text") out.set(s.id, value);
        break;
      case "choice":
        if (s.type === "combobox" || s.type === "listbox") out.set(s.id, value);
        break;
      case "checkbox":
        if (s.type === "checkbox") out.set(s.id, value === true && s.exportValues === field.onValue);
        break;
      case "radio":
        if (s.type === "radiobutton") {
          out.set(s.id, value === true ? s.exportValues === field.onValue : false);
        }
        break;
    }
  }
  return out;
}

/** What `getFieldObjects()` resolves to. pdf.js 6 hands back a `Map` (field name →
 *  widgets); the typings, and older builds, say a plain record — both are read. */
export type FieldObjects = ReadonlyMap<string, unknown[]> | Record<string, unknown[]> | null | undefined;

/** The name → widgets pairs of a {@link FieldObjects}, whichever shape it came in. */
export function fieldEntries(objects: FieldObjects): [string, unknown[]][] {
  if (!objects) return [];
  const pairs = objects instanceof Map ? [...objects.entries()] : Object.entries(objects);
  return pairs.filter((p): p is [string, unknown[]] => Array.isArray(p[1]));
}

/**
 * The document's field index from `getFieldObjects()`, holding only widgets a
 * reader can fill. `null` when the document has none, which is what keeps every
 * form control out of an ordinary paper's toolbar.
 */
export function fieldIndexOf(objects: FieldObjects): FieldIndex | null {
  const index = new Map<string, FieldObjectRef[]>();
  for (const [name, list] of fieldEntries(objects)) {
    const kept: FieldObjectRef[] = [];
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const rec = o as { id?: unknown; type?: unknown; exportValues?: unknown; page?: unknown; editable?: unknown };
      if (typeof rec.id !== "string" || typeof rec.type !== "string") continue;
      if (!FILLABLE_TYPES.has(rec.type)) continue;
      kept.push({
        id: rec.id,
        type: rec.type,
        ...(typeof rec.exportValues === "string" ? { exportValues: rec.exportValues } : {}),
        ...(typeof rec.page === "number" ? { page: rec.page } : {}),
      });
    }
    if (kept.length > 0) index.set(name, kept);
  }
  return index.size > 0 ? index : null;
}

/** Fields in the order a reader moves through them with Tab: top to bottom, then
 *  left to right, rows matched within a few points so a row of boxes whose tops
 *  differ by a hair is still one row. Pure; sorts a copy. */
export function tabOrder<T extends { rect: SyncRect }>(fields: readonly T[]): T[] {
  const ROW = 4;
  return [...fields].sort((a, b) => {
    if (Math.abs(a.rect.y - b.rect.y) > ROW) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });
}

/** Where Tab (`dir` 1) or Shift+Tab (-1) goes from position `at` in a list of `len`
 *  fields: round the end, and from nowhere (`at` -1) to the first or the last. Pure. */
export function stepIndex(at: number, dir: 1 | -1, len: number): number {
  if (len <= 0) return -1;
  if (at < 0) return dir > 0 ? 0 : len - 1;
  return (((at + dir) % len) + len) % len;
}

/** pdf.js's annotation type number for a widget. */
const WIDGET = 20;

/**
 * Read a sheet's fillable fields. `rot` is the viewer's turn on top of the page's
 * own `/Rotate`, the link layer's convention. A failed read (a document mid-
 * recompile) is no fields rather than an error: the page just carries no layer.
 */
export async function loadPageFields(
  doc: PDFDocumentProxy,
  pageNumber: number,
  rot = 0,
): Promise<PdfFormField[]> {
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({
      scale: 1,
      rotation: (((page.rotate + rot) % 360) + 360) % 360,
    });
    const raws = (await page.getAnnotations({ intent: "display" })) as RawWidget[];
    const fields: PdfFormField[] = [];
    for (const raw of raws) {
      if (raw.annotationType !== WIDGET && raw.subtype !== "Widget") continue;
      const f = fieldFromAnnotation(pageNumber, { ...raw, subtype: "Widget" }, viewport);
      if (f) fields.push(f);
    }
    return tabOrder(fields);
  } catch {
    return [];
  }
}
