import { describe, expect, it } from "vitest";
import {
  PROBE_BYTES,
  RELOAD_COOLDOWN_MS,
  RENDERER_CEILING_MB,
  decideWatchdog,
  formatRendererMemory,
  formatRssKib,
  ownRenderer,
  pickProbedPid,
  rendererName,
  shouldReplaceRenderer,
  ceilingFor,
  RENDERER_CEILING_RAM_SHARE,
  WORKING_SET_HEADROOM,
  type RendererRss,
} from "../../lib/window/rendererWatchdog";
import { BRAND } from "../../lib/brand";

const MB = 1024;

function row(pid: number, mb: number, label = "", title = ""): RendererRss {
  return { label, title, pid, rss_kib: mb * MB };
}

describe("rendererWatchdog / pickProbedPid", () => {
  const probeKib = PROBE_BYTES / 1024;

  it("names the one renderer that grew by the probe", () => {
    const before = [row(100, 1400), row(200, 4700)];
    const after = [row(100, 1400 + probeKib / MB), row(200, 4705)];
    expect(pickProbedPid(before, after)).toBe(100);
  });

  it("is ambiguous when another renderer grew a lot at the same instant", () => {
    const before = [row(100, 1400), row(200, 4700)];
    const after = [row(100, 1400 + probeKib / MB), row(200, 4700 + probeKib / MB)];
    expect(pickProbedPid(before, after)).toBeNull();
  });

  it("is ambiguous when nothing grew by enough", () => {
    const before = [row(100, 1400), row(200, 4700)];
    const after = [row(100, 1410), row(200, 4702)];
    expect(pickProbedPid(before, after)).toBeNull();
  });

  it("ignores a renderer that appeared between the samples and unattributed rows", () => {
    const before = [row(100, 1400)];
    const after = [row(100, 1400 + probeKib / MB), row(300, 900), row(0, 5000)];
    expect(pickProbedPid(before, after)).toBe(100);
  });
});

describe("rendererWatchdog / ownRenderer", () => {
  it("acts on this window's own renderer, not the largest one", () => {
    // The 2026-09-01 loop: main at 1.4 GB, a popout at 4.7 GB. The main
    // window must see ITS renderer and leave the popout to the popout.
    const all = [row(100, 1400, "main", BRAND.display), row(200, 4700, "detached-p1-g-1", `${BRAND.display} win-1`)];
    expect(ownRenderer(all, 100, false)?.rss_kib).toBe(1400 * MB);
    expect(ownRenderer(all, 200, false)?.rss_kib).toBe(4700 * MB);
  });

  it("reports the own pid as gone rather than substituting another renderer", () => {
    const all = [row(200, 4700)];
    expect(ownRenderer(all, 100, true)).toBeNull();
  });

  it("uses the unattributed reading when the backend cannot say", () => {
    const all = [row(0, 4300)];
    expect(ownRenderer(all, null, false)?.rss_kib).toBe(4300 * MB);
  });

  it("falls back to the largest renderer only once attribution was given up", () => {
    const all = [row(100, 1400), row(200, 4700)];
    expect(ownRenderer(all, null, false)).toBeNull();
    expect(ownRenderer(all, null, true)?.pid).toBe(200);
    expect(ownRenderer([], null, true)).toBeNull();
  });
});

describe("rendererWatchdog / decideWatchdog", () => {
  const now = 1_000_000_000;

  it("does nothing below the ceiling", () => {
    expect(decideWatchdog(RENDERER_CEILING_MB - 1, null, now)).toEqual({ action: "none" });
    expect(decideWatchdog(900, now - 1000, now)).toEqual({ action: "none" });
  });

  it("reloads over the ceiling when this window has not reloaded recently", () => {
    expect(decideWatchdog(4244, null, now)).toEqual({ action: "reload", mb: 4244 });
    expect(decideWatchdog(4244, now - RELOAD_COOLDOWN_MS, now)).toEqual({
      action: "reload",
      mb: 4244,
    });
  });

  it("holds instead of reloading again inside the cooldown", () => {
    // A reload 92 s ago did not bring the reading down: reloading again
    // would repeat the cost and free nothing — the loop this guards against.
    expect(decideWatchdog(4728, now - 92_000, now)).toEqual({
      action: "hold",
      mb: 4728,
      sinceReloadMs: 92_000,
    });
  });
});

