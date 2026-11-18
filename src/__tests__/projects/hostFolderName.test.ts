/** The one-folder rule for the folder a new remote project makes on its host. */
import { describe, it, expect } from "vitest";
import { hostFolderNameProblem } from "../../lib/projects/scaffold";

describe("hostFolderNameProblem", () => {
  it("accepts any one-segment spelling", () => {
    for (const ok of ["app", "My Thesis", "data.v2", "x_y-z", "Übung", " padded "]) {
      expect(hostFolderNameProblem(ok)).toBe("");
    }
  });

  it("asks for a name when blank", () => {
    expect(hostFolderNameProblem("")).toBe("required");
    expect(hostFolderNameProblem("   ")).toBe("required");
  });

  it("refuses paths, dot entries, a leading dash and control/format characters", () => {
    for (const bad of ["a/b", "a\\b", ".", "..", "-rf", "a\nb", "a‮b", "a​b"]) {
      expect(hostFolderNameProblem(bad)).toBe("invalid");
    }
  });
});
