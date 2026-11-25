import { describe, expect, it } from "vitest";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { openCodeBannerPath, openCodeFullFooter } from "../../../mobile-web/src/terminal/openCodeMini";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

/**
 * The folder, branch and context OpenCode draws, read off the rows of 2.3.0
 * captures (stub model, `~/work` on `develop`) as `readableScreen` leaves them.
 * The full TUI prints the folder and branch at the idle footer's left end
 * (`~/work:develop`), the mini only in its start-up banner.
 */
let seq = 0;
const lines = (...rows: (string | ReadableLine)[]): ReadableLine[] =>
  rows.map((row) => typeof row !== "string" ? row : { key: `s${seq += 1}`, text: row, spans: row ? [{ text: row }] : [] });

/** The composer row as drawn: the model in the text colour, the provider muted. */
const composer = (lead = " "): ReadableLine => {
  const spans = [
    { text: `${lead}Build`, color: "#5c9cf5" },
    { text: " · ", color: "#808080" },
    { text: "stub", color: "#eeeeee" },
    { text: " Ollama (local)", color: "#808080" },
  ];
  return { key: `s${seq += 1}`, text: spans.map((span) => span.text).join(""), spans };
};
const box = (): ReadableLine[] => [...lines("", " Ask anything… \"Fix broken tests\"", ""), composer()];
const IDLE_FOOTER = " ~/work:develop                                                                             110 (0%)  ctrl+p commands";
const BUSY_FOOTER = " ⬝⬝■■⬝⬝⬝⬝ esc interrupt                                                       110 (0%)  ctrl+p commands";

describe(`${BRAND.display} OpenCode status line: full TUI footer`, () => {
  it("reads the folder, the branch and the context off the idle footer", () => {
    // `110 (0%)`: 110 tokens, 0% of the window used, so all of it is left.
    expect(sessionStatus(lines("stub answer done", ...box(), IDLE_FOOTER), "OpenCode"))
      .toEqual({ path: "~/work", branch: "develop", mode: "build", model: "stub", context: "100%" });
  });

  it("reads the start screen's centred footer", () => {
    const pad = " ".repeat(23);
    const screen = [
      ...lines(`${pad}┃  Ask anything… "What is the tech stack of this project?"`),
      composer(`${pad}┃  `),
      ...lines(`${pad}~/work:develop                            shift+tab agents  ctrl+p commands`, `${" ".repeat(113)}2.3.0`),
    ];
    expect(sessionStatus(screen, "OpenCode")).toMatchObject({ path: "~/work", branch: "develop", mode: "build", model: "stub" });
    expect(inputFrameStart(screen, "OpenCode")).toBe(0);
  });

  it("keeps a folder with no branch, and a branch with slashes", () => {
    expect(openCodeFullFooter(" ~/work   110 (0%)  ctrl+p commands")).toMatchObject({ path: "~/work" });
    expect(openCodeFullFooter(" ~/work   110 (0%)  ctrl+p commands")?.branch).toBeUndefined();
    expect(openCodeFullFooter(" ~/work:feature/x   ctrl+p commands")).toMatchObject({ path: "~/work", branch: "feature/x" });
    expect(openCodeFullFooter(" C:\\work:develop   ctrl+p commands")).toMatchObject({ path: "C:\\work", branch: "develop" });
    expect(openCodeFullFooter(" C:\\work   ctrl+p commands")).toMatchObject({ path: "C:\\work" });
  });

  it("reads a narrow footer the same, and no context where the window is unknown", () => {
    const screen = lines("", ...box(), " ~/work:develop        110  ctrl+p commands");
    expect(sessionStatus(screen, "OpenCode")).toEqual({ path: "~/work", branch: "develop", mode: "build", model: "stub" });
  });

  it("names no folder while the footer shows the spinner, and still reads the rest", () => {
    const screen = lines("", ...box(), BUSY_FOOTER);
    expect(sessionStatus(screen, "OpenCode")).toEqual({ mode: "build", model: "stub", context: "100%" });
  });

  it("does not read a folder out of output above the frame", () => {
    const screen = lines(
      "The footer reads",
      " ~/other:main      99 (50%)  ctrl+p commands",
      ...box(),
      BUSY_FOOTER,
    );
    expect(sessionStatus(screen, "OpenCode")?.path).toBeUndefined();
    expect(sessionStatus(screen, "Claude")).toBeNull();
    // The folder row is the frame's, so it is cut with it, not left as output.
    expect(inputFrameStart(lines("stub answer done", ...box(), IDLE_FOOTER), "OpenCode")).toBe(1);
  });
});

describe(`${BRAND.display} OpenCode status line: mini`, () => {
  const banner = "▪ oc mini v2.3.0 · ~/work";

  it("reads the folder from the banner, with no branch", () => {
    const screen = lines(
      banner, "", "› STUB:CALL shell {\"command\": \"touch shell.txt\"}", "", "stub answer done", "", "Build · stub · 189ms", "", "┃", "",
      "Build · stub · 110 (0%) · Ollama (local) · ctrl+p menu",
    );
    expect(sessionStatus(screen, "OpenCode")).toEqual({ path: "~/work", mode: "build", model: "stub", context: "100%" });
  });

  it("reads it from the start screen and at 30 columns", () => {
    const start = lines(banner, "", "┃ Ask anything, / for commands, @ for context…", "", "Build · stub · Ollama (local) · ctrl+p menu");
    expect(sessionStatus(start, "OpenCode")).toEqual({ path: "~/work", mode: "build", model: "stub" });
    expect(sessionStatus(lines(banner, "", "Build · stub · Ollama"), "OpenCode")).toMatchObject({ path: "~/work" });
  });

  it("reads the newest banner, and none of 1.x's block logo", () => {
    expect(openCodeBannerPath(lines(banner, "…", "▪ oc mini v2.3.0 · ~/other"))).toBe("~/other");
    expect(openCodeBannerPath(lines("█▀▀█  OpenCode", "█  █  ~/work"))).toBeUndefined();
  });

  it("takes no folder from prose, or when the banner has scrolled away", () => {
    expect(openCodeBannerPath(lines("The banner says oc mini v2.3.0 · ~/work", "█ done"))).toBeUndefined();
    expect(sessionStatus(lines("stub answer done", "", "Build · stub · 110 (0%) · Ollama · ctrl+p menu"), "OpenCode"))
      .toEqual({ mode: "build", model: "stub", context: "100%" });
  });
});
