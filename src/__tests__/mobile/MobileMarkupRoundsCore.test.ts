/**
 * Markup rounds, the pure half (`docs/pdf_markup_rounds_plan.md` §2.1–2.2):
 * a Submit moves its marks to the layer's sent side, which only the reader
 * clears (eraser, Clear page, Clear sent marks), never a Submit or a Reload; the phone-only store keeps a sent-only record, still
 * reads records from before rounds, and moves a layer to a newer file; and the
 * round's pill machine follows the agent.
 */
import { describe, expect, it } from "vitest";

import {
  addMark, clearPage, clearSent, EMPTY_LAYER, eraseAt, hasSent, isLayer, LIMITS, markCount, markedPages, markSent, moveNote, noteAt, replaceMark,
  type InkMark, type Layer, type TextMark,
} from "../../../mobile-web/src/markup/layer";
import { layerKey, loadLayer, moveLayer, saveLayer, SENT_LIMITS, withinLimits, type LayerBackend } from "../../../mobile-web/src/markup/store";
import { canApply, canUndo, CONFIRM_MS, followRound, nextCheck, SETTLE_MS, startRound, stepRound, holdsUndo, undoneRound, undoSummary, type AgentSignal, type Round } from "../../../mobile-web/src/markup/submitState";
import {
  DEFAULT_MARKUP_APPLY_INSTRUCTION, DEFAULT_MARKUP_INSTRUCTION, defaultMarkupInstruction, markupUndoNote, readMarkupDirect, readMarkupInstruction, writeMarkupDirect, writeMarkupInstruction,
} from "../../../mobile-web/src/markupInstruction";
import { translate, type TranslationKey } from "../../lib/i18n";

const SIZE: [number, number] = [612, 792];
const ink = (points: [number, number, number][]): InkMark => ({ kind: "ink", color: "red", width: 2, points });
const note = (text: string, at: [number, number] = [100, 100]): TextMark => ({ kind: "text", color: "black", at, size: 20, text });

const memory = (): LayerBackend & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k), put: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
};

