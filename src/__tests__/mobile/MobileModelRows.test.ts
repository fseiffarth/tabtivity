/**
 * The remembered model rows (`services::model_rows`) as a sheet lists them and
 * as they are kept: current-model marks dropped, numbers as printed, a tapped
 * row found again in the live list by its label alone.
 */
import { describe, expect, it } from "vitest";
import { liveModelPick, modelRowsOf, modelRowsStep, sameModelRows } from "../../../mobile-web/src/terminal/modelRows";

const live = {
  title: "Select model",
  options: [
    { index: 0, number: 4, label: "Sonnet 5.5 ✔", description: "Most efficient" },
    { index: 1, number: 5, label: "Haiku 5.5" },
  ],
};

describe("remembered model rows", () => {
  it("are kept without the current model's mark, numbered as printed", () => {
    expect(modelRowsOf(live)).toEqual({
      title: "Select model",
      rows: [{ label: "Sonnet 5.5", description: "Most efficient", number: 4 }, { label: "Haiku 5.5", number: 5 }],
    });
  });

  it("come back as the step a sheet lists", () => {
    const step = modelRowsStep(modelRowsOf(live));
    expect(step).toEqual({
      title: "Select model",
      options: [
        { index: 0, number: 4, label: "Sonnet 5.5", description: "Most efficient" },
        { index: 1, number: 5, label: "Haiku 5.5" },
      ],
    });
    expect(sameModelRows(step!, live)).toBe(true);
    expect(sameModelRows(step!, { ...live, options: live.options.slice(1) })).toBe(false);
  });

  it("list nothing for an empty or malformed answer", () => {
    expect(modelRowsStep(null)).toBeNull();
    expect(modelRowsStep({ rows: [] })).toBeNull();
    expect(modelRowsStep({ rows: "x" } as never)).toBeNull();
    expect(modelRowsStep({ rows: [{ label: 3 }, { label: "Opus" }] } as never)?.options).toEqual([{ index: 0, number: 1, label: "Opus" }]);
  });

  it("find a tapped row in the live list by its label, the current mark aside", () => {
    expect(liveModelPick(live, { label: "Sonnet 5.5" })).toBe(0);
    expect(liveModelPick(live, { label: "Haiku 5.5 ✔" })).toBe(1);
    expect(liveModelPick(live, { label: "Opus 4.1" })).toBeNull();
  });
});
