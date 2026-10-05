/**
 * The HPC **workspace** helpers (`lib/remote/hpc/hpcWorkspace.ts`), all pure. A workspace is
 * a time-limited directory on a cluster's parallel filesystem — the place a
 * project's data must live so it never fills the user's home quota — and it is
 * *deleted* when it expires. These tests pin the two things the UI derives from a
 * workspace: where a project inside it goes (the whole integration is that this
 * path becomes the project's remote root), and how loudly the remaining time is
 * said.
 */
import { describe, it, expect } from "vitest";
import {
  projectPathIn,
  remainingLabel,
  expiryTone,
  defaultFilesystem,
  defaultAnchorRel,
  logOutputPattern,
  freeSpaceLabel,
  findProjectWorkspace,
  shouldWarnExpiry,
  wsTargetForHost,
  wsTargetForProject,
  type HpcWorkspace,
} from "../../lib/remote/hpc/hpcWorkspace";
import { BRAND } from "../../lib/brand";

const WS: HpcWorkspace = {
  id: "demo",
  path: "/lustre/scratch/data/alice-demo",
  filesystem: "scratch",
  remaining: "89 days 23 hours",
  remaining_days: 89,
  extensions: 3,
};

describe("projectPathIn", () => {
  it("puts the project inside the workspace", () => {
    expect(projectPathIn(WS, "my-experiment")).toBe(
      "/lustre/scratch/data/alice-demo/my-experiment",
    );
  });

  it("tolerates a trailing slash and an empty name", () => {
    expect(projectPathIn({ path: "/lustre/x/" }, "p")).toBe("/lustre/x/p");
    expect(projectPathIn(WS, "")).toBe("/lustre/scratch/data/alice-demo");
  });
});

describe("remainingLabel", () => {
  it("summarizes days and extensions", () => {
    expect(remainingLabel(WS)).toBe("89 days left · 3 extensions");
  });

  it("singularizes", () => {
    expect(remainingLabel({ ...WS, remaining_days: 1, extensions: 1 })).toBe(
      "1 day left · 1 extension",
    );
  });

  it("falls back to the tooling's own phrasing, and says nothing when it said nothing", () => {
    const { remaining_days: _d, extensions: _e, ...rest } = WS;
    expect(remainingLabel(rest)).toBe("89 days 23 hours left");
    expect(remainingLabel({ id: "x", path: "/x" })).toBe("");
  });
});

describe("expiryTone", () => {
  it("escalates as the deletion date approaches", () => {
    expect(expiryTone(WS)).toBe("ok");
    expect(expiryTone({ ...WS, remaining_days: 7 })).toBe("warn");
    expect(expiryTone({ ...WS, remaining_days: 2 })).toBe("urgent");
    expect(expiryTone({ ...WS, remaining_days: 0 })).toBe("urgent");
  });

  it("invents no colour when the site reported no remaining time", () => {
    expect(expiryTone({ id: "x", path: "/x" })).toBe("none");
  });
});

describe("defaultFilesystem", () => {
  it("is the location the site itself marked default", () => {
    expect(
      defaultFilesystem({
        available: true,
        filesystems: [
          { name: "scratch", default: true },
          { name: "mlnvme", default: false },
        ],
      }),
    ).toBe("scratch");
    expect(defaultFilesystem({ available: true, filesystems: [] })).toBeUndefined();
    expect(defaultFilesystem(null)).toBeUndefined();
  });
});

