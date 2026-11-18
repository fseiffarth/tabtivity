import { describe, expect, it } from "vitest";
import { AGENT_MIN_CONTEXT, shortOnContext } from "../../lib/agents/ollamaContext";

describe("shortOnContext", () => {
  it("names only resident models below the agent minimum", () => {
    const short = { name: "small", running: true, context_length: 4096 };
    const models = [
      short,
      { name: "enough", running: true, context_length: AGENT_MIN_CONTEXT },
      { name: "idle", running: false, context_length: 4096 },
    ];
    expect(shortOnContext(models)).toEqual([short]);
  });

  it("never calls an unreported context short", () => {
    expect(shortOnContext([{ running: true }, { running: true, context_length: null }])).toEqual([]);
  });
});
