/**
 * The pure half of the first-run intro wizard (`HowToStart`): the page order,
 * the remembered page, which agent CLIs the intro features, and the local-model
 * recommendation. Store- and Tauri-free, so it is unit-testable on its own.
 */
import type { TranslationKey } from "../../../lib/i18n";
import { storageKey } from "../../../lib/brand";

export const INTRO_PAGES = ["welcome", "projects", "agents", "localModels", "askApp", "done"] as const;
export type IntroPage = (typeof INTRO_PAGES)[number];

export const INTRO_PAGE_TITLE_KEYS: Record<IntroPage, TranslationKey> = {
  welcome: "intro.page.welcome",
  projects: "intro.page.projects",
  agents: "intro.page.agents",
  localModels: "intro.page.localModels",
  askApp: "intro.page.askApp",
  done: "intro.page.done",
};

/** The page the wizard was left on survives a close and a window reload — a
 *  per-viewer convenience, so localStorage (and nothing breaks without it). */
const PAGE_KEY = storageKey("intro.page");

export function readIntroPage(): IntroPage {
  try {
    const raw = localStorage.getItem(PAGE_KEY);
    return (INTRO_PAGES as readonly string[]).includes(raw ?? "") ? (raw as IntroPage) : "welcome";
  } catch {
    return "welcome";
  }
}

export function writeIntroPage(page: IntroPage): void {
  try {
    if (page === "welcome") localStorage.removeItem(PAGE_KEY);
    else localStorage.setItem(PAGE_KEY, page);
  } catch {
    // Private window / blocked storage: the wizard simply starts at Welcome.
  }
}

/** The agent CLIs the intro walks through, in display order — the same three
 *  the + menu shows compact by default (`DEFAULT_COMPACT_AGENT_IDS`). Ids are
 *  the backend registry's (`commands::agents::AGENTS`); every other CLI stays
 *  one click away in Settings → Manage CLIs. */
export const FEATURED_AGENT_IDS = ["claude", "codex", "gemini"] as const;
export type FeaturedAgentId = (typeof FEATURED_AGENT_IDS)[number];

/** What the optional "sign in now" button runs in a terminal tab: each CLI's
 *  own first-run login (Tabtivity does no agent login itself; the first agent tab
 *  would ask the same). Interactive — a browser handoff or a pasted key — which
 *  is why it is a visible terminal and never a headless call. */
export const AGENT_SIGN_IN_CMD: Record<FeaturedAgentId, string> = {
  claude: "claude",
  codex: "codex login",
  gemini: "gemini",
};

/** How to leave the session a "sign in now" command opens — `claude` and
 *  `gemini` stay open as a full session in the root folder once signed in;
 *  `codex login` is a one-shot and needs none. */
export const AGENT_SIGN_IN_EXIT: Partial<Record<FeaturedAgentId, string>> = {
  claude: "/exit",
  gemini: "/quit",
};

export const AGENT_SIGN_IN_KEYS: Record<FeaturedAgentId, TranslationKey> = {
  claude: "intro.agents.signIn.claude",
  codex: "intro.agents.signIn.codex",
  gemini: "intro.agents.signIn.gemini",
};

/** An installer that goes through npm needs Node.js first. */
export function installNeedsNpm(installCmd: string): boolean {
  return /(^|[\s;&|])npm\s/.test(installCmd);
}

export interface ModelPick {
  /** Ollama registry ref. */
  model: string;
  /** Approximate download size, for the button label. */
  sizeGb: number;
}

/** Recommended starter models, smallest first. All are tool-capable coder
 *  models, so the same pick can also drive a Local Model agent tab. Sizes are
 *  the approximate downloads the help corpus (`docs/help/local-models.md`)
 *  quotes. */
export const MODEL_TIERS = {
  tiny: { model: "qwen2.5-coder:1.5b", sizeGb: 1 },
  small: { model: "qwen2.5-coder:3b", sizeGb: 1.9 },
  medium: { model: "qwen2.5-coder:7b", sizeGb: 4.7 },
  large: { model: "qwen2.5-coder:14b", sizeGb: 9 },
} satisfies Record<string, ModelPick>;

const GB = 1024 ** 3;

/** Dedicated GPU memory worth sizing a model by. An integrated GPU's carve-out
 *  (typically 512 MB) is not; there the model lands in system RAM. */
export const GPU_SIZING_MIN_BYTES = 8 * GB;

/**
 * The starter model for this machine, by the table in the help corpus: a GPU
 * with 16 GB → 14b; a GPU with 8 GB, or 16 GB of RAM → 7b; 8 GB of RAM → 3b;
 * anything smaller, or unknown memory (0) → 1.5b.
 */
export function recommendModel(ramBytes: number, dedicatedVramBytes: number): ModelPick {
  if (dedicatedVramBytes >= 16 * GB) return MODEL_TIERS.large;
  if (dedicatedVramBytes >= GPU_SIZING_MIN_BYTES || ramBytes >= 15.5 * GB) return MODEL_TIERS.medium;
  if (ramBytes >= 7.5 * GB) return MODEL_TIERS.small;
  return MODEL_TIERS.tiny;
}

/** Same comparison the "+" menu uses: `/api/tags` names carry an explicit tag,
 *  a typed ref may omit `:latest`. */
export function sameModel(listed: string, wanted: string): boolean {
  return listed === wanted || (!wanted.includes(":") && listed === `${wanted}:latest`);
}
