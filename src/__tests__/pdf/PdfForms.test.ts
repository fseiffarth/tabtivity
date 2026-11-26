/**
 * Filling a PDF form (#pdf-forms): which widgets become fields, what one edit writes,
 * the Tab order, and — end to end through pdf-lib — what a save does with the form.
 *
 * The save half is the one that matters most: an unrearranged save must EDIT the
 * file, so the form (and everything else in the catalog) survives; a rearranged save
 * must burn the fields in rather than leave orphan widgets nobody can fill.
 */
import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib";
import {
  appearanceToRect,
  buildPdf,
  flattenFormFields,
  type FormApplier,
  type PdfSources,
} from "../../components/embed/pdf/pdfDoc";
import {
  fieldFromAnnotation,
  fieldIndexOf,
  fieldWrites,
  sameFormValue,
  stepIndex,
  tabOrder,
  type FieldIndex,
  type FormValue,
  type RawWidget,
} from "../../components/embed/pdf/formFields";
import { SELF, initialPages, movePages, type PdfNote } from "../../lib/viewers/pageModel";
import { addNote } from "../../lib/viewers/pdfNotes";
import type { RectViewport } from "../../components/embed/pdf/links";

/** A scale-1, unturned viewport over a 400bp-tall page. */
const viewport: RectViewport = { convertToViewportPoint: (x, y) => [x, 400 - y] };

const widget = (over: Partial<RawWidget> = {}): RawWidget => ({
  id: "10R",
  annotationType: 20,
  subtype: "Widget",
  rect: [50, 300, 250, 320],
  fieldType: "Tx",
  fieldName: "name",
  fieldValue: "",
  ...over,
});

describe("which widgets are fields", () => {
  it("reads a text field with its box flipped to the page's top-left", () => {
    const f = fieldFromAnnotation(1, widget({ fieldValue: "Ada", maxLen: 20, multiLine: true }), viewport);
    expect(f).toMatchObject({
      id: "10R",
      name: "name",
      kind: "text",
      initial: "Ada",
      maxLen: 20,
      multiLine: true,
      rect: { page: 1, x: 50, y: 80, w: 200, h: 20 },
    });
  });

  it("reads check boxes, radio buttons and choices with their values", () => {
    expect(
      fieldFromAnnotation(1, widget({ fieldType: "Btn", checkBox: true, exportValue: "Yes", fieldValue: "Yes" }), viewport),
    ).toMatchObject({ kind: "checkbox", onValue: "Yes", initial: true });
    expect(
      fieldFromAnnotation(1, widget({ fieldType: "Btn", radioButton: true, buttonValue: "b", fieldValue: "a" }), viewport),
    ).toMatchObject({ kind: "radio", onValue: "b", initial: false });
    expect(
      fieldFromAnnotation(
        1,
        widget({
          fieldType: "Ch",
          combo: true,
          fieldValue: ["DE"],
          options: [{ exportValue: "DE", displayValue: "Germany" }, { exportValue: "FR", displayValue: "France" }],
        }),
        viewport,
      ),
    ).toMatchObject({
      kind: "choice",
      combo: true,
      initial: ["DE"],
      options: [{ value: "DE", label: "Germany" }, { value: "FR", label: "France" }],
    });
  });

  it("offers nothing a reader cannot fill", () => {
    expect(fieldFromAnnotation(1, widget({ readOnly: true }), viewport)).toBeNull();
    expect(fieldFromAnnotation(1, widget({ hidden: true }), viewport)).toBeNull();
    expect(fieldFromAnnotation(1, widget({ fieldType: "Sig" }), viewport)).toBeNull();
    expect(fieldFromAnnotation(1, widget({ fieldType: "Btn", pushButton: true }), viewport)).toBeNull();
    expect(fieldFromAnnotation(1, widget({ subtype: "Link" }), viewport)).toBeNull();
    expect(fieldFromAnnotation(1, widget({ rect: [10, 10, 10.5, 30] }), viewport)).toBeNull();
  });
});