describe("markup rounds · layer", () => {
  it("moves a round's marks to the sent side and counts the rounds", () => {
    let layer = addMark(EMPTY_LAYER, 1, SIZE, ink([[10, 10, 0.5], [20, 20, 0.5]]));
    layer = addMark(layer, 2, SIZE, { kind: "box", color: "yellow", rect: [5, 5, 50, 10] });
    const first = markSent(layer);
    expect(first.pages).toEqual({});
    expect(first.sent).toEqual({ pages: layer.pages, rounds: 1 });
    expect(hasSent(first)).toBe(true);
    expect(markedPages(first)).toEqual([]);
    // The next round's marks join the earlier ones on the same page.
    const next = addMark(first, 1, SIZE, ink([[30, 30, 0.5]]));
    expect(next.sent).toBe(first.sent);
    const second = markSent(next);
    expect(second.sent?.rounds).toBe(2);
    expect(second.sent?.pages[1].marks).toHaveLength(2);
    expect(second.sent?.pages[2].marks).toHaveLength(1);
    // Nothing unsent: nothing moves, not even the round count.
    expect(markSent(second)).toBe(second);
  });

  it("moves only the pages a Submit carried; the rest stay unsent", () => {
    let layer = addMark(EMPTY_LAYER, 1, SIZE, ink([[1, 1, 0.5]]));
    layer = addMark(layer, 9, SIZE, ink([[2, 2, 0.5]]));
    const sent = markSent(layer, [1]);
    expect(markedPages(sent)).toEqual([9]);
    expect(Object.keys(sent.sent!.pages)).toEqual(["1"]);
  });

  it("keeps the older round on a page whose size changed, scaled to the new size", () => {
    const first = markSent(addMark(EMPTY_LAYER, 1, [600, 800], ink([[100, 200, 0.5]])));
    const second = markSent(addMark(first, 1, [300, 400], ink([[5, 5, 0.5]])));
    expect(second.sent?.pages[1]).toEqual({ size: [300, 400], marks: [{ ...ink([[50, 100, 0.5]]), width: 1 }, ink([[5, 5, 0.5]])] });
  });

  it("never drops sent marks, even past the desktop's ceilings", () => {
    const big = ink(Array.from({ length: LIMITS.points - 10 }, (_, i): [number, number, number] => [i % 600, 1, 0.5]));
    const first = markSent(addMark(EMPTY_LAYER, 1, SIZE, big));
    const round = addMark(EMPTY_LAYER, 2, SIZE, ink(Array.from({ length: 20 }, (_, i): [number, number, number] => [i, 2, 0.5])));
    const second = markSent({ ...round, sent: first.sent });
    expect(second.sent?.rounds).toBe(2);
    expect(Object.keys(second.sent!.pages)).toEqual(["1", "2"]);
    expect(withinLimits(second)).toBe(true);
  });

  it("lets the reader erase or clear shown sent marks by hand", () => {
    const layer = markSent(addMark(addMark(EMPTY_LAYER, 1, SIZE, ink([[10, 10, 0.5], [40, 40, 0.5]])), 1, SIZE, note("sent", [300, 300])));
    // The rubbed half of the sent stroke goes; then all of it.
    const halved = eraseAt(layer, 1, 40, 40, 10, true);
    expect((halved.sent?.pages[1].marks[0] as InkMark).points[0]).toEqual([10, 10, 0.5]);
    const erased = eraseAt(layer, 1, 25, 25, 20, true);
    expect(erased.sent?.pages[1].marks).toEqual([note("sent", [300, 300])]);
    expect(erased.sent?.rounds).toBe(1);
    expect(eraseAt(erased, 1, 310, 305, 4, true).sent).toEqual({ pages: {}, rounds: 1 });
    const drawn = addMark(layer, 1, SIZE, ink([[500, 500, 0.5]]));
    expect(clearPage(drawn, 1, true)).toEqual({ pages: {}, sent: { pages: {}, rounds: 1 } });
  });

  it("never lets the eraser, a note drag or Clear page touch sent marks", () => {
    const sentNote = note("sent", [100, 100]);
    const layer: Layer = markSent(addMark(addMark(EMPTY_LAYER, 1, SIZE, ink([[10, 10, 0.5], [40, 40, 0.5]])), 1, SIZE, sentNote));
    // The same spots, now with nothing unsent there.
    expect(eraseAt(layer, 1, 20, 20, 10)).toBe(layer);
    expect(noteAt(layer.pages[1], 110, 105)).toBe(-1);
    expect(clearPage(layer, 1)).toBe(layer);
    // Unsent marks on the same page are edited, and the sent side rides along.
    const drawn = addMark(layer, 1, SIZE, note("new", [300, 300]));
    expect(noteAt(drawn.pages[1], 310, 305)).toBe(0);
    const moved = replaceMark(drawn, 1, 0, moveNote(drawn.pages[1].marks[0] as TextMark, [200, 200], SIZE));
    expect(moved.sent).toBe(layer.sent);
    expect(eraseAt(moved, 1, 205, 205, 4).sent).toBe(layer.sent);
    expect(clearPage(moved, 1)).toEqual({ pages: {}, sent: layer.sent });
    expect(markCount(moved)).toEqual({ marks: 1, points: 0 });
    expect(clearSent(moved)).toEqual({ pages: moved.pages });
  });

  it("reads a sent side only when it is sound, and a record without one", () => {
    const sent = markSent(addMark(EMPTY_LAYER, 1, SIZE, ink([[1, 1, 0.5]])));
    expect(isLayer(JSON.parse(JSON.stringify(sent)))).toBe(true);
    expect(isLayer({ pages: {} })).toBe(true);
    expect(isLayer({ pages: {}, sent: { pages: {}, rounds: -1 } })).toBe(false);
    expect(isLayer({ pages: {}, sent: { pages: { 0: { size: SIZE, marks: [] } }, rounds: 1 } })).toBe(false);
  });
});

