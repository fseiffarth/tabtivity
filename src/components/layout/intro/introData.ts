/**
 * The pure half of the first-run intro wizard (`HowToStart`): the page order,
 * the remembered page, the goals that shape the route and the lessons matched
 * to them, which agent CLIs the intro features, and the local-model
 * recommendation. Store- and Tauri-free, so it is unit-testable on its own.
 */
import type { TranslationKey } from "../../../lib/i18n";
import { storageKey } from "../../../lib/brand";

/** Every page the wizard can show, in canonical order. The goals picked on the
 *  Goals page decide which of the setup pages a run actually visits
 *  (`introRoute`). */
export const INTRO_PAGES = ["welcome", "goals", "projects", "agents", "localModels", "forYou", "askApp", "done"] as const;
export type IntroPage = (typeof INTRO_PAGES)[number];

/** Each page's title in the step rail, the compact dropdown and the heading. */
export const INTRO_PAGE_TITLE_KEYS: Record<IntroPage, TranslationKey> = {
  welcome: "intro.page.welcome",
  goals: "intro.page.goals",
  projects: "intro.page.projects",
  agents: "intro.page.agents",
  localModels: "intro.page.localModels",
  forYou: "intro.page.forYou",
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
    // The stored value is the table's own literal, never the caller's string:
    // a page name is no secret, whatever it was derived from.
    const known = INTRO_PAGES.find((p) => p === page);
    if (!known || known === "welcome") localStorage.removeItem(PAGE_KEY);
    else localStorage.setItem(PAGE_KEY, known);
  } catch {
    // Private window / blocked storage: the wizard simply starts at Welcome.
  }
}

/** What the user can say they want to do on the Goals page, in display order. */
export const INTRO_GOALS = ["code", "localAi", "write", "remote", "sandbox", "organize", "phone", "explore"] as const;
export type IntroGoal = (typeof INTRO_GOALS)[number];

/** One goal card and what picking it brings along. */
export interface IntroGoalDef {
  /** One emoji, decorative (rendered `aria-hidden`). */
  icon: string;
  titleKey: TranslationKey;
  blurbKey: TranslationKey;
  /** Setup pages this goal pulls into the route. */
  pages: readonly IntroPage[];
  /** Lesson ids from `src/lib/lessons.ts`, best first. Plain strings so this
   *  module stays free of the lesson registry; a test checks they exist. */
  lessons: readonly string[];
}

/** The goal table: card text, the pages each goal needs, its lessons. */
export const INTRO_GOAL_DEFS: Record<IntroGoal, IntroGoalDef> = {
  code: {
    icon: "🤖",
    titleKey: "intro.goal.code.title",
    blurbKey: "intro.goal.code.blurb",
    pages: ["projects", "agents"],
    lessons: ["install-agent", "add-tab", "skills-library", "run-python"],
  },
  localAi: {
    icon: "🔒",
    titleKey: "intro.goal.localAi.title",
    blurbKey: "intro.goal.localAi.blurb",
    pages: ["localModels"],
    lessons: ["local-model", "add-local-model"],
  },
  write: {
    icon: "📝",
    titleKey: "intro.goal.write.title",
    blurbKey: "intro.goal.write.blurb",
    pages: ["projects"],
    lessons: ["tex-workspace", "pdf-viewer", "deck-presenter", "native-viewer"],
  },
  remote: {
    icon: "🖥️",
    titleKey: "intro.goal.remote.title",
    blurbKey: "intro.goal.remote.blurb",
    pages: ["projects"],
    lessons: ["add-ssh-project", "tour-remote", "compute-machines", "persistent-sessions", "hpc-pipeline"],
  },
  sandbox: {
    icon: "📦",
    titleKey: "intro.goal.sandbox.title",
    blurbKey: "intro.goal.sandbox.blurb",
    pages: ["projects"],
    lessons: ["docker-sandbox", "project-boxes", "vm-project"],
  },
  organize: {
    icon: "📅",
    titleKey: "intro.goal.organize.title",
    blurbKey: "intro.goal.organize.blurb",
    pages: [],
    lessons: ["mail", "calendar", "todo-board", "usage-recap"],
  },
  phone: {
    icon: "📱",
    titleKey: "intro.goal.phone.title",
    blurbKey: "intro.goal.phone.blurb",
    pages: [],
    lessons: ["mobile"],
  },
  explore: {
    icon: "🧭",
    titleKey: "intro.goal.explore.title",
    blurbKey: "intro.goal.explore.blurb",
    pages: ["projects", "agents", "localModels"],
    // "tour" is `TOUR_LESSON_ID` (lessons.ts), spelled out to keep this module pure.
    lessons: ["tour", "arrange-tabs", "keyboard-steering", "file-search"],
  },
};

/** Pages every route visits, whatever the goals. */
const ALWAYS_PAGES: readonly IntroPage[] = ["welcome", "goals", "forYou", "askApp", "done"];

function isIntroGoal(value: unknown): value is IntroGoal {
  return typeof value === "string" && (INTRO_GOALS as readonly string[]).includes(value);
}

