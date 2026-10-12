/**
 * Threat recheck gap 38: a click on a link in rendered Markdown must never
 * navigate the app window. Every host — the markdown viewer, notebook cells,
 * the Skills preview, the prompt field's preview and the dev to-do board —
 * routes clicks through `onMarkdownLinkClick`: `#anchor`s scroll, local file
 * links open in a tab where the host has a file, and every other anchor
 * without a `target` is stopped.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderMarkdown } from "../../lib/viewers/markdown";
import { onMarkdownLinkClick, resolveLocalHref } from "../../lib/viewers/markdownLinks";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

const { skills } = vi.hoisted(() => ({
  skills: {
    PERSONAL_SKILLS: { kind: "personal" },
    projectSkills: (dir: string) => ({ kind: "project", dir }),
    listSkillSources: vi.fn(async () => [{ id: "s1", label: "Source", url: "https://example.com/s.git" }]),
    listSkillCatalog: vi.fn(async () => [
      { name: "linky", description: "has links", source_id: "s1", rel_path: "linky", has_scripts: false },
    ]),
    getSkillDetail: vi.fn(async () => ({
      name: "linky",
      description: "has links",
      body: "[local](docs/a.md) [anchor](#x) [unc](//evil.example/x)",
      files: [],
      has_scripts: false,
    })),
    listInstalledSkills: vi.fn(async () => []),
    addSkillSource: vi.fn(),
    removeSkillSource: vi.fn(),
    refreshSkillSource: vi.fn(),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
  },
}));
vi.mock("../../lib/agents/skills", () => skills);

/** Click every anchor under `root`; each must have been default-prevented
 *  (`fireEvent.click` returns false then), unless it opens its own context. */
function expectEveryLinkStopped(root: ParentNode) {
  const anchors = Array.from(root.querySelectorAll("a"));
  expect(anchors.length).toBeGreaterThan(0);
  for (const a of anchors) {
    const external = a.getAttribute("target") === "_blank";
    expect(fireEvent.click(a), a.outerHTML).toBe(external);
  }
}

function Host({ md, basePath, open }: { md: string; basePath?: string; open?: (t: string, h: string) => void }) {
  return (
    <div
      data-testid="host"
      onClick={(e) => onMarkdownLinkClick(e, { basePath, open })}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }}
    />
  );
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("onMarkdownLinkClick", () => {
  it("opens a local link through `open`, resolved against the file's folder", () => {
    const open = vi.fn();
    render(<Host md="[guide](docs/guide.md#setup)" basePath="/p/README.md" open={open} />);
    expect(fireEvent.click(screen.getByText("guide"))).toBe(false);
    expect(open).toHaveBeenCalledWith("/p/docs/guide.md", "docs/guide.md#setup");
  });

  it("stops a local link and opens nothing without a file to resolve it against", () => {
    const open = vi.fn();
    render(<Host md="[guide](docs/guide.md)" open={open} />);
    expect(fireEvent.click(screen.getByText("guide"))).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("scrolls to an in-page anchor and stops the navigation", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Host md={"# Setup\n\n[go](#setup)"} />);
    expect(fireEvent.click(screen.getByText("go"))).toBe(false);
    expect(scroll).toHaveBeenCalled();
  });

  it("leaves an external link to its own browsing context", () => {
    render(<Host md="[site](https://example.com/)" />);
    const a = screen.getByText("site");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(fireEvent.click(a)).toBe(true);
  });

  it("stops any other anchor without a target", () => {
    render(
      <div data-testid="raw" onClick={(e) => onMarkdownLinkClick(e)}>
        <a href="https://example.com/">bare</a>
      </div>,
    );
    expect(fireEvent.click(screen.getByText("bare"))).toBe(false);
  });

  // Review fix: `_self`/`_top`/`_parent` name this very window (a mermaid
  // label's HTML keeps them), and an image map's `<area>` navigates like an
  // anchor. Only `_blank` is left to its own browsing context.
  it.each(["_self", "_top", "_parent", "_SELF", "", "frame"])(
    "stops an anchor whose target is %j",
    (target) => {
      render(
        <div onClick={(e) => onMarkdownLinkClick(e)}>
          <a href="https://evil.example/" target={target}>
            <b>inner</b>
          </a>
        </div>,
      );
      expect(fireEvent.click(screen.getByText("inner"))).toBe(false);
    },
  );

  it("stops an image-map area, with or without a target", () => {
    render(
      <div onClick={(e) => onMarkdownLinkClick(e)}>
        <map name="m">
          <area data-testid="plain" href="https://evil.example/" alt="plain" />
          <area data-testid="self" href="https://evil.example/" target="_self" alt="self" />
        </map>
      </div>,
    );
    expect(fireEvent.click(screen.getByTestId("plain"))).toBe(false);
    expect(fireEvent.click(screen.getByTestId("self"))).toBe(false);
  });

  it("lets a click elsewhere through for the host's own handling", () => {
    const seen: boolean[] = [];
    render(
      <div onClick={(e) => seen.push(onMarkdownLinkClick(e))}>
        <span>text</span>
      </div>,
    );
    expect(fireEvent.click(screen.getByText("text"))).toBe(true);
    expect(seen).toEqual([false]);
  });
});