describe("markup rounds · store", () => {
  const fp = { size: 10, modified: 20 };

  it("loads a record from before rounds as all unsent", async () => {
    const backend = memory();
    const old = addMark(EMPTY_LAYER, 1, SIZE, ink([[1, 2, 0.5]]));
    backend.map.set("k", { layer: JSON.parse(JSON.stringify(old)), fingerprint: fp, saved: 1 });
    const stored = await loadLayer("k", backend);
    expect(stored !== "unavailable" && stored?.layer).toEqual(old);
    // A broken sent side costs only itself.
    backend.map.set("k", { layer: { ...old, sent: { pages: "no", rounds: 1 } }, fingerprint: fp, saved: 1 });
    const salvaged = await loadLayer("k", backend);
    expect(salvaged !== "unavailable" && salvaged?.layer).toEqual({ pages: old.pages });
  });

  it("keeps a record that holds only sent marks, and drops one with none", async () => {
    const backend = memory();
    const sent = markSent(addMark(EMPTY_LAYER, 1, SIZE, ink([[1, 2, 0.5]])));
    expect(await saveLayer("k", sent, fp, backend)).toBe(true);
    const stored = await loadLayer("k", backend);
    expect(stored !== "unavailable" && stored?.layer).toEqual(sent);
    expect(await saveLayer("k", clearSent(sent), fp, backend)).toBe(true);
    expect(backend.map.size).toBe(0);
  });

  it("bounds the sent side too, more loosely than the unsent one", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ink([[i % 600, 1, 0.5]]));
    const sent = (n: number): Layer => ({ pages: {}, sent: { pages: { 1: { size: SIZE, marks: many(n) } }, rounds: 1 } });
    expect(withinLimits(sent(LIMITS.marks + 1))).toBe(true);
    expect(withinLimits(sent(SENT_LIMITS.marks))).toBe(true);
    expect(withinLimits(sent(SENT_LIMITS.marks + 1))).toBe(false);
    expect(withinLimits({ pages: { 1: { size: SIZE, marks: many(LIMITS.marks + 1) } } })).toBe(false);
  });

  it("moves a layer to a newer file under its new fingerprint", async () => {
    const backend = memory();
    const from = layerKey("p1", { outbox: "20261001-120000-paper.pdf" });
    const to = layerKey("p1", { outbox: "20261002-090000-paper.pdf" });
    const layer = markSent(addMark(EMPTY_LAYER, 1, SIZE, ink([[1, 2, 0.5]])));
    await saveLayer(from, layer, fp, backend);
    expect(await moveLayer(from, to, { size: 11, modified: 30 }, backend)).toBe(true);
    expect(await loadLayer(from, backend)).toBeNull();
    const moved = await loadLayer(to, backend);
    expect(moved !== "unavailable" && moved && { layer: moved.layer, fingerprint: moved.fingerprint }).toEqual({ layer, fingerprint: { size: 11, modified: 30 } });
    // Nothing to move is no failure; broken storage is.
    expect(await moveLayer("none", to, fp, backend)).toBe(true);
    const broken: LayerBackend = { get: () => Promise.reject(new Error("x")), put: () => Promise.reject(new Error("x")), delete: () => Promise.reject(new Error("x")) };
    expect(await moveLayer(from, to, fp, broken)).toBe(false);
  });
});

