/**
 * The file-list icon: `fileIconKind` maps an extension to a drawn icon, and
 * `FileIcon` renders it as a theme-following `currentColor` SVG — never a
 * colour-emoji glyph, which ignored the theme and the dimmed-row colour.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { fileIconKind } from "../../lib/viewers/fileUtils";
import { FileIcon } from "../../components/common/icons/FileIcon";

describe("fileIconKind", () => {
  it("groups extensions into icon kinds", () => {
    for (const ext of [".py", ".rs", ".ts", ".tsx", ".js", ".jsx"]) {
      expect(fileIconKind(ext)).toBe("code");
    }
    expect(fileIconKind(".md")).toBe("text");
    expect(fileIconKind(".json")).toBe("data");
    expect(fileIconKind(".bib")).toBe("book");
    expect(fileIconKind(".png")).toBe("image");
    expect(fileIconKind(".svg")).toBe("image");
    expect(fileIconKind(".sh")).toBe("script");
  });

  it("falls back to the plain page for unknown or missing extensions", () => {
    expect(fileIconKind(".xyz")).toBe("file");
    expect(fileIconKind("")).toBe("file");
    expect(fileIconKind(null)).toBe("file");
  });
});

describe("FileIcon", () => {
  it("renders a hidden currentColor svg and no emoji text", () => {
    const { container } = render(<FileIcon ext=".py" />);
    const svg = container.querySelector("svg.app-icon");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelector("g")?.getAttribute("stroke")).toBe("currentColor");
    expect(container.textContent).toBe("");
  });

  it("draws a folder for directories whatever the extension", () => {
    const folder = render(<FileIcon ext=".py" isDir />).container.innerHTML;
    const plainFolder = render(<FileIcon ext={null} isDir />).container.innerHTML;
    const code = render(<FileIcon ext=".py" />).container.innerHTML;
    expect(folder).toBe(plainFolder);
    expect(folder).not.toBe(code);
  });
});
