/**
 * Steering's agent keys (`lib/shortcuts/steeringAgent`): which agent tabs take
 * Clear / Plan / Goal, and that Plan / Goal open the prompt box led with their
 * command.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ledDraft,
  requestSteeringPrompt,
  STEERING_PROMPT_EVENT,
  steeringAgentOffer,
  type SteeringPromptDetail,
} from "../../lib/shortcuts/steeringAgent";
import type { TabEntry } from "../../stores/tabs";

const tab = (cmd: string, kind: TabEntry["kind"] = "agent"): TabEntry =>
  ({ key: `t-${cmd}`, label: cmd, cmd, kind }) as TabEntry;

describe("steering agent keys", () => {
  const seen: SteeringPromptDetail[] = [];
  const box = (e: Event) => {
    const detail = (e as CustomEvent<SteeringPromptDetail>).detail;
    detail.handled = true;
    seen.push(detail);
  };
  afterEach(() => {
    window.removeEventListener(STEERING_PROMPT_EVENT, box);
    seen.length = 0;
  });

  it("offers each key only to the CLIs that take it", () => {
    expect(steeringAgentOffer(tab("claude"))).toEqual({ clear: true, plan: true, goal: true, prompt: true });
    expect(steeringAgentOffer(tab("gemini"))).toEqual({ clear: true, plan: true, goal: false, prompt: true });
    expect(steeringAgentOffer(tab("aider"))).toEqual({ clear: true, plan: false, goal: false, prompt: true });
    expect(steeringAgentOffer(tab("bash", "shell"))).toEqual({ clear: false, plan: false, goal: false, prompt: false });
    expect(steeringAgentOffer(null)).toEqual({ clear: false, plan: false, goal: false, prompt: false });
  });

  it("opens the prompt box led with the command", () => {
    window.addEventListener(STEERING_PROMPT_EVENT, box);
    expect(requestSteeringPrompt("p", tab("claude"), "panes", "/goal")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ scope: "p", level: "panes", lead: "/goal" });
  });

  it("leaves a CLI without the command, or no box mounted, alone", () => {
    expect(requestSteeringPrompt("p", tab("claude"), "tabs", "/plan")).toBe(false);
    window.addEventListener(STEERING_PROMPT_EVENT, box);
    expect(requestSteeringPrompt("p", tab("aider"), "tabs", "/plan")).toBe(false);
    expect(requestSteeringPrompt("p", tab("gemini"), "tabs", "/goal")).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("leads a kept draft, swapping a lead it already had", () => {
    expect(ledDraft("", "/plan")).toBe("/plan ");
    expect(ledDraft("fix the tests", "/plan")).toBe("/plan fix the tests");
    expect(ledDraft("/plan fix the tests", "/goal")).toBe("/goal fix the tests");
    expect(ledDraft("/plan", "/goal")).toBe("/goal ");
    expect(ledDraft("/planner stays", "/goal")).toBe("/goal /planner stays");
    expect(ledDraft("as it was", undefined)).toBe("as it was");
  });
});