describe("markup rounds · the pill's machine", () => {
  /** Feeds the machine one look per entry, as a host would. */
  const run = (round: Round, looks: [AgentSignal, number][]): Round => looks.reduce((now, [agent, at]) => stepRound(now, agent, at), round);

  it("goes sent → working → finished only once idle has held SETTLE_MS", () => {
    let round = startRound(false, 0);
    expect(round.phase).toBe("sent");
    round = run(round, [["working", 1_000], ["idle", 5_000]]);
    expect(round.phase).toBe("working");
    expect(nextCheck(round, "idle", 5_000)).toBe(SETTLE_MS);
    round = stepRound(round, "idle", 5_000 + SETTLE_MS - 1);
    expect(round.phase).toBe("working");
    round = stepRound(round, "idle", 5_000 + SETTLE_MS);
    expect(round.phase).toBe("finished");
    expect(nextCheck(round, "idle", 9_000)).toBeNull();
    // The same object when nothing changes: a host may step every render.
    expect(stepRound(round, "idle", 99_000)).toBe(round);
  });

  it("starts queued when the agent was working, and works from there", () => {
    const round = startRound(true, 0);
    expect(round.phase).toBe("queued");
    expect(stepRound(round, "working", 10).phase).toBe("working");
  });

  it("shows a question between work, and settles from it too", () => {
    let round = run(startRound(false, 0), [["working", 1], ["question", 2]]);
    expect(round.phase).toBe("question");
    round = stepRound(round, "working", 3);
    expect(round.phase).toBe("working");
    round = run(round, [["question", 4], ["idle", 5], ["idle", 5 + SETTLE_MS]]);
    expect(round.phase).toBe("finished");
  });

  it("does not call a short idle blip finished", () => {
    const round = run(startRound(true, 0), [["working", 1], ["idle", 100], ["working", 100 + SETTLE_MS - 1], ["idle", 100 + SETTLE_MS + 1]]);
    expect(round.phase).toBe("working");
    expect(round.idleSince).toBe(100 + SETTLE_MS + 1);
  });

  it("stops claiming to know after CONFIRM_MS without any work seen", () => {
    let round = startRound(false, 0);
    expect(nextCheck(round, "idle", 5_000)).toBe(CONFIRM_MS - 5_000);
    round = stepRound(round, "idle", CONFIRM_MS - 1);
    expect(round.phase).toBe("sent");
    round = stepRound(round, "idle", CONFIRM_MS);
    expect(round.phase).toBe("unconfirmed");
    // Work seen late still counts.
    expect(stepRound(round, "working", CONFIRM_MS + 1).phase).toBe("working");
  });

  it("follows the agent working again after finished, and restarts on a new Submit", () => {
    let round = run(startRound(false, 0), [["working", 1], ["idle", 2], ["idle", 2 + SETTLE_MS]]);
    expect(round.phase).toBe("finished");
    round = stepRound(round, "working", 10_000);
    expect(round).toMatchObject({ phase: "working", since: 10_000 });
    round = run(round, [["idle", 11_000], ["idle", 11_000 + SETTLE_MS]]);
    expect(round.phase).toBe("finished");
    const restarted = startRound(true, 20_000);
    expect(restarted).toEqual({ phase: "queued", since: 20_000, sentAt: 20_000, idleSince: null });
    expect(followRound("question", 5)).toMatchObject({ phase: "question" });
  });
});

describe("markup rounds · Make these changes", () => {
  it("fits a finished or unconfirmed Submit round, never the follow-up's own", () => {
    const sent = startRound(false, 0);
    expect(canApply(null)).toBe(false);
    expect(canApply(sent)).toBe(false);
    const working = stepRound(sent, "working", 1);
    expect(canApply(working)).toBe(false);
    const finished = stepRound(stepRound(working, "idle", 2), "idle", 2 + SETTLE_MS);
    expect(finished.phase).toBe("finished");
    expect(canApply(finished)).toBe(true);
    expect(canApply(stepRound(sent, "idle", CONFIRM_MS))).toBe(true);
    const applied = startRound(true, 10, true);
    expect(applied).toMatchObject({ phase: "queued", applied: true });
    const done = stepRound(stepRound(stepRound(applied, "working", 11), "idle", 12), "idle", 12 + SETTLE_MS);
    expect(done.phase).toBe("finished");
    expect(done.applied).toBe(true);
    expect(canApply(done)).toBe(false);
  });
});