describe("rendererWatchdog / ceilingFor", () => {
  it("is the fixed floor on a small machine or with no reading", () => {
    expect(ceilingFor(null, null)).toBe(RENDERER_CEILING_MB);
    expect(ceilingFor(8 * 1024, null)).toBe(RENDERER_CEILING_MB);
    expect(ceilingFor(0, null)).toBe(RENDERER_CEILING_MB);
  });

  it("scales with the machine's RAM once that share is more than the floor", () => {
    const ram = 64 * 1024;
    expect(ceilingFor(ram, null)).toBe(Math.round(ram * RENDERER_CEILING_RAM_SHARE));
    expect(ceilingFor(ram, null)).toBeGreaterThan(RENDERER_CEILING_MB);
  });

  it("sits over a confirmed working set with headroom, whichever is highest", () => {
    expect(ceilingFor(8 * 1024, 4800)).toBe(Math.round(4800 * WORKING_SET_HEADROOM));
    // A working set below the machine share does not lower the ceiling.
    expect(ceilingFor(64 * 1024, 4800)).toBe(Math.round(64 * 1024 * RENDERER_CEILING_RAM_SHARE));
    expect(ceilingFor(null, 0)).toBe(RENDERER_CEILING_MB);
  });
});

describe("rendererWatchdog / shouldReplaceRenderer", () => {
  const now = 1_000_000;

  it("replaces the process of a held window that never did so", () => {
    expect(shouldReplaceRenderer(null, now)).toBe(true);
  });

  it("replaces it once per cooldown, like the reload", () => {
    expect(shouldReplaceRenderer(now - 30_000, now)).toBe(false);
    expect(shouldReplaceRenderer(now - RELOAD_COOLDOWN_MS + 1, now)).toBe(false);
    expect(shouldReplaceRenderer(now - RELOAD_COOLDOWN_MS, now)).toBe(true);
  });
});

describe("rendererWatchdog / readout formatting", () => {
  it("names a renderer by its window title minus the app name, then label, then pid", () => {
    expect(rendererName({ label: "detached-p1-g-1", title: `${BRAND.display} win-1`, pid: 7 })).toBe("win-1");
    expect(rendererName({ label: "main", title: BRAND.display, pid: 7 })).toBe("main");
    expect(rendererName({ label: "", title: "", pid: 4242 })).toBe("pid 4242");
    expect(rendererName({ label: "", title: "", pid: 0 })).toBe("renderer");
  });

  it("prints MB below a gibibyte and one-decimal GB from there", () => {
    expect(formatRssKib(912 * MB)).toBe("912 MB");
    expect(formatRssKib(4736 * MB)).toBe("4.6 GB");
    expect(formatRssKib(1024 * MB)).toBe("1.0 GB");
  });
});

describe("rendererWatchdog / formatRendererMemory", () => {
  it("names the kind of memory and the largest mappings, in MB", () => {
    const clause = formatRendererMemory({
      pid: 7,
      rss_kib: 4_744_000,
      anon_kib: 4_600_000,
      file_kib: 100_000,
      shmem_kib: 44_000,
      top: [
        { name: "[anon]", rss_kib: 4_300_000 },
        { name: "[heap]", rss_kib: 200_000 },
      ],
    });
    expect(clause).toBe(
      " [anon 4492 MB, file 98 MB, shmem 43 MB; largest mappings: [anon] 4199 MB, [heap] 195 MB]",
    );
  });

  it("closes the clause without a mapping list when there is none", () => {
    expect(
      formatRendererMemory({ pid: 1, rss_kib: 0, anon_kib: 0, file_kib: 0, shmem_kib: 0, top: [] }),
    ).toBe(" [anon 0 MB, file 0 MB, shmem 0 MB]");
  });

  it("carries the thread count when the backend reports one", () => {
    // 575 threads is what the renderer that crashed on 2026-09-08 held: pdf.js
    // Workers left behind by rejected loads, which no mapping name says.
    expect(
      formatRendererMemory({
        pid: 1,
        rss_kib: 0,
        anon_kib: 0,
        file_kib: 0,
        shmem_kib: 0,
        top: [],
        threads: 575,
      }),
    ).toBe(" [anon 0 MB, file 0 MB, shmem 0 MB, 575 threads]");
  });
});
