import { describe, expect, it } from "vitest";
import {
  COMPLETION_TIMINGS_CAP, CompletionOffers, SHOWN_MS, clearCompletionTimings, completionTimings, startCompletionTiming,
} from "../../lib/viewers/completion/completionTimings";
import { autocompleteOffers } from "../../components/stats/StatsRecap";

function tracker() {
  const bumps: string[] = [];
  let now = 0;
  const offers = new CompletionOffers((key) => bumps.push(key), () => now);
  return { offers, bumps, wait: (ms: number) => { now += ms; } };
}

describe("autocomplete offers", () => {
  it("a ghost gone before 750 ms counts nothing; after, shown and rejected", () => {
    const { offers, bumps, wait } = tracker();
    offers.start("a", "sentence", "ollama/coder");
    wait(SHOWN_MS - 1);
    offers.end();
    expect(bumps).toEqual([]);
    offers.start("b", "block", "ollama/coder");
    wait(SHOWN_MS);
    offers.end();
    expect(bumps).toEqual(["autocomplete.shown.block.ollama/coder", "autocomplete.rejected.block.ollama/coder"]);
  });

  it("taking counts shown at once, each way once per offer, and never rejects", () => {
    const { offers, bumps, wait } = tracker();
    offers.start("a", "sentence", "copilot/copilot");
    offers.take("word");
    offers.take("word");
    offers.start("a", "sentence", "copilot/copilot");
    offers.take("tab");
    wait(5000);
    offers.end();
    expect(bumps).toEqual([
      "autocomplete.shown.sentence.copilot/copilot",
      "autocomplete.word.sentence.copilot/copilot",
      "autocomplete.tab.sentence.copilot/copilot",
    ]);
  });

  it("three typed characters take the ghost, fewer do not", () => {
    const { offers, bumps } = tracker();
    offers.start("a", "scope", "ollama/coder");
    offers.typed(1);
    offers.typed(1);
    expect(bumps).toEqual([]);
    offers.typed(1);
    offers.typed(4);
    expect(bumps).toEqual(["autocomplete.shown.scope.ollama/coder", "autocomplete.typed.scope.ollama/coder"]);
  });

  it("a new candidate ends the previous offer", () => {
    const { offers, bumps, wait } = tracker();
    offers.start("a", "sentence", "copilot/copilot");
    wait(SHOWN_MS);
    offers.start("b", "sentence", "copilot/copilot");
    expect(bumps).toEqual(["autocomplete.shown.sentence.copilot/copilot", "autocomplete.rejected.sentence.copilot/copilot"]);
  });
});

describe("completion timings ring", () => {
  it("keeps the newest requests up to its cap", () => {
    clearCompletionTimings();
    for (let i = 0; i < COMPLETION_TIMINGS_CAP + 5; i++) startCompletionTiming("ollama", "auto", i);
    const ring = completionTimings();
    expect(ring).toHaveLength(COMPLETION_TIMINGS_CAP);
    expect(ring[0].keystroke).toBe(5);
    clearCompletionTimings();
    expect(completionTimings()).toHaveLength(0);
  });
});

describe("stats recap offers", () => {
  it("reads the new keys per mode and model, leaving requests and old history out", () => {
    const rows = autocompleteOffers({
      "autocomplete.shown.sentence.ollama/qwen2.5-coder:1.5b": 4,
      "autocomplete.tab.sentence.ollama/qwen2.5-coder:1.5b": 2,
      "autocomplete.rejected.sentence.ollama/qwen2.5-coder:1.5b": 1,
      "autocomplete.typed.copilot.copilot/copilot": 1,
      "autocomplete.request.ok.ollama/qwen2.5-coder:1.5b": 9,
      "autocomplete.accept.sentence.ollama/old": 3,
    });
    expect([...rows.keys()].sort()).toEqual(["copilot.copilot/copilot", "sentence.ollama/qwen2.5-coder:1.5b"]);
    expect(rows.get("sentence.ollama/qwen2.5-coder:1.5b")).toEqual({ shown: 4, tab: 2, word: 0, line: 0, typed: 0, rejected: 1 });
  });
});
