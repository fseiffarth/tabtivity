/**
 * The container's **scope** (#38): which of a project's tabs actually run inside
 * it — everything, or agent tabs only.
 *
 * The rule lives in the backend (`services::sandbox::resolve_spawn_authority`,
 * which re-derives it from the trusted project record and is the authority). What
 * is tested here is the renderer's *copy* of it in `PaneSlot` (the pane layer's
 * per-tab derivation, `components/layout/PaneSlot.tsx`), which exists for
 * two things the backend cannot do: the flag is one of `TerminalView`'s spawn
 * dependencies, so it is what respawns a live shell when the scope changes — a
 * frontend that ignored `scope` would leave that shell running inside the
 * container indefinitely — and it keeps the renderer from claiming a container the
 * backend is about to take away, which would otherwise log an authority downgrade
 * on every ordinary shell spawn.
 *
 * The derivation is `lib/projectTabHost.tabRunsInContainer`, one copy that
 * `PaneSlot` and the Mobile bridge (is a tab reachable from the phone) share;
 * the last test pins that `PaneSlot` still asks it.
 */

import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import type { ProjectEntry, SandboxScope } from "../../types";
import { tabRunsInContainer } from "../../lib/projectTabHost";

type Kind = "agent" | "shell" | "local_agent" | "files";

/** `PaneSlot`'s rule (now `lib/projectTabHost.tabRunsInContainer`), over the
 * options these tests vary. */
function sandboxFor(opts: {
  kind: Kind;
  scopeKey: string;
  enabled: boolean;
  scope?: SandboxScope;
  remote?: boolean;
}): boolean {
  const entry = {
    sandbox: { enabled: opts.enabled, ...(opts.scope ? { scope: opts.scope } : {}) },
    ...(opts.remote ? { remote: { host: "h", user: "u", path: "/p" } } : {}),
  } as unknown as ProjectEntry;
  return tabRunsInContainer(entry, opts.kind, opts.scopeKey);
}

const project = { scopeKey: "p1", enabled: true } as const;

describe("container scope", () => {
  it("contains every PTY tab when the scope is 'all'", () => {
    expect(sandboxFor({ ...project, kind: "agent", scope: "all" })).toBe(true);
    expect(sandboxFor({ ...project, kind: "shell", scope: "all" })).toBe(true);
  });

  it("treats a spec with no scope key as 'all'", () => {
    // The migration-free promise: a project that enabled the container before the
    // setting existed must not silently drop its shells onto the host.
    expect(sandboxFor({ ...project, kind: "shell" })).toBe(true);
    expect(sandboxFor({ ...project, kind: "agent" })).toBe(true);
  });

  it("leaves shells on the host under 'agents', and only shells", () => {
    // This is the whole feature: the viewer's Run/Debug opens a SHELL tab, so
    // this is what puts a host .venv back within reach.
    expect(sandboxFor({ ...project, kind: "shell", scope: "agents" })).toBe(false);
    expect(sandboxFor({ ...project, kind: "agent", scope: "agents" })).toBe(true);
  });

  it("never contains anything when the toggle is off", () => {
    // The scope narrows; it can never grant. Mirrors the backend test of the
    // same name — a project with the container OFF but a stored `scope` must not
    // acquire one.
    for (const scope of ["all", "agents"] as const) {
      expect(sandboxFor({ ...project, kind: "agent", enabled: false, scope })).toBe(false);
      expect(sandboxFor({ ...project, kind: "shell", enabled: false, scope })).toBe(false);
    }
  });

  it("never contains a remote project's tabs, or the root scope's", () => {
    expect(sandboxFor({ ...project, kind: "agent", scope: "all", remote: true })).toBe(false);
    expect(sandboxFor({ kind: "agent", scopeKey: "root", enabled: true, scope: "all" })).toBe(
      false,
    );
  });

  it("leaves a host-bound local_agent tab alone under either scope", () => {
    // Ollama driver tabs depend on the host's server and wiring; they were never
    // containerized and the scope must not change that in either direction.
    for (const scope of ["all", "agents"] as const) {
      expect(sandboxFor({ ...project, kind: "local_agent", scope })).toBe(false);
    }
  });

  it("changing the scope flips the flag, which is what respawns the tab", () => {
    // The flag is a spawn dep in TerminalView. If it did NOT change here, a shell
    // running inside the container when the user picks agents-only would stay
    // there — the failure this frontend copy exists to prevent.
    const before = sandboxFor({ ...project, kind: "shell", scope: "all" });
    const after = sandboxFor({ ...project, kind: "shell", scope: "agents" });
    expect(before).not.toBe(after);
    // …and an agent tab's flag does not change, so its conversation is not
    // restarted by a setting that does not concern it.
    expect(sandboxFor({ ...project, kind: "agent", scope: "all" })).toBe(
      sandboxFor({ ...project, kind: "agent", scope: "agents" }),
    );
  });

  it("is the expression PaneSlot actually spawns with", () => {
    // The tripwire: a refactor that inlines a second copy in the component makes
    // every assertion in this file describe code that no longer runs.
    // Repo-relative, the convention the other tripwire tests use (vitest runs
    // from the repo root).
    const src = readFileSync("src/components/layout/PaneSlot.tsx", "utf8") as string;
    expect(src).toContain("const sandbox = tabRunsInContainer(paneProject, tab.kind, scopeKey);");
  });
});
