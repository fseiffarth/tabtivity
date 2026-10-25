/** Visual groups for OpenCode's model list. The session still owns every
 * option and its keys; regrouping never changes what a tap sends to it. */
export interface OpenCodeModelGroup<T> {
  key: string;
  /** A provider name printed by OpenCode, when no model family is known. */
  provider?: string;
  options: T[];
}

const FAMILIES = [
  ["claude", /\bclaude\b/iu],
  ["openai", /\b(?:gpt|chatgpt|codex|openai)\b|\bo[134](?:\b|[-.])/iu],
  ["gemini", /\bgemini\b/iu],
  ["grok", /\bgrok\b/iu],
  ["deepseek", /\bdeepseek\b/iu],
  ["qwen", /\bqwen\b/iu],
  ["llama", /\bllama\b/iu],
  ["mistral", /\bmistral\b/iu],
  ["kimi", /\bkimi\b/iu],
] as const;

const TITLES: Record<string, TranslationKey> = {
  free: "terminal.reader.modelGroup.free",
  claude: "terminal.reader.modelGroup.claude",
  openai: "terminal.reader.modelGroup.openai",
  gemini: "terminal.reader.modelGroup.gemini",
  grok: "terminal.reader.modelGroup.grok",
  deepseek: "terminal.reader.modelGroup.deepseek",
  qwen: "terminal.reader.modelGroup.qwen",
  llama: "terminal.reader.modelGroup.llama",
  mistral: "terminal.reader.modelGroup.mistral",
  kimi: "terminal.reader.modelGroup.kimi",
  other: "terminal.reader.modelGroup.other",
};

export function openCodeModelGroupTitle<T>(group: OpenCodeModelGroup<T>, t: (key: TranslationKey) => string): string {
  return group.provider ?? t(TITLES[group.key] ?? TITLES.other);
}

function groupFor(option: { label: string; description?: string }): { key: string; provider?: string } {
  const details = option.description?.split(" · ") ?? [];
  if (details.includes("Free")) return { key: "free" };
  const family = FAMILIES.find(([, pattern]) => pattern.test(option.label));
  if (family) return { key: family[0] };
  const provider = details.find((part) => part !== "Free");
  return provider ? { key: `provider:${provider}`, provider } : { key: "other" };
}

export function groupOpenCodeModels<T extends { label: string; description?: string }>(options: readonly T[]): OpenCodeModelGroup<T>[] {
  const groups = new Map<string, OpenCodeModelGroup<T>>();
  for (const option of options) {
    const { key, provider } = groupFor(option);
    let group = groups.get(key);
    if (!group) {
      group = { key, provider, options: [] };
      groups.set(key, group);
    }
    group.options.push(option);
  }
  return [...groups.values()].sort((a, b) => {
    const order = (key: string) => key === "free" ? -1 : FAMILIES.findIndex(([family]) => family === key);
    const left = order(a.key);
    const right = order(b.key);
    return (left < 0 && a.key !== "free" ? FAMILIES.length : left)
      - (right < 0 && b.key !== "free" ? FAMILIES.length : right);
  });
}
import type { TranslationKey } from "../../../src/lib/i18n";

