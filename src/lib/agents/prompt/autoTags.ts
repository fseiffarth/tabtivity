import { splitPreface } from "../agentPrefaces";
import { normalizeTag } from "./tags";

export interface PromptAutoTagInput {
  message: string;
  agent?: string;
  /** The model the prompt runs (or ran) under when the preface names none:
   *  the tab's own, read from its transcript, or the chart's new-tab pick. */
  model?: string;
  preface?: string[];
  files?: string[];
  result?: string;
  recurring?: boolean;
  queued?: boolean;
  chained?: boolean;
  /** The paired phone the prompt came from, by its name (`device:pixel-9`);
   *  `""` for one no longer paired. Absent from the desktop. */
  phone?: string;
}

/** Tags that can be reconstructed from a card are deliberately never stored. */
export function agentPromptAutoTags(input: PromptAutoTagInput): string[] {
  const tags: string[] = [];
  const add = (tag: string) => {
    const clean = tag.trim().toLowerCase();
    if (clean && !tags.includes(clean)) tags.push(clean);
  };
  if (input.agent) add(`agent:${input.agent}`);
  // A `/model` typed ahead of the prompt is the model it runs under, whatever
  // the tab answered with before.
  const { commands, model } = splitPreface(input.preface);
  const picked = model || input.model;
  if (picked) add(`model:${picked}`);
  for (const command of commands) {
    const name = /^\/([^\s]+)/.exec(command)?.[1];
    if (name) add(`cmd:${name}`);
  }
  for (const raw of input.files ?? []) {
    const file = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = file.split("/").filter(Boolean);
    if (!parts.length) continue;
    add(`file:${parts[parts.length - 1]}`);
    if (parts.length > 1) add(`dir:${parts[0]}`);
  }
  if (input.phone !== undefined) add(`device:${normalizeTag(input.phone) || "phone"}`);
  if (input.result === "missed" || input.result === "failed") add(`result:${input.result}`);
  if (input.recurring) add("recurring");
  if (input.queued) add("queued");
  if (input.chained) add("chained");
  for (const match of input.message.matchAll(/```\s*([\w.+-]+)/g)) add(`lang:${match[1]}`);
  if (new TextEncoder().encode(input.message).byteLength > 2_048) add("long");
  return tags;
}
