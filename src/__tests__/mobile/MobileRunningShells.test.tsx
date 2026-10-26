import { cleanup, render, screen } from "@testing-library/react";
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

  it("tags the rows while the feature is untested", () => {
    render(<RunningShells shells={[background]} untested="Untested" />);
    expect(screen.getByRole("status").textContent).toContain("Untested");
  });
});
