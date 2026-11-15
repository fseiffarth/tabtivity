import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileName, FileNameCover, fileTypeChip, fitFileName, nameBreaks, splitFileName } from "../../../mobile-web/src/components/FileName";

describe("phone file names on tiles", () => {
  it("splits the stem from the last extension, not a dotfile's or a sentence's", () => {
    expect(splitFileName("InboxPreview.tsx")).toEqual({ stem: "InboxPreview", ext: ".tsx" });
    expect(splitFileName("MobileSaveStrands.test.tsx")).toEqual({ stem: "MobileSaveStrands.test", ext: ".tsx" });
    expect(splitFileName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(splitFileName("Makefile")).toEqual({ stem: "Makefile", ext: "" });
    expect(splitFileName("v1. final draft")).toEqual({ stem: "v1. final draft", ext: "" });
  });

  it("breaks at case changes and after separators, losing no character", () => {
    expect(nameBreaks("MobileSaveStrands")).toEqual(["Mobile", "Save", "Strands"]);
    expect(nameBreaks("remote_sync-guide.v2")).toEqual(["remote_", "sync-", "guide.", "v2"]);
    expect(nameBreaks("HTTPServer2Go").join("")).toBe("HTTPServer2Go");
    expect(nameBreaks("a__b")).toEqual(["a__", "b"]);
  });

  it("cuts a long name in the middle, keeping the extension and the stem's end", () => {
    expect(fitFileName("gates.sh", 30)).toBe("gates.sh");
    const cut = fitFileName("remote_sync_guide_for_new_contributors_v4.md", 30);
    expect(cut).toHaveLength(30);
    expect(cut.endsWith("ors_v4.md")).toBe(true);
    expect(cut.startsWith("remote_sync")).toBe(true);
    expect(cut).toContain("…");
  });

  it("gives a cover a type chip only for a short extension", () => {
    expect(fileTypeChip("gates.sh")).toBe("SH");
    expect(fileTypeChip("Makefile")).toBe("");
    expect(fileTypeChip("notes.markdown")).toBe("");
  });

  it("draws the whole name with the extension apart, and the cover's chip outside the name", () => {
    const { container } = render(<FileNameCover name="InboxPreview.tsx" nameClass="sent-index-name" />);
    const name = container.querySelector(".sent-index-name");
    expect(name?.textContent).toBe("InboxPreview.tsx");
    expect(name?.querySelectorAll("wbr")).toHaveLength(1);
    expect(name?.querySelector(".file-name-ext")?.textContent).toBe(".tsx");
    expect(container.querySelector(".file-name-chip")?.textContent).toBe("TSX");

    const { container: caption } = render(<FileName name="plot.png" max={30} />);
    expect(caption.textContent).toBe("plot.png");
  });
});
