import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RunningShells, shownShells } from "../../../mobile-web/src/components/RunningShells";
import type { RunningShell } from "../../../mobile-web/src/api";

afterEach(cleanup);

const waiting: RunningShell = { command: "", description: "Run the tests" };
const background: RunningShell = { command: "", background: true };

describe("the phone chat's running shells", () => {
  it("shows a shell the agent waits on only while it works, a background one always", () => {
    expect(shownShells([waiting, background], true)).toEqual([waiting, background]);
    expect(shownShells([waiting, background], false)).toEqual([background]);
    expect(shownShells(undefined, true)).toEqual([]);
  });

  it("names each shell by its description and says which run in the background", () => {
    render(<RunningShells shells={[waiting, background]} />);
    const rows = screen.getAllByRole("status");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Shell is running…");
    expect(rows[0].textContent).toContain("Run the tests");
    expect(rows[1].textContent).toContain("Background shell running…");
  });

  it("opens a shell's whole command on a tap, cut as the desktop cut it", () => {
    const long: RunningShell = { command: "npm run build\n  && npm test", description: "Build and test", cut: true };
    render(<RunningShells shells={[long, { command: "make -j4", background: true }, waiting]} />);
    // No command, no toggle; no description, the command's first line names it.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getAllByRole("status")[1].textContent).toContain("make -j4");
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Show the command it runs" })[0]);
    expect(document.querySelector("pre")?.textContent).toBe("npm run build\n  && npm test…");
    fireEvent.click(screen.getByRole("button", { name: "Hide the command" }));
    expect(document.querySelector("pre")).toBeNull();
  });

  it("tags the rows while the feature is untested", () => {
    render(<RunningShells shells={[background]} untested="Untested" />);
    expect(screen.getByRole("status").textContent).toContain("Untested");
  });
});
