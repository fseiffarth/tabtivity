import { describe, expect, it } from "vitest";
import { turnFinishedRule } from "../../lib/agents/agentReader";
import type { TranscriptTurn } from "../../../mobile-web/src/terminal/transcriptTurns";

const turn = (kind: TranscriptTurn["kind"], stamp?: string, extra: Partial<TranscriptTurn> = {}): TranscriptTurn =>
  ({ key: `${kind}:${stamp ?? ""}`, kind, text: "words", stamp, ...extra }) as TranscriptTurn;

describe("turnFinishedRule", () => {
  it("closes a turn that ended on an answer, timed from its prompt", () => {
    expect(turnFinishedRule([
      turn("prompt", "2026-11-24T10:00:00Z"),
      turn("answer", "2026-11-24T10:00:30Z"),
      turn("agent", "2026-11-24T10:01:00Z"),
      turn("answer", "2026-11-24T10:03:12Z"),
    ])).toEqual({ took: "3m 12s" });
  });

  it("times from the last real prompt, skipping a command", () => {
    expect(turnFinishedRule([
      turn("prompt", "2026-11-24T10:00:00Z"),
      turn("prompt", "2026-11-24T10:05:00Z", { command: { name: "/model", args: "" } as TranscriptTurn["command"] }),
      turn("answer", "2026-11-24T10:00:45Z"),
    ])).toEqual({ took: "45s" });
  });

  it("says Finished without a time when the prompt is not among the turns", () => {
    expect(turnFinishedRule([turn("answer", "2026-11-24T10:00:45Z")])).toEqual({ took: undefined });
  });

  it("draws nothing after an interrupted turn, a question, a subagent card or a prompt", () => {
    expect(turnFinishedRule([])).toBeNull();
    expect(turnFinishedRule([turn("prompt"), turn("interrupted")])).toBeNull();
    expect(turnFinishedRule([turn("prompt"), turn("answer", undefined, { questions: [] })])).toBeNull();
    expect(turnFinishedRule([turn("prompt"), turn("answer", undefined, { asking: true })])).toBeNull();
    expect(turnFinishedRule([turn("prompt"), turn("agent")])).toBeNull();
    expect(turnFinishedRule([turn("prompt")])).toBeNull();
  });
});
