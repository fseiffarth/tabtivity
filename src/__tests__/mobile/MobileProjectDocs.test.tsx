/**
 * The phone library's "Project docs" group: the project root's scaffold fold
 * is the desktop tree's group — a header with `present/total · n template`,
 * template and pointer pills, pointer files nested under AGENTS.md, ghost rows
 * whose item menu creates the doc (`files/docs`, names only) where the phone
 * may add files, and a fold remembered per project.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesLibrary } from "../../../mobile-web/src/components/FilesLibrary";
import { storageKey } from "../../../src/lib/brand";
import type { DocStatus } from "../../../src/lib/projects/docStatus";

const text = "text/plain; charset=utf-8";
const doc = (name: string, state: DocStatus["state"], extra: Partial<DocStatus> = {}): DocStatus => ({
  name, state, nestedUnder: null, creatable: true, isDefault: name === "AGENTS.md" || name === "README.md", ...extra,
});
const DOCS: DocStatus[] = [
  doc("AGENTS.md", "template"),
  doc("README.md", "edited"),
  doc("PROJECT.md", "missing"),
  doc("TODO.md", "missing"),
  doc("CLAUDE.md", "pointer", { nestedUnder: "AGENTS.md", creatable: false }),
];
const ENTRIES = [
  { token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 },
  { token: "tok-agents", name: "AGENTS.md", kind: text, size: 20, modified: 1_770_000_000 },
  { token: "tok-claude", name: "CLAUDE.md", kind: text, size: 5, modified: 1_770_000_000 },
  { token: "tok-readme", name: "README.md", kind: text, size: 8, modified: 1_770_000_000 },
];

interface Host { uploads: boolean; docs: DocStatus[] | undefined; created: string[]; createAnswer: () => Response }

function hostWith(host: Host) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/files") {
      const entries = [...ENTRIES, ...host.created.map((name) => ({ token: `tok-${name}`, name, kind: text, size: 3, modified: 1_770_000_000 }))];
      const docs = host.docs?.map((row) => (host.created.includes(row.name) ? { ...row, state: "template" as const } : row));
      return new Response(JSON.stringify({ entries, truncated: false, uploads: host.uploads, ...(docs ? { docs } : {}) }), { status: 200 });
    }
    if (url.startsWith("/api/v1/projects/p1/files/docs?name=") && init?.method === "POST") return host.createAnswer();
    if (url.startsWith("/api/v1/projects/p1/files/raw")) return new Response("# new\n", { status: 200 });
    return new Response(JSON.stringify({ error: "file_not_found" }), { status: 404 });
  });
}

function renderLibrary() {
  render(<FilesLibrary projectId="p1" label="Alpha" onClose={() => {}} />);
  return screen.getByRole("dialog", { name: "Files" });
}

describe("Mobile library — Project docs group", () => {
  let host: Host;
  beforeEach(() => {
    localStorage.clear();
    host = {
      uploads: true,
      docs: DOCS,
      created: [],
      createAnswer: () => new Response(JSON.stringify({ entry: { token: "tok-PROJECT.md", name: "PROJECT.md", kind: text, size: 3, modified: 1_770_000_000 } }), { status: 201 }),
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("heads the group with present/total and the template count, nests a pointer, dims only a template", async () => {
    vi.stubGlobal("fetch", hostWith(host));
    const library = renderLibrary();
    const head = await within(library).findByRole("button", { name: /^Project docs 2\/2 · 1 template$/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(within(library).queryByRole("button", { name: "Open AGENTS.md" })).toBeNull();
    fireEvent.click(head);

    const agents = within(library).getByRole("button", { name: "Open AGENTS.md" });
    expect(agents.textContent).toContain("template");
    expect(agents.closest("li")?.classList.contains("files-folded")).toBe(true);
    const readme = within(library).getByRole("button", { name: "Open README.md" });
    expect(readme.textContent).not.toMatch(/template|pointer/);
    expect(readme.closest("li")?.classList.contains("files-folded")).toBe(false);
    const claude = within(library).getByRole("button", { name: "Open CLAUDE.md" });
    expect(claude.textContent).toContain("pointer");
    expect(claude.closest("li")?.classList.contains("files-folded")).toBe(false);
    expect(claude.closest("li")?.classList.contains("files-doc-nested")).toBe(true);
    // Nested directly under AGENTS.md; the group leads the folders.
    const names = Array.from(library.querySelectorAll(".files-tile-open strong, .files-list li > button:first-child strong")).map((n) => n.firstChild?.textContent);
    expect(names.slice(0, 5)).toEqual(["AGENTS.md", "CLAUDE.md", "README.md", "PROJECT.md", "TODO.md"]);
    expect(names[5]).toBe("src");
  });

  it("remembers the fold per project", async () => {
    vi.stubGlobal("fetch", hostWith(host));
    const first = renderLibrary();
    fireEvent.click(await within(first).findByRole("button", { name: /^Project docs/ }));
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesDocsOpen")) ?? "[]")).toEqual(["p1"]);
    cleanup();
    const again = renderLibrary();
    const head = await within(again).findByRole("button", { name: /^Project docs/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(localStorage.getItem(storageKey("mobile.filesDocsOpen"))).toBeNull();
  });

  it("creates a doc from its ghost row's menu and opens it", async () => {
    const fetchMock = hostWith(host);
    vi.stubGlobal("fetch", fetchMock);
    const library = renderLibrary();
    fireEvent.click(await within(library).findByRole("button", { name: /^Project docs/ }));
    expect(within(library).queryByRole("button", { name: /ROADMAP/ })).toBeNull();
    fireEvent.click(within(library).getByRole("button", { name: "PROJECT.md is not in the project yet — open its menu to create it" }));
    const sheet = screen.getByRole("dialog", { name: "PROJECT.md" });
    host.created.push("PROJECT.md");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));

    const viewer = await screen.findByRole("dialog", { name: "PROJECT.md" });
    await waitFor(() => expect(viewer.querySelector("pre")?.textContent).toBe("# new\n"));
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/files/docs") && init?.method === "POST").map(([url]) => String(url)))
      .toEqual(["/api/v1/projects/p1/files/docs?name=PROJECT.md"]);
  });

  it("says so when the name is taken since, and lists again", async () => {
    host.createAnswer = () => new Response(JSON.stringify({ error: "already_exists" }), { status: 409 });
    vi.stubGlobal("fetch", hostWith(host));
    const library = renderLibrary();
    fireEvent.click(await within(library).findByRole("button", { name: /^Project docs/ }));
    fireEvent.click(within(library).getByRole("button", { name: /^TODO.md is not in the project yet/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "TODO.md" })).getByRole("button", { name: "Create" }));
    expect((await within(library).findByRole("alert")).textContent).toBe("TODO.md is already in the project.");
  });

  it("offers no ghost row where the phone may not add files, nor without a status", async () => {
    host.uploads = false;
    vi.stubGlobal("fetch", hostWith(host));
    const off = renderLibrary();
    fireEvent.click(await within(off).findByRole("button", { name: /^Project docs 2\/2/ }));
    expect(within(off).queryByRole("button", { name: /is not in the project yet/ })).toBeNull();
    expect(within(off).getByRole("button", { name: "Open AGENTS.md" }).textContent).toContain("template");
    cleanup();

    // An older desktop (or a timed-out read) sends no `docs`: the plain group, no pills.
    localStorage.clear();
    host.uploads = true;
    host.docs = undefined;
    vi.stubGlobal("fetch", hostWith(host));
    const plain = renderLibrary();
    fireEvent.click(await within(plain).findByRole("button", { name: "Project docs (3)" }));
    expect(within(plain).queryByRole("button", { name: /is not in the project yet/ })).toBeNull();
    expect(within(plain).getByRole("button", { name: "Open AGENTS.md" }).textContent).not.toContain("template");
  });
});
