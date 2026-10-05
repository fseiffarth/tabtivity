import { IS_MAC } from "../platform";
import { livePanelToggleLabel } from "./shortcutHint";
import type { TranslationKey } from "../i18n";

/** How to enter "focus mode" (panels hidden), translated. The key named is the
 *  one the user has, read live from `livePanelToggleLabel` — the same answer
 *  the key handler and the shortcut sheet use. Its default: a lone Super on a
 *  Linux desktop that leaves that key to the focused window (Cinnamon, XFCE),
 *  F9 where the shell claims it (GNOME, KDE) and on Windows (the Win key is
 *  OS-reserved). There used to be a constant here saying "Super" for every
 *  Linux desktop, which told a GNOME user to press the key that opens the
 *  overview. On macOS the Meta key is reserved for Cmd shortcuts, so the
 *  lone-key toggle is disabled (see useKeyboard) — there the panels stay
 *  reachable via the cursor-to-edge reveal. F11 always toggles fullscreen.
 *  Takes `t` as a parameter since this is a pure (store-free) helper. */
export function focusModeTip(t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  return IS_MAC
    ? t("onboarding.focusModeTipMac")
    : t("onboarding.focusModeTipOther", { key: livePanelToggleLabel() });
}

/** One numbered step in the first-run "How to start" instruction. The same copy
 *  feeds the dialog and the Feature Guide so onboarding stays in lockstep. */
export interface HowToStep {
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
}

export const HOW_TO_START_STEPS: HowToStep[] = [
  { titleKey: "howToStart.step2Title", bodyKey: "howToStart.step2Body" },
  { titleKey: "howToStart.step1Title", bodyKey: "howToStart.step1Body" },
  { titleKey: "howToStart.step3Title", bodyKey: "howToStart.step3Body" },
  { titleKey: "howToStart.step4Title", bodyKey: "howToStart.step4Body" },
];

/** Stable id for a contextual hint. Persisted in `settings.hints_seen`, so renaming
 *  one resets it for everyone — pick carefully. */
export type HintId =
  | "create-project"
  | "add-tab"
  | "toggle-panels"
  | "file-tree"
  | "codex-hook-trust";

/** Stable id for a hint's optional one-click action. An id rather than a callback
 *  so this module stays pure and store-free (and `HINTS` stays a plain constant);
 *  `HintHost` maps it to the handler. */
export type HintActionId = "codex-hooks";

/** A snapshot of the bits of app state the hint predicates care about, assembled
 *  by HintHost from the projects/tabs stores. Kept tiny and serializable-ish so
 *  predicates stay pure and testable. */
export interface HintCtx {
  /** Number of active project pills. */
  projectCount: number;
  /** The current project scope, or null at root / no active project. */
  activeId: string | null;
  /** A Codex tab is open and Codex is refusing to run Tabtivity's session hook, so
   *  resume is on the rollout-scanning fallback. Optional: absent means "not
   *  probed" (no Codex tab open), which is never eligible. */
  codexHookNeedsTrust?: boolean;
}

export interface HintDef {
  id: HintId;
  /** Higher wins when several hints are eligible at once (shown one at a time). */
  priority: number;
  /** `document.querySelector` selector for the element to point at, or null to
   *  render as a centered top banner (no anchor). */
  anchor: string | null;
  /** Which side of the anchor the bubble sits on. Ignored for banners. */
  placement: "top" | "bottom";
  titleKey: TranslationKey;
  /** Static body key, or null when the body is computed dynamically (see
   *  `resolveHintBody`) — only "toggle-panels" needs that, for its per-OS tip. */
  bodyKey: TranslationKey | null;
  /** An extra button that *does* the thing the hint is about, instead of only
   *  describing it. */
  action?: { labelKey: TranslationKey; id: HintActionId };
  /** Eligible to surface only while this returns true for the current context. */
  when: (ctx: HintCtx) => boolean;
}

export const HINTS: HintDef[] = [
  {
    // Actionable and situational rather than onboarding filler, so it outranks
    // everything but the empty-workspace prompt.
    id: "codex-hook-trust",
    priority: 90,
    anchor: null,
    placement: "top",
    titleKey: "hint.codexHookTitle",
    bodyKey: "hint.codexHookBody",
    action: { labelKey: "hint.codexHookAction", id: "codex-hooks" },
    when: (c) => c.codexHookNeedsTrust === true,
  },
  {
    id: "create-project",
    priority: 100,
    anchor: '[data-hint-anchor="add-project"]',
    placement: "bottom",
    titleKey: "hint.createProjectTitle",
    bodyKey: "hint.createProjectBody",
    when: (c) => c.projectCount === 0,
  },
  {
    id: "add-tab",
    priority: 80,
    anchor: '[data-hint-anchor="tab-add"]',
    placement: "bottom",
    titleKey: "hint.addTabTitle",
    bodyKey: "hint.addTabBody",
    when: (c) => c.activeId !== null,
  },
  {
    id: "toggle-panels",
    priority: 60,
    anchor: null,
    placement: "top",
    titleKey: "hint.togglePanelsTitle",
    bodyKey: null,
    when: (c) => c.activeId !== null,
  },
  {
    id: "file-tree",
    priority: 50,
    anchor: null,
    placement: "top",
    titleKey: "hint.fileTreeTitle",
    bodyKey: "hint.fileTreeBody",
    when: (c) => c.activeId !== null,
  },
];

/** Resolve a hint's body text. Every hint but "toggle-panels" is a static key;
 *  that one is the per-OS focus-mode tip, computed at read time. */
export function resolveHintBody(
  def: HintDef,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return def.bodyKey ? t(def.bodyKey) : focusModeTip(t);
}

/** Pure selection: the highest-priority unseen hint eligible for this context,
 *  or null. Returns null when hints are disabled. Exported for unit tests. */
export function pickHint(
  ctx: HintCtx,
  seen: ReadonlySet<string>,
  enabled: boolean,
): HintId | null {
  if (!enabled) return null;
  const eligible = HINTS.filter((h) => !seen.has(h.id) && h.when(ctx)).sort(
    (a, b) => b.priority - a.priority,
  );
  return eligible[0]?.id ?? null;
}