describe("markup rounds · Undo (apply rounds)", () => {
  const UNDO = { id: "0123456789abcdef0123456789abcdef", state: "ready" as const };
  const finish = (round: Round) => stepRound(stepRound(stepRound(round, "working", 1), "idle", 2), "idle", 2 + SETTLE_MS);

  it("offers Undo only on a round with an undo id, once it is done — and Make these changes never", () => {
    const sent = startRound(false, 0, false, UNDO);
    expect(sent.undo).toEqual(UNDO);
    expect(canUndo(null)).toBe(false);
    expect(canUndo(sent)).toBe(false);
    expect(canUndo(stepRound(sent, "working", 1))).toBe(false);
    const finished = finish(sent);
    expect(finished.phase).toBe("finished");
    // The undo travels with the round through every step.
    expect(finished.undo).toEqual(UNDO);
    expect(canUndo(finished)).toBe(true);
    expect(canApply(finished)).toBe(false);
    expect(canUndo(stepRound(sent, "idle", CONFIRM_MS))).toBe(true);
    // A list round: Make these changes, no Undo.
    expect(canUndo(finish(startRound(false, 0)))).toBe(false);
    expect(canApply(finish(startRound(false, 0)))).toBe(true);
    // Once it went through, neither.
    const undone = undoneRound(finished, UNDO.id);
    expect(undone.undo).toEqual({ ...UNDO, state: "done" });
    expect(canUndo(undone)).toBe(false);
    expect(canApply(undone)).toBe(false);
    expect(undoneRound(undone, UNDO.id)).toBe(undone);
    // A late answer for an earlier round's undo leaves a newer round's alone.
    const newer = finish(startRound(false, 100, false, { id: "f".repeat(32), state: "ready" }));
    expect(undoneRound(newer, UNDO.id)).toBe(newer);
    expect(holdsUndo(newer, UNDO.id)).toBe(false);
    expect(holdsUndo(finished, UNDO.id)).toBe(true);
    expect(holdsUndo(null, UNDO.id)).toBe(false);
    // An answered question restarts the round with its own undo.
    expect(startRound(true, 50, false, finished.undo)).toMatchObject({ phase: "queued", undo: UNDO });
  });

  it("says what an undo puts back, and words the chat note", () => {
    const t = (key: TranslationKey, vars?: Record<string, string | number>) => translate("en", key, vars);
    expect(undoSummary({ files: [{ path: "a.tex" }, { path: "refs.bib" }], more: 0, pdf: "restored" }, t))
      .toBe("Back as before: a.tex, refs.bib. The PDF goes back to before.");
    expect(undoSummary({ files: [{ path: "a.tex" }], more: 2, pdf: "kept" }, t))
      .toBe("Back as before: a.tex and 2 more. The PDF has changed since — it stays.");
    expect(undoSummary({ files: [], more: 0, pdf: "none" }, t)).toBe("No file changed since the Submit.");
    expect(markupUndoNote(["a.tex", "b.bib"], 0))
      .toBe("I undid your edits from my last marks: `a.tex` and `b.bib` are back as they were before that round. Don't redo them; no need to reply.");
    expect(markupUndoNote(["a.tex"], 0)).toContain("`a.tex` is back as it was before");
    expect(markupUndoNote(["a.tex"], 1)).toContain("`a.tex` and 1 other file are back");
  });

  it("treats either mode's default instruction as none, and keeps Apply marks directly on unset", () => {
    localStorage.clear();
    expect(readMarkupDirect()).toBe(true);
    expect(defaultMarkupInstruction(true)).toBe(DEFAULT_MARKUP_APPLY_INSTRUCTION);
    expect(defaultMarkupInstruction(false)).toBe(DEFAULT_MARKUP_INSTRUCTION);
    writeMarkupInstruction(DEFAULT_MARKUP_APPLY_INSTRUCTION);
    expect(readMarkupInstruction()).toBeNull();
    writeMarkupInstruction(` ${DEFAULT_MARKUP_INSTRUCTION}`);
    expect(readMarkupInstruction()).toBeNull();
    writeMarkupInstruction("Fix typos only.");
    expect(readMarkupInstruction()).toBe("Fix typos only.");
    writeMarkupDirect(false);
    expect(readMarkupDirect()).toBe(false);
    localStorage.clear();
  });
});
