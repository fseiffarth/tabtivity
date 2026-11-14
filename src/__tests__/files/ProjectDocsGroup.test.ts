import { describe, expect, it } from "vitest";
import { buildDocsGroup } from "../../components/files/projectDocsGroup";
import type { DocState, DocStatus } from "../../lib/projects/projectDocs";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const entry = (name: string, is_dir = false): FileEntry => ({
  name, path: `/p/${name}`, is_dir, size: 0, extension: null, mime: null,
});
const st = (name: string, state: DocState, extra: Partial<DocStatus> = {}): DocStatus => ({
  name, state, nestedUnder: null, creatable: true, ...extra,
});
const names = (rows: ReturnType<typeof buildDocsGroup>["rows"]) =>
  rows.map((r) => (r.kind === "ghost" ? `+${r.name}` : r.entry.name));

describe("buildDocsGroup", () => {
  it("shows the listing as it is, with no states, ghosts or summary, before the status arrives", () => {
    const g = buildDocsGroup([entry("AGENTS.md"), entry("README.md")], null);
    expect(names(g.rows)).toEqual(["AGENTS.md", "README.md"]);
    expect(g.summary).toBeNull();
    expect(g.rows.every((r) => r.kind === "file" && r.state === null && !r.nested)).toBe(true);
  });

  it("adds a ghost row per missing creatable doc, after the files, in catalog order", () => {
    const g = buildDocsGroup(
      [entry("AGENTS.md"), entry("README.md"), entry(".gitignore")],
      [
        st("AGENTS.md", "edited"), st("README.md", "edited"),
        st("PROJECT.md", "missing"), st("TODO.md", "missing"), st("ROADMAP.md", "missing", { creatable: false }),
      ],
    );
    expect(names(g.rows)).toEqual(["AGENTS.md", "README.md", ".gitignore", "+PROJECT.md", "+TODO.md"]);
    // Ghost rows are not files: the row cap / selection axis never see them.
    expect(g.files.map((e) => e.name)).toEqual(["AGENTS.md", "README.md", ".gitignore"]);
  });

  it("never makes a ghost of a doc the listing holds", () => {
    const g = buildDocsGroup([entry("TODO.md")], [st("TODO.md", "missing")]);
    expect(names(g.rows)).toEqual(["TODO.md"]);
  });

  it("nests a pointer file right under AGENTS.md, wherever the listing sorted it", () => {
    const g = buildDocsGroup(
      [entry("AGENTS.md"), entry("CLAUDE.md"), entry("GEMINI.md"), entry("README.md")],
      [
        st("AGENTS.md", "edited"), st("README.md", "edited"),
        st("CLAUDE.md", "pointer", { nestedUnder: "AGENTS.md", creatable: false }),
        st("GEMINI.md", "pointer", { nestedUnder: "AGENTS.md", creatable: false }),
      ],
    );
    expect(names(g.rows)).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md"]);
    expect(g.rows.map((r) => r.kind === "file" && r.nested)).toEqual([false, true, true, false]);
    // Selection and shift-range follow the flattened, nested order.
    expect(g.files.map((e) => e.name)).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md"]);
  });

  it("keeps a pointer file as an ordinary row when AGENTS.md is not there", () => {
    const g = buildDocsGroup(
      [entry("CLAUDE.md"), entry("README.md")],
      [
        st("AGENTS.md", "missing"), st("README.md", "edited"),
        st("CLAUDE.md", "pointer", { nestedUnder: "AGENTS.md", creatable: false }),
      ],
    );
    expect(names(g.rows)).toEqual(["CLAUDE.md", "README.md", "+AGENTS.md"]);
    expect(g.rows.some((r) => r.kind === "file" && r.nested)).toBe(false);
  });

  it("counts present defaults over defaults and the template rows, but not pointers", () => {
    const g = buildDocsGroup(
      [entry("AGENTS.md"), entry("CLAUDE.md"), entry("README.md"), entry("TODO.md")],
      [
        st("AGENTS.md", "template"), st("README.md", "edited"), st("TODO.md", "template"),
        st("CLAUDE.md", "pointer", { nestedUnder: "AGENTS.md", creatable: false }),
      ],
    );
    expect(g.summary).toEqual({ present: 2, total: 2, templates: 2 });
  });

  it("counts a missing default as absent from the summary", () => {
    const g = buildDocsGroup([entry("AGENTS.md")], [st("AGENTS.md", "edited"), st("README.md", "missing")]);
    expect(g.summary).toEqual({ present: 1, total: 2, templates: 0 });
    expect(names(g.rows)).toEqual(["AGENTS.md", "+README.md"]);
  });

  it("lets an edited doc (and a link reported as edited) stand without a template mark", () => {
    const g = buildDocsGroup([entry("AGENTS.md")], [st("AGENTS.md", "edited")]);
    expect(g.rows[0]).toMatchObject({ kind: "file", state: "edited" });
    expect(g.summary?.templates).toBe(0);
  });
});
