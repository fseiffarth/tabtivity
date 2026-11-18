import { describe, expect, it } from "vitest";
import { isMuseTab, museFooter } from "../../../mobile-web/src/terminal/muse";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";

/**
 * Meta Muse Code as the phone and the desktop Reader read it. The rows are
 * real ones: Muse 1.4.15 and 1.3.0 (offline echo and stub providers) at
 * 120x40, 100x30 and 60x30, replayed through `readableScreen`, so the box's
 * rules are gone.
 */

let seq = 0;
const lines = (...texts: string[]): ReadableLine[] =>
  texts.map((text) => ({ key: `l${seq += 1}`, text, spans: text ? [{ text }] : [] }));

const LABEL = "Meta Muse Code";

const FOOTER = "  stub · high · ~/work · Auto-review";
const NOTICE =
  "  stub The Linux sandbox uses Bubblewrap and needs access to create user namespaces. · system SSH configuration project…";

describe("Muse tab label", () => {
  it("is matched by the word, not by a model that contains it", () => {
    expect(isMuseTab("Meta Muse Code")).toBe(true);
    expect(isMuseTab("Muse")).toBe(true);
    expect(isMuseTab("OpenCode")).toBe(false);
    expect(isMuseTab("Museum")).toBe(false);
    expect(isMuseTab(undefined)).toBe(false);
  });
});

describe("Muse footer", () => {
  it("reads model, effort, path and permission profile from the idle row", () => {
    const rows = lines("", "  Muse Code 1.4.15", "", "❯ hello", "", "◆ Hello! How can I help you today?", "", "❯", FOOTER);
    expect(sessionStatus(rows, LABEL)).toEqual({
      model: "stub",
      effort: "high",
      path: "~/work",
      mode: "auto-review",
    });
    expect(inputFrameStart(rows, LABEL)).toBe(6);
  });

  it("reads the same row while the turn is working", () => {
    const rows = lines(
      "",
      "  Muse Code 1.4.15",
      "",
      "❯ STUB:CALL write_file",
      "",
      "◇ Thinking (8s · esc to interrupt)",
      "└ Meta Model API response protocol error · retrying in 7s · attempt 5/10",
      "",
      "❯",
      FOOTER,
    );
    expect(sessionStatus(rows, LABEL)).toEqual({
      model: "stub",
      effort: "high",
      path: "~/work",
      mode: "auto-review",
    });
    expect(inputFrameStart(rows, LABEL)).toBe(7);
  });

  it("leaves out what the session does not draw", () => {
    const rows = lines("  Muse Code 1.3.0", "", "❯", "  echo · ~/work");
    expect(sessionStatus(rows, LABEL)).toEqual({ model: "echo", path: "~/work" });
    expect(museFooter("  echo · ~/work · Auto-review")).toEqual({
      model: "echo",
      path: "~/work",
      mode: "auto-review",
    });
  });

  it("reads the row on a narrow pane", () => {
    const rows = lines("  Muse Code 1.4.15", "", "◆ echo: hello there", "", "❯", "  echo · ~/work · Auto-review");
    expect(sessionStatus(rows, "Muse")).toEqual({ model: "echo", path: "~/work", mode: "auto-review" });
  });

  it("reads the other permission profiles", () => {
    expect(museFooter("  stub · ~/work · Read only")?.mode).toBe("read only");
    expect(museFooter("  stub · ~/work · Ask me")?.mode).toBe("ask me");
    expect(museFooter("  stub · ~/work · Unrestricted")?.mode).toBe("unrestricted");
  });

  it("never reads a segment cut by the pane's edge as a path", () => {
    expect(museFooter("  stub · high · ~/work/very/deep/proj…")).toEqual({ model: "stub", effort: "high" });
  });

  it("reads the slash menu's row as the menu, not as the directory", () => {
    const rows = lines(
      "◆ echo: hello there",
      "",
      "❯ /model [<model-id>]",
      "  /model  Choose model",
      "  echo · ~/work · Auto-review",
    );
    expect(sessionStatus(rows, LABEL)).toEqual({ model: "echo", path: "~/work", mode: "auto-review" });
    expect(inputFrameStart(rows, LABEL)).toBe(1);
  });
});

describe("Muse notice row", () => {
  it("takes the model and nothing from the notice that replaces the directory", () => {
    const rows = lines("", "  Muse Code 1.4.15", "", "❯", NOTICE);
    expect(sessionStatus(rows, LABEL)).toEqual({ model: "stub" });
    expect(inputFrameStart(rows, LABEL)).toBe(2);
  });

  it("ignores a notice drawn at the right end of 1.3.0's row", () => {
    const row =
      "  echo · ~/work                            The Linux sandbox uses Bubblewrap and needs access to create user namespaces.";
    expect(museFooter(row)).toEqual({ model: "echo", path: "~/work" });
  });

  it("reads no model from a notice that does not open with one", () => {
    expect(museFooter("  Press ctrl+c again to exit")).toEqual({});
    expect(museFooter("  Local models are disabled. Use /model to select another model.")).toEqual({});
  });

  it("keeps a path inside the notice from becoming the directory", () => {
    expect(museFooter("  stub See /etc/ssh/config for details · ~/work")).toEqual({ model: "stub" });
  });
});

describe("Muse is not mistaken for status", () => {
  it("reads nothing from output above a screen without a box", () => {
    const rows = lines("❯ remember the word pelican", "", "◆ echo: remember the word pelican", "", "hello");
    expect(sessionStatus(rows, LABEL) ?? {}).toEqual({});
  });

  it("does not read the transcript's own rows as the footer", () => {
    const rows = lines(
      "❯ list the files",
      "",
      "◆ ~/work · high · Auto-review",
      "",
      "❯",
      FOOTER,
    );
    expect(sessionStatus(rows, LABEL)).toEqual({
      model: "stub",
      effort: "high",
      path: "~/work",
      mode: "auto-review",
    });
  });

  it("leaves other agents to their own readers", () => {
    const rows = lines("❯", FOOTER);
    expect(sessionStatus(rows, "Claude")).not.toEqual(sessionStatus(rows, LABEL));
  });
});