describe("the home anchor", () => {
  it(`defaults to ${BRAND.slug}/<safe-name> under the cluster home`, () => {
    expect(defaultAnchorRel("my-experiment")).toBe(`${BRAND.slug}/my-experiment`);
    // Anything the backend's path-segment validation would reject is folded out
    // here rather than surfacing as a remote error.
    expect(defaultAnchorRel("my project!")).toBe(`${BRAND.slug}/my-project`);
    expect(defaultAnchorRel("")).toBe(`${BRAND.slug}/project`);
  });

  it("routes job logs into it with SLURM's own job-id token", () => {
    expect(logOutputPattern(`/home/u/${BRAND.slug}/p/logs`)).toBe(`/home/u/${BRAND.slug}/p/logs/slurm-%j.out`);
    expect(logOutputPattern(`/home/u/${BRAND.slug}/p/logs/`)).toBe(`/home/u/${BRAND.slug}/p/logs/slurm-%j.out`);
  });
});

describe("findProjectWorkspace", () => {
  const list: HpcWorkspace[] = [
    { id: "other", path: "/lustre/scratch/data/alice-other" },
    WS,
  ];

  it("prefers the recorded id — the handle that survives the directory", () => {
    expect(findProjectWorkspace(list, { workspace_id: "demo" }, undefined)?.id).toBe("demo");
  });

  it("falls back to the workspace the project's root sits inside", () => {
    expect(
      findProjectWorkspace(list, undefined, "/lustre/scratch/data/alice-demo/my-experiment")?.id,
    ).toBe("demo");
    // The root IS the workspace (no sub-folder) still counts.
    expect(findProjectWorkspace(list, undefined, "/lustre/scratch/data/alice-demo")?.id).toBe("demo");
  });

  it("does not match a workspace that merely shares a path prefix", () => {
    // `…alice-demo2` starts with `…alice-demo` as a *string*, but is another
    // workspace — matching it would point Extend at the wrong allocation.
    expect(
      findProjectWorkspace(list, undefined, "/lustre/scratch/data/alice-demo2/p"),
    ).toBeUndefined();
    expect(findProjectWorkspace(list, undefined, undefined)).toBeUndefined();
  });

  it("survives a recorded id the host no longer lists (a released workspace)", () => {
    expect(findProjectWorkspace(list, { workspace_id: "gone" }, undefined)).toBeUndefined();
  });
});

describe("shouldWarnExpiry", () => {
  it("warns inside the last week, never without a reading", () => {
    expect(shouldWarnExpiry(WS)).toBe(false);
    expect(shouldWarnExpiry({ ...WS, remaining_days: 7 })).toBe(true);
    expect(shouldWarnExpiry({ ...WS, remaining_days: 1 })).toBe(true);
    expect(shouldWarnExpiry({ id: "x", path: "/x" })).toBe(false);
    expect(shouldWarnExpiry(undefined)).toBe(false);
  });
});

describe("freeSpaceLabel", () => {
  it("scales the probe's KiB into binary units, and says nothing when df did not", () => {
    expect(freeSpaceLabel(512)).toBe("512 KB free");
    expect(freeSpaceLabel(1024 * 1024 * 1024 * 2)).toBe("2.0 TB free");
    expect(freeSpaceLabel(undefined)).toBe("");
    expect(freeSpaceLabel(NaN)).toBe("");
  });
});

describe("targets", () => {
  it("a host target carries the credential only when there is one", () => {
    expect(wsTargetForHost({ user: "alice", host: "cluster", port: 22 }, "pw")).toEqual({
      user: "alice",
      host: "cluster",
      port: 22,
      password: "pw",
    });
    // No password ⇒ the field is absent, so the backend falls through to a saved
    // credential and then to key/agent auth rather than being handed "".
    expect(wsTargetForHost({ user: null, host: "cluster", port: null }, "")).toEqual({
      user: undefined,
      host: "cluster",
      port: undefined,
    });
  });

  it("a project target names the project, and a host only when it isn't the primary", () => {
    expect(wsTargetForProject(`/home/u/.local/share/${BRAND.slug}/remote-projects/p`)).toEqual({
      projectDir: `/home/u/.local/share/${BRAND.slug}/remote-projects/p`,
    });
    expect(wsTargetForProject("/dir", "worker-1")).toEqual({
      projectDir: "/dir",
      hostId: "worker-1",
    });
  });
});