describe("what one edit writes", () => {
  const index: FieldIndex = new Map([
    ["name", [{ id: "1R", type: "text" }, { id: "2R", type: "text" }]],
    [
      "size",
      [
        { id: "3R", type: "radiobutton", exportValues: "S" },
        { id: "4R", type: "radiobutton", exportValues: "M" },
        { id: "5R", type: "radiobutton", exportValues: "L" },
      ],
    ],
    [
      "pick",
      [
        { id: "6R", type: "checkbox", exportValues: "A" },
        { id: "7R", type: "checkbox", exportValues: "B" },
      ],
    ],
  ]);

  it("gives a name shown twice the same text on both widgets", () => {
    const w = fieldWrites({ id: "1R", name: "name", kind: "text" }, "Ada", index);
    expect([...w]).toEqual([["1R", "Ada"], ["2R", "Ada"]]);
  });

  it("keeps one radio button of a group on", () => {
    const w = fieldWrites({ id: "4R", name: "size", kind: "radio", onValue: "M" }, true, index);
    expect(Object.fromEntries(w)).toEqual({ "4R": true, "3R": false, "5R": false });
  });

  it("treats same-named check boxes with different export values as a group", () => {
    const on = fieldWrites({ id: "6R", name: "pick", kind: "checkbox", onValue: "A" }, true, index);
    expect(Object.fromEntries(on)).toEqual({ "6R": true, "7R": false });
    const off = fieldWrites({ id: "6R", name: "pick", kind: "checkbox", onValue: "A" }, false, index);
    expect(Object.fromEntries(off)).toEqual({ "6R": false, "7R": false });
  });

  it("compares choice values by content", () => {
    expect(sameFormValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameFormValue(["a"], ["b"])).toBe(false);
    expect(sameFormValue("x", "x")).toBe(true);
  });
});

describe("the document's field index", () => {
  it("keeps only fillable widgets, and is null for a document with none", () => {
    expect(fieldIndexOf(null)).toBeNull();
    // hyperref writes an /AcroForm with nothing a reader can fill.
    expect(fieldIndexOf({ btn: [{ id: "1R", type: "button" }], sig: [{ id: "2R", type: "signature" }] })).toBeNull();
    const idx = fieldIndexOf({ a: [{ id: "3R", type: "text", page: 0 }, { id: "4R", type: "button" }] });
    expect(idx?.get("a")).toEqual([{ id: "3R", type: "text", page: 0 }]);
  });

  it("reads the Map pdf.js 6 actually returns, not only the record its typings promise", () => {
    const idx = fieldIndexOf(new Map([["a", [{ id: "3R", type: "checkbox", exportValues: "Yes" }]]]));
    expect(idx?.get("a")).toEqual([{ id: "3R", type: "checkbox", exportValues: "Yes" }]);
  });
});

describe("moving through the fields", () => {
  it("steps round the end, and from nowhere to the first or the last", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });

  it("orders a row of boxes left to right even when their tops differ by a hair", () => {
    const at = (x: number, y: number) => ({ rect: { page: 1, x, y, w: 10, h: 10 }, x });
    expect(tabOrder([at(200, 101), at(20, 100), at(20, 200)]).map((f) => f.x)).toEqual([20, 200, 20]);
  });
});

describe("where a widget's appearance is drawn when flattened", () => {
  it("maps the appearance's box onto the widget's rect", () => {
    expect(appearanceToRect([10, 10, 110, 30], [0, 0, 100, 20])).toEqual([1, 0, 0, 1, 10, 10]);
    expect(appearanceToRect([0, 0, 50, 10], [0, 0, 100, 20])).toEqual([0.5, 0, 0, 0.5, 0, 0]);
  });

  it("follows the appearance's own matrix (a field turned a quarter)", () => {
    // BBox 100×20 turned 90° by its matrix occupies x ∈ [-20, 0], y ∈ [0, 100].
    expect(appearanceToRect([0, 0, 20, 100], [0, 0, 100, 20], [0, 1, -1, 0, 0, 0])).toEqual([1, 0, 0, 1, 20, 0]);
  });

  it("refuses a degenerate box", () => {
    expect(appearanceToRect([0, 0, 0, 10], [0, 0, 100, 20])).toBeUndefined();
  });
});

// ── Saving a form ───────────────────────────────────────────────────────────

/** A two-page PDF with a text field and a check box on page 1. */
async function makeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  doc.addPage([200, 400]);
  const form = doc.getForm();
  const name = form.createTextField("name");
  name.setText("Ada");
  name.addToPage(page, { x: 50, y: 300, width: 200, height: 20 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 50, y: 250, width: 12, height: 12 });
  agree.check();
  return doc.save();
}

const sourcesOf = (entries: Record<string, Uint8Array>): PdfSources =>
  new Map(Object.entries(entries).map(([id, bytes]) => [id, { bytes, doc: undefined as never }]));

const flatViewport = (h: number) => ({ convertToPdfPoint: (x: number, y: number) => [x, h - y] as [number, number] });

const note = (over: Partial<PdfNote> = {}): PdfNote => ({ id: "n1", x: 100, y: 50, text: "mine", ...over });

async function fieldNames(bytes: Uint8Array): Promise<string[]> {
  return (await PDFDocument.load(bytes)).getForm().getFields().map((f) => f.getName());
}