/** No goal picked counts as ["explore"] (the full tour, as before); otherwise
 *  the picked goals, deduplicated, in INTRO_GOALS order. */
export function effectiveGoals(goals: readonly IntroGoal[]): IntroGoal[] {
  const picked = INTRO_GOALS.filter((g) => goals.includes(g));
  return picked.length > 0 ? picked : ["explore"];
}

/** The pages this run visits: welcome and goals, the union of the effective
 *  goals' setup pages, then forYou, askApp and done — no duplicates, always in
 *  INTRO_PAGES order. */
export function introRoute(goals: readonly IntroGoal[]): IntroPage[] {
  const wanted = new Set<IntroPage>(ALWAYS_PAGES);
  for (const g of effectiveGoals(goals)) for (const p of INTRO_GOAL_DEFS[g].pages) wanted.add(p);
  return INTRO_PAGES.filter((p) => wanted.has(p));
}

/** Effective goals in INTRO_GOALS order, each with its lessons minus any already
 *  listed under an earlier goal; groups left empty are dropped. */
export function recommendedLessons(goals: readonly IntroGoal[]): { goal: IntroGoal; lessonIds: string[] }[] {
  const seen = new Set<string>();
  const groups: { goal: IntroGoal; lessonIds: string[] }[] = [];
  for (const goal of effectiveGoals(goals)) {
    const lessonIds = INTRO_GOAL_DEFS[goal].lessons.filter((id) => !seen.has(id));
    for (const id of lessonIds) seen.add(id);
    if (lessonIds.length > 0) groups.push({ goal, lessonIds });
  }
  return groups;
}

/** The best first step for these goals: the first lesson of
 *  `recommendedLessons(goals)`, or undefined. */
export function firstRecommendedLesson(goals: readonly IntroGoal[]): string | undefined {
  return recommendedLessons(goals)[0]?.lessonIds[0];
}

/** Adds or removes `goal`; the result is kept in INTRO_GOALS order. Pure. */
export function toggleGoal(goals: readonly IntroGoal[], goal: IntroGoal): IntroGoal[] {
  const on = !goals.includes(goal);
  return INTRO_GOALS.filter((g) => (g === goal ? on : goals.includes(g)));
}

/** The picked goals survive a close and a reload, like the page — a per-viewer
 *  convenience in localStorage, as a JSON array. */
const GOALS_KEY = storageKey("intro.goals");

/** The remembered goals in INTRO_GOALS order; unknown ids and garbage are
 *  dropped, and any storage error reads as none picked. */
export function readIntroGoals(): IntroGoal[] {
  try {
    const raw = localStorage.getItem(GOALS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isIntroGoal);
    return INTRO_GOALS.filter((g) => valid.includes(g));
  } catch {
    return [];
  }
}

/** Remembers the picked goals; none picked removes the key. */
export function writeIntroGoals(goals: readonly IntroGoal[]): void {
  try {
    const picked = INTRO_GOALS.filter((g) => goals.includes(g));
    if (picked.length === 0) localStorage.removeItem(GOALS_KEY);
    else localStorage.setItem(GOALS_KEY, JSON.stringify(picked));
  } catch {
    // Private window / blocked storage: the goals simply aren't remembered.
  }
}

/** The agent CLIs the intro walks through, in display order — the same three
 *  the + menu shows compact by default (`DEFAULT_COMPACT_AGENT_IDS`). Ids are
 *  the backend registry's (`commands::agents::AGENTS`); every other CLI stays
 *  one click away in Settings → Manage CLIs. */
export const FEATURED_AGENT_IDS = ["claude", "codex", "opencode", "antigravity", "gemini"] as const;
export type FeaturedAgentId = (typeof FEATURED_AGENT_IDS)[number];

/** What the optional "sign in now" button runs in a terminal tab: each CLI's
 *  own first-run login (Tabtivity does no agent login itself; the first agent tab
 *  would ask the same). Interactive — a browser handoff or a pasted key — which
 *  is why it is a visible terminal and never a headless call. */
export const AGENT_SIGN_IN_CMD: Record<FeaturedAgentId, string> = {
  claude: "claude",
  codex: "codex login",
  opencode: "opencode auth login",
  antigravity: "agy",
  gemini: "gemini",
};

/** How to leave the session a "sign in now" command opens — `claude` and
 *  `gemini` stay open as a full session in the root folder once signed in;
 *  `codex login` and `opencode auth login` are one-shots and need none. */
export const AGENT_SIGN_IN_EXIT: Partial<Record<FeaturedAgentId, string>> = {
  claude: "/exit",
  gemini: "/quit",
};

export const AGENT_SIGN_IN_KEYS: Record<FeaturedAgentId, TranslationKey> = {
  claude: "intro.agents.signIn.claude",
  codex: "intro.agents.signIn.codex",
  opencode: "intro.agents.signIn.opencode",
  antigravity: "intro.agents.signIn.antigravity",
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