describe("resolveLocalHref — network paths", () => {
  it("refuses an encoded or file: network path from a local file", () => {
    expect(resolveLocalHref("/p/README.md", "%5C%5Cevil.example/x")).toBeNull();
    expect(resolveLocalHref("C:\\p\\README.md", "%5C%5Cevil.example\\x")).toBeNull();
    expect(resolveLocalHref("/p/README.md", "file://evil.example/share/x")).toBeNull();
  });

  it("keeps links inside the file's own share, and plain local ones", () => {
    expect(resolveLocalHref("\\\\srv\\share\\p\\README.md", "docs/a.md")).toBe("\\\\srv\\share\\p\\docs\\a.md");
    expect(resolveLocalHref("\\\\srv\\share\\p\\README.md", "file://srv/share/q.md")).toBe("\\\\srv\\share\\q.md");
    expect(resolveLocalHref("\\\\srv\\share\\p\\README.md", "file://other/share/q.md")).toBeNull();
    expect(resolveLocalHref("/p/README.md", "docs/a.md")).toBe("/p/docs/a.md");
    expect(resolveLocalHref("/p/README.md", "../q.md")).toBe("/q.md");
  });
});

// Each host, rendered for real: a click on any link in it is stopped.
describe("Markdown hosts stop link navigation", () => {
  const MD = "[local](docs/a.md) [anchor](#x) [site](https://example.com/)";

  it("the prompt field's preview", async () => {
    const { MarkdownPromptField } = await import("../../components/common/MarkdownPromptField");
    function Field() {
      const [value, setValue] = useState(MD);
      return <MarkdownPromptField value={value} onChange={setValue} ariaLabel="Prompt" />;
    }
    render(<Field />);
    fireEvent.click(screen.getByTitle("Render the prompt as Markdown"));
    expectEveryLinkStopped(screen.getByTestId("md-prompt-preview"));
  });

  it("the dev to-do board", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "dev_todo_groups") return [{ name: "g.md", title: "Group", open: 1, done: 0 }];
      if (cmd === "dev_todo_read") return `## Group\n- [ ] see ${MD}\n`;
      throw new Error(`unexpected ${cmd}`);
    });
    const { DevTodoView, resetDevTodoAvailability } = await import("../../components/files/DevTodoView");
    resetDevTodoAvailability();
    render(<DevTodoView active />);
    fireEvent.click(await screen.findByRole("button", { name: /Group/ }));
    await waitFor(() => expect(document.querySelector(".dev-todo-body a")).not.toBeNull());
    expectEveryLinkStopped(document.querySelector(".dev-todo-body")!);
    expect(mockInvoke).not.toHaveBeenCalledWith("dev_todo_write", expect.anything());
  });

  it("the Skills preview", async () => {
    const { SkillsLibraryView } = await import("../../components/skills/SkillsLibraryView");
    render(<SkillsLibraryView projectDir="/p" />);
    fireEvent.click(await screen.findByText("linky"));
    await waitFor(() => expect(document.querySelector(".skills-preview-body a")).not.toBeNull());
    expectEveryLinkStopped(document.querySelector(".skills-preview-body")!);
  });

  it("notebook markdown cells", async () => {
    const notebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: "markdown", metadata: {}, source: [MD] }],
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_file_text") return notebook;
      if (cmd === "file_mtime") return 1;
      return null;
    });
    const { NotebookView } = await import("../../components/embed/NotebookView");
    await act(async () => {
      render(<NotebookView path="/p/nb.ipynb" onOpenExternally={() => {}} />);
    });
    await waitFor(() => expect(document.querySelector(".notebook-cell-md a")).not.toBeNull());
    expectEveryLinkStopped(document.querySelector(".notebook-cell-md")!);
  });
});
