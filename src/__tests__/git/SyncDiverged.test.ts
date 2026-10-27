/**
 * The diverged (orange) list's direction badge. The verdict comes from the
 * backend's per-side base comparison (`host_diverged`/`local_diverged`), never
 * from comparing the two machines' mtimes against each other — clock skew
 * between a host and the local machine must not be able to pick the wrong
 * authority. The mtimes stay display metadata (the tooltip's "modified when").
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { mtimeDivergenceCue } from "../../components/files/ProjectFilesView";
import { splitByDeleteSide, splitByNewerSide, withoutChangedOnBoth } from "../../stores/remote/sync";
import type { TranslationKey } from "../../lib/i18n";

// The cue's text is asserted as the raw key — the wording is i18n's business.
const t = (key: TranslationKey) => key as string;

describe("mtimeDivergenceCue", () => {
  it("both sides gone, host actually checked → goneBothSides, neutral", () => {
    const cue = mtimeDivergenceCue(t, null, null, false, true, true);
    expect(cue.text).toBe("projectFilesView.goneBothSides");
    expect(cue.tone).toBe("neutral");
  });

  it("both mtimes null but host NOT checked → deleted-locally badge, never a host claim", () => {
    // A cold pool reports every host mtime as null without asking the host;
    // "gone on both sides" would assert a deletion nobody verified.
    const cue = mtimeDivergenceCue(t, null, null, false, true, false);
    expect(cue.text).toBe("projectFilesView.localGoneHostUnchecked");
    expect(cue.tone).toBe("neutral");
  });

  it("host gone → localOnly, local tone", () => {
    const cue = mtimeDivergenceCue(t, null, 100, false, true, true);
    expect(cue.text).toBe("projectFilesView.localOnly");
    expect(cue.tone).toBe("local");
  });

  it("local gone → remoteOnly, remote tone", () => {
    const cue = mtimeDivergenceCue(t, 100, null, true, false, true);
    expect(cue.text).toBe("projectFilesView.remoteOnly");
    expect(cue.tone).toBe("remote");
  });

  it("both present, only the host moved → remote", () => {
    const cue = mtimeDivergenceCue(t, 100, 200, true, false, true);
    expect(cue.text).toBe("projectFilesView.remoteNewer");
    expect(cue.tone).toBe("remote");
  });

  it("both present, only the local moved → local", () => {
    const cue = mtimeDivergenceCue(t, 200, 100, false, true, true);
    expect(cue.text).toBe("projectFilesView.localNewer");
    expect(cue.tone).toBe("local");
  });

  it("both moved → bothChanged, neutral", () => {
    const cue = mtimeDivergenceCue(t, 100, 200, true, true, true);
    expect(cue.text).toBe("projectFilesView.bothChanged");
    expect(cue.tone).toBe("neutral");
  });

  it("the direction wins even when the mtime comparison says the opposite", () => {
    // Clock skew: the host's clock runs ahead (hostMtime > localMtime), but only
    // the LOCAL side moved from its recorded base — the badge must say local.
    const cue = mtimeDivergenceCue(t, 5000, 100, false, true, true);
    expect(cue.text).toBe("projectFilesView.localNewer");
    expect(cue.tone).toBe("local");
  });

  it("neither flagged (self-heal race) → sameTime, neutral", () => {
    const cue = mtimeDivergenceCue(t, 100, 100, false, false, true);
    expect(cue.text).toBe("projectFilesView.sameTime");
    expect(cue.tone).toBe("neutral");
  });
});

describe("splitByNewerSide", () => {
  const e = (hostMtime: number | null, localMtime: number | null, hostDiverged: boolean, localDiverged: boolean) =>
    ({ state: "amber", selected: true, isDir: false, auto: false, excluded: false, hostMtime, localMtime, hostDiverged, localDiverged, hostChecked: true }) as never;

  it("direction wins over mtimes, both-changed falls back to mtimes, deletions and ties are skipped", () => {
    const map = {
      "host.txt": e(100, 5000, true, false), // skewed clocks: only the host moved
      "local.txt": e(5000, 100, false, true),
      "both-host.txt": e(300, 200, true, true),
      "both-local.txt": e(200, 300, true, true),
      "tie.txt": e(100, 100, true, true),
      "gone-host.txt": e(null, 100, false, true),
      "gone-local.txt": e(100, null, true, false),
    };
    const out = splitByNewerSide(map, [...Object.keys(map), "unknown.txt"]);
    expect(out.host).toEqual(["host.txt", "both-host.txt"]);
    expect(out.local).toEqual(["local.txt", "both-local.txt"]);
  });
});

describe("withoutChangedOnBoth", () => {
  const e = (hostMtime: number | null, localMtime: number | null, hostDiverged: boolean, localDiverged: boolean) =>
    ({ state: "amber", selected: true, isDir: false, auto: false, excluded: false, hostMtime, localMtime, hostDiverged, localDiverged, hostChecked: true }) as never;

  it("drops only files both sides changed with both copies present, keeping order", () => {
    const map = {
      "a-host.txt": e(100, 200, true, false),
      "b-both.txt": e(100, 200, true, true),
      "c-local.txt": e(100, 200, false, true),
      "d-gone-host.txt": e(null, 200, true, true), // a deletion, not an edit on both
      "e-neither.txt": e(100, 100, false, false),
    };
    expect(withoutChangedOnBoth(map, [...Object.keys(map), "unknown.txt"])).toEqual([
      "a-host.txt",
      "c-local.txt",
      "d-gone-host.txt",
      "e-neither.txt",
      "unknown.txt",
    ]);
  });
});

describe("splitByDeleteSide", () => {
  const e = (hostMtime: number | null, localMtime: number | null, hostChecked: boolean) =>
    ({ state: "amber", selected: true, isDir: false, auto: false, excluded: false, hostMtime, localMtime, hostDiverged: false, localDiverged: true, hostChecked }) as never;

  it("deleted locally → host, deleted on a checked host → local; unchecked host, both sides and both gone are skipped", () => {
    const map = {
      "gone-local.txt": e(100, null, true),
      "gone-host.txt": e(null, 100, true),
      "cold-pool.txt": e(null, 100, false), // host never asked: no deletion to complete
      "both.txt": e(100, 200, true),
      "gone-both.txt": e(null, null, true),
    };
    const out = splitByDeleteSide(map, [...Object.keys(map), "unknown.txt"]);
    expect(out.host).toEqual(["gone-local.txt"]);
    expect(out.local).toEqual(["gone-host.txt"]);
  });
});
