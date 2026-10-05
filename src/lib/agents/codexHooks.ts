import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { AGENT_ITEMS, buildStaticTabSpec } from "../../components/tabs/newTabItems";
import { translate, useI18nStore } from "../i18n";

/**
 * Whether Codex is actually running Tabtivity's `SessionStart` hook — the precise
 * way to follow a tab's *current* conversation (it survives `/clear`, and it
 * can't confuse two Codex tabs sharing a directory). Mirrors the backend's
 * `CodexHookState` (`services::agent_session`).
 *
 * Codex gates user-level hooks behind a one-time trust approval, and an
 * untrusted hook silently never fires. Tabtivity still resumes Codex tabs without
 * it — `services::codex_bind` reconstructs the session from Codex's own rollout
 * logs — but that is a heuristic, so it's worth one nudge to switch the exact
 * path on.
 */
export type CodexHookState =
  | "no_codex"
  | "not_registered"
  | "untrusted"
  | "disabled"
  | "enabled";

/**
 * The hook exists but Codex won't run it → resume is running on the fallback.
 *
 * Both states land here and they are **not** the same problem, which is why the
 * notice branches on the value rather than on this boolean: `untrusted` has no
 * verdict recorded at all (review it), while `disabled` already carries a
 * `trusted_hash` in `~/.codex/config.toml` and is merely toggled off (switch it
 * on — there is nothing left to approve). Telling the second user to "trust it"
 * sends them looking for an action they have already taken.
 */
export function codexHookNeedsTrust(state: CodexHookState | null): boolean {
  return state === "untrusted" || state === "disabled";
}

/**
 * One-click fix: open a Codex tab with `/hooks` already typed, so the user lands
 * directly in the list where the hook is enabled.
 *
 * Same policy as `runInstallInTab` — a command the user needs run is *run*, never
 * handed over to be copy-pasted. `TerminalView` submits `initialInput` once the
 * agent is up, and `buildStaticTabSpec` is reused so this is an ordinary Codex
 * tab (uid minted, `TABTIVITY_TAB_UID` set) that merely opens on a slash command.
 *
 * It opens in the **root** scope: the hook lives in `~/.codex/config.toml` and is
 * machine-global, not project-scoped. The active project is left alone — yanking
 * the user out of their scope from a hint click would be jarring — so a toast
 * points at the root terminal.
 */
export function openCodexHooksTab(): void {
  const item = AGENT_ITEMS.find((i) => i.cmd === "codex");
  if (!item) return;
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  useTabsStore.getState().addTabToScope("root", {
    // `item` is a built-in agent (no `labelKey`), so buildStaticTabSpec never
    // resolves a translation through this — the label below overrides it anyway.
    ...buildStaticTabSpec(item, rootDir, "", (key) => key),
    label: translate(useI18nStore.getState().lang, "codexHooks.tabLabel"),
    initialInput: "/hooks",
  });
  useProjectsStore.setState({
    switchToast: translate(useI18nStore.getState().lang, "codexHooks.toast"),
  });
}