function widgetsOn(doc: PDFDocument, pageIndex: number): number {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return 0;
  let n = 0;
  for (let i = 0; i < annots.size(); i++) {
    const el = annots.get(i);
    const d = el instanceof PDFRef ? doc.context.lookupMaybe(el, PDFDict) : el;
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Widget")) n++;
  }
  return n;
}

describe("saving a form", () => {
  it("keeps the form fillable when a remark is saved on an unrearranged file", async () => {
    const sources = sourcesOf({ [SELF]: await makeForm() });
    const pages = initialPages(2);
    const edited = addNote(pages, pages[0].id, [], note());

    const bytes = await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) });

    // The rebuild this replaces wrote a fresh catalog: no /AcroForm, so no fields.
    expect(await fieldNames(bytes)).toEqual(["name", "agree"]);
    const doc = await PDFDocument.load(bytes);
    expect(widgetsOn(doc, 0)).toBe(2);
  });

  it("keeps the author's document info on an in-place save", async () => {
    const src = await PDFDocument.create({ updateMetadata: false });
    src.addPage([300, 400]);
    src.setAuthor("Someone");
    src.setProducer("Their TeX");
    const sources = sourcesOf({ [SELF]: await src.save() });
    const pages = initialPages(1);
    const edited = addNote(pages, pages[0].id, [], note());

    const out = await PDFDocument.load(
      await buildPdf(edited, sources, { noteViewport: async () => flatViewport(400) }),
      { updateMetadata: false },
    );
    expect(out.getAuthor()).toBe("Someone");
    expect(out.getProducer()).toBe("Their TeX");
  });

  it("writes typed values through the form applier, and nothing else when only they are pending", async () => {
    const original = await makeForm();
    const sources = sourcesOf({ [SELF]: original });
    const calls: [Uint8Array, ReadonlyMap<string, FormValue>][] = [];
    const marker = new Uint8Array([1, 2, 3]);
    const applyForm: FormApplier = async (b, v) => {
      calls.push([b, v]);
      return marker;
    };
    const values = new Map<string, FormValue>([["12R", "Grace"]]);

    const bytes = await buildPdf(initialPages(2), sources, { formValues: values, applyForm });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(original);
    expect(calls[0][1]).toBe(values);
    // Form values alone: pdf.js's incremental update is the file, untouched by pdf-lib.
    expect(bytes).toBe(marker);
  });

  it("burns the fields in on a rearranged save, values and all", async () => {
    const sources = sourcesOf({ [SELF]: await makeForm() });
    const pages = initialPages(2);
    const moved = movePages(pages, [pages[1].id], 0);
    let applied = false;

    const bytes = await buildPdf(moved, sources, {
      formValues: new Map([["x", "y"]]),
      applyForm: async (b) => {
        applied = true;
        return b;
      },
    });

    expect(applied).toBe(true);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([200, 300]);
    // No form, no widgets — and the appearances are now page content.
    expect(doc.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
    expect(widgetsOn(doc, 1)).toBe(0);
    const xobjects = doc.getPage(1).node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const flat = xobjects?.keys().filter((k) => k.asString().startsWith("/FlatWidget")) ?? [];
    expect(flat.length).toBe(2);
    // …drawn by the page: it has a content stream now, where it had none.
    const contents = doc.getPage(1).node.Contents();
    expect(contents instanceof PDFArray && contents.size() >= 1).toBe(true);
  });
});

describe("flattening a form in place", () => {
  it("wraps the page's own content so its graphics state cannot move the widgets", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    page.drawRectangle({ x: 0, y: 0, width: 10, height: 10 });
    const field = doc.getForm().createTextField("name");
    field.setText("Ada");
    field.addToPage(page, { x: 50, y: 300, width: 200, height: 20 });
    const loaded = await PDFDocument.load(await doc.save());
    const before = (loaded.getPage(0).node.Contents() as PDFArray | undefined)?.size() ?? 1;

    expect(flattenFormFields(loaded)).toBe(1);
    // q · the page's own streams · Q + the widget drawing.
    expect((loaded.getPage(0).node.Contents() as PDFArray).size()).toBeGreaterThanOrEqual(before + 2);
    expect(widgetsOn(loaded, 0)).toBe(0);
  });

  it("drops widgets with nothing to show instead of failing the whole form", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const form = doc.getForm();
    form.createTextField("empty").addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    const loaded = await PDFDocument.load(await doc.save());
    // Strip the appearance pdf-lib generated: an empty field in most real forms has none.
    const annots = loaded.getPage(0).node.Annots()!;
    for (let i = 0; i < annots.size(); i++) {
      const d = loaded.context.lookupMaybe(annots.get(i) as PDFRef, PDFDict);
      d?.delete(PDFName.of("AP"));
    }

    expect(flattenFormFields(loaded)).toBe(1);
    expect(widgetsOn(loaded, 0)).toBe(0);
  });
});
