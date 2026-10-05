/**
 * The YAML viewer (#yaml), driven through the real UI: a `.yaml` file opens in the
 * structure tree, and every tree action writes back into the SAME draft the Source
 * tab edits and Ctrl+S saves.
 *
 * The load-bearing property these tests pin is that the tree edits the file's text
 * rather than a model of it: an edit made in the tree leaves the file's comments,
 * quoting and untouched lines byte-identical, and lands in the editor as an
 * ordinary (dirty, undoable, saveable) change. A tree that re-serialized a parsed
 * model would pass none of this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
const { settingsState } = vi.hoisted(() => ({
  // Autosave off, so a save is an explicit click the test can point at.
  settingsState: { settings: { autosave: false, viewer_prefs: {} } as Record<string, unknown> },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(settingsState), {
    getState: () => settingsState,
  }),
}));
vi.mock("../../stores/projects", () => {
  const state = {
    projects: [{ id: "proj", directory: "/p", local_file: "/p/project.json" }],
    activeId: "proj",
  };
  const useProjectsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useProjectsStore };
});
vi.mock("../../stores/tabs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const state = {
    tabs: [] as Record<string, unknown>[],
    layout: null,
    addTabToScope: vi.fn(),
    addTab: vi.fn(),
    setActive: vi.fn(),
    removeTab: vi.fn(),
    setViewerState: vi.fn(),
    splitWithNewTab: vi.fn(() => null),
  };
  const useTabsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { ...actual, useTabsStore, findGroupOfTab: () => null, getDetachedViewerState: () => undefined };
});

// `tags` is a scalar-only list → the tree shows it as ONE editable comma line.
// `mounts` is not (an item carries a comment a comma line couldn't keep) → it
// stays per-item rows, which is what the item-row tests below drive.
const CONFIG = `# Server configuration
server:
  host: 0.0.0.0   # bind address
  port: 8080
  tags:
    - web
    - prod
  mounts:
    - /data  # scratch
    - /home
debug: false
`;

let onDisk = CONFIG;

function setup() {
  onDisk = CONFIG;
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "read_file_text") return Promise.resolve(onDisk);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "write_file_text") {
      onDisk = args.content as string;
      return Promise.resolve(null);
    }
    // check_syntax: the file is valid, so no validation banner.
    return Promise.resolve(null);
  });
}

/** YAML opens in the Tree view by default; clicking Tree is a harmless no-op that
 *  also guards these tests against a future default change. */
async function toTree() {
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Tree" }));
  });
}

async function renderYaml() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="yaml" path="/p/config.yaml" projectId="proj" />);
  });
  await toTree();
  await screen.findByRole("button", { name: "Collapse server" });
}

/** The row element an entry's key/index button sits in. */
function rowOf(el: HTMLElement): HTMLElement {
  const row = el.closest(".yaml-row") as HTMLElement | null;
  expect(row).not.toBeNull();
  return row!;
}

/** Save, and return the text that reached the disk. */
async function saveAndRead(): Promise<string> {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Save"));
  });
  await waitFor(() =>
    expect(mockInvoke).toHaveBeenCalledWith("write_file_text", expect.anything()),
  );
  return onDisk;
}

describe("yaml tree viewer (#yaml)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("opens a .yaml file in the tree, not in the editor", async () => {
    await renderYaml();
    // Structure, not source: keys are rows, values are inputs.
    expect(screen.getByRole("button", { name: "Collapse server" })).toBeTruthy();
    expect((screen.getByLabelText("Value of port") as HTMLInputElement).value).toBe("8080");
    expect((screen.getByLabelText("Value of host") as HTMLInputElement).value).toBe("0.0.0.0");
    // The scalar-only list is one comma line; the commented one renders its
    // items, indexed.
    expect((screen.getByLabelText("Value of tags") as HTMLInputElement).value).toBe("web, prod");
    expect((screen.getByLabelText("Value of item 0") as HTMLInputElement).value).toBe("/data");
  });

  it("edits a value and saves it, leaving the comments and the rest of the file alone", async () => {
    await renderYaml();
    const port = screen.getByLabelText("Value of port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    expect(await saveAndRead()).toBe(CONFIG.replace("port: 8080", "port: 9090"));
  });

  it("adds a key with the type the user picked", async () => {
    await renderYaml();
    // "+ key" on the `server` mapping (the other one is the document's own, at
    // the foot of the tree).
    await act(async () => {
      fireEvent.click(screen.getAllByTitle("Add a key under this entry")[0]);
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New key"), { target: { value: "workers" } });
      fireEvent.change(screen.getByLabelText("Value type"), { target: { value: "number" } });
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "4" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    const saved = await saveAndRead();
    expect(saved).toContain("    - /home\n  workers: 4\ndebug: false");
    expect(saved).toContain("# Server configuration");
  });

  it("adds a list item", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add an item to this list"));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "/srv" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(await saveAndRead()).toContain("    - /home\n    - /srv\n");
  });

  it("adds a copy of the last list item when Copy last is chosen", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add an item to this list"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy last" }));
    });
    // The last mount (`/home`) is duplicated verbatim, at the list's own indent.
    expect(await saveAndRead()).toContain("    - /data  # scratch\n    - /home\n    - /home\n");
  });

  it("shows a scalar-only list as one editable comma line, not as item rows", async () => {
    await renderYaml();
    const tags = screen.getByLabelText("Value of tags") as HTMLInputElement;
    expect(tags.value).toBe("web, prod");
    // The line IS the list: no count on its row, no per-item rows of its own
    // (the only item rows on screen are `mounts`', which stays rows).
    expect(tags.closest(".yaml-row")!.querySelector(".yaml-count")).toBeNull();
    expect(screen.queryByLabelText("Value of item 2")).toBeNull();

    // Editing the line edits the list — items land as ordinary block lines.
    await act(async () => {
      fireEvent.change(tags, { target: { value: "web, staging, prod" } });
      fireEvent.keyDown(tags, { key: "Enter" });
    });
    expect(await saveAndRead()).toContain("  tags:\n    - web\n    - staging\n    - prod\n");
  });

  it("edits a flow list on its comma line, keeping its style and its quoting", async () => {
    onDisk = 'tags: ["web", prod]  # labels\n';
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/flowlist.yaml" projectId="proj" />);
    });
    await toTree();

    const tags = (await screen.findByLabelText("Value of tags")) as HTMLInputElement;
    expect(tags.value).toBe("web, prod");
    await act(async () => {
      fireEvent.change(tags, { target: { value: "prod, web, extra" } });
      fireEvent.keyDown(tags, { key: "Enter" });
    });

    // Stays flow; `web` keeps the quotes it was written with, the new value is
    // written as typed, and the comment behind the bracket survives.
    expect(await saveAndRead()).toBe('tags: [prod, "web", extra]  # labels\n');
  });

  it("gives an open list a persistent add row at its end, not just a hover action", async () => {
    await renderYaml();
    const addItem = screen.getByTitle("Add an item to this list");
    // It lives in the always-visible add row at the end of the list's children,
    // not in the header row's hover-only actions.
    expect(addItem.closest(".yaml-row-add")).not.toBeNull();
    expect(addItem.closest(".yaml-actions")).toBeNull();
  });

  it("renames a key without touching its value or its comment", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^host/ }));
    });
    const input = screen.getByLabelText("Rename key host") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "bind" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(await saveAndRead()).toContain("  bind: 0.0.0.0   # bind address");
  });

  it("shows a key's comment on the key, and writes an edited one back", async () => {
    await renderYaml();
    // Hovering the key is what surfaces it — on the key itself, both ways round: the
    // comment behind `host`, and the one written above `server`.
    expect(screen.getByRole("button", { name: /^host/ }).title).toBe("# bind address");
    expect(screen.getByRole("button", { name: /^server/ }).title).toBe("# Server configuration");
    // `port` has none, so it keeps the rename hint.
    expect(screen.getByRole("button", { name: /^port/ }).title).toBe("Click to rename this key");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Comment on port"));
    });
    const input = screen.getByLabelText("Comment on port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "the port to listen on" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const saved = await saveAndRead();
    expect(saved).toContain("  port: 8080  # the port to listen on\n");
    // Written behind the value, so nothing else on the file moved.
    expect(saved).toContain("  host: 0.0.0.0   # bind address\n");
  });

  it("adds a mapping item when a list is given a key", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add an item that is a mapping (- key: value)"));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New key"), { target: { value: "name" } });
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "eu" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(await saveAndRead()).toContain("    - /home\n    - name: eu\ndebug: false");
  });

  it("reorders siblings by dragging one onto another", async () => {
    await renderYaml();
    // Drag `item 0` (/data) down onto `item 1` (/home). The rows report no geometry
    // in jsdom, so the drop lands on the last row whose top the pointer has passed —
    // which with every rect at 0 is the last sibling, i.e. exactly this move.
    const grip = screen.getByLabelText("Reorder item 0");
    await act(async () => {
      fireEvent.pointerDown(grip, { pointerId: 1 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 200 });
      fireEvent.pointerUp(grip, { pointerId: 1 });
    });

    // The item's comment travels with it.
    expect(await saveAndRead()).toContain("  mounts:\n    - /home\n    - /data  # scratch\n");
  });

  it("deletes an entry with everything under it, comment included", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Delete server"));
    });

    // "# Server configuration" is `server`'s comment — left behind, it would end up
    // sitting above `debug` and describing that instead.
    expect(await saveAndRead()).toBe("debug: false\n");
  });

  it("reorders list items", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Move item 1 up"));
    });

    expect(await saveAndRead()).toContain("  mounts:\n    - /home\n    - /data  # scratch\n");
  });

  it("shows the same text in Source, and a tree edit is an ordinary undo step", async () => {
    await renderYaml();
    const port = screen.getByLabelText("Value of port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    // Source shows the tree's edit — one draft, two views.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
    });
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(textarea.value).toContain("port: 9090");

    // And the edit undoes like a typed one.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Undo"));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("port: 8080");
  });

  it("renders a JSON-formatted .yml as a tree, not as one opaque `{` row", async () => {
    // The regression this whole flow layer exists for: a flow collection spread
    // over lines used to parse as a single un-editable scalar whose text was the
    // opening brace.
    onDisk = "# app\nservice: {\n  name: api,\n  port: 8080\n}\n";
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/flow.yaml" projectId="proj" />);
    });
    await toTree();

    const port = (await screen.findByLabelText("Value of port")) as HTMLInputElement;
    expect(port.value).toBe("8080");
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });

    // The edit lands inside the flow collection; the layout and comment survive.
    expect(await saveAndRead()).toBe("# app\nservice: {\n  name: api,\n  port: 9090\n}\n");
  });

  it("edits a .json file in the same tree, writing the strict dialect", async () => {
    onDisk = '{\n  "name": "app",\n  "keywords": []\n}\n';
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/package.json" projectId="proj" />);
    });
    await toTree();

    // A list item added to a JSON file comes out quoted — JSON has no plain scalars.
    await act(async () => {
      fireEvent.click(await screen.findByTitle("Add an item to this list"));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New value"), { target: { value: "cli" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });

    expect(await saveAndRead()).toBe('{\n  "name": "app",\n  "keywords": ["cli"]\n}\n');
  });

  it("marks a container's whole substructure while its row is hovered", async () => {
    await renderYaml();
    const serverRow = rowOf(screen.getByRole("button", { name: /^server/ }));
    await act(async () => {
      fireEvent.mouseOver(serverRow);
    });
    // Every descendant row is marked, to full depth (mounts' items are two down)…
    expect(rowOf(screen.getByLabelText("Value of port")).className).toContain("yaml-row-marked");
    expect(rowOf(screen.getByLabelText("Value of item 0")).className).toContain(
      "yaml-row-marked",
    );
    // …and a sibling outside the block is not.
    expect(rowOf(screen.getByRole("button", { name: /^debug/ })).className).not.toContain(
      "yaml-row-marked",
    );

    await act(async () => {
      fireEvent.mouseOut(serverRow);
    });
    expect(rowOf(screen.getByLabelText("Value of port")).className).not.toContain(
      "yaml-row-marked",
    );
  });

  it("tints the substructure in danger while a container's delete is hovered", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.mouseOver(screen.getByLabelText("Delete server"));
    });
    // Everything tinted is what the × will take.
    expect(rowOf(screen.getByLabelText("Value of port")).className).toContain(
      "yaml-row-marked-del",
    );
    expect(rowOf(screen.getByLabelText("Value of item 0")).className).toContain(
      "yaml-row-marked-del",
    );
  });

  it("tints the substructure with the accent while a container's copy is hovered", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.mouseOver(screen.getByLabelText("Copy server"));
    });
    // Everything tinted is what the ⧉ will capture — the whole entry, not one row.
    expect(rowOf(screen.getByLabelText("Value of port")).className).toContain(
      "yaml-row-marked-act",
    );
    expect(rowOf(screen.getByLabelText("Value of item 0")).className).toContain(
      "yaml-row-marked-act",
    );
  });

  it("colors the comma line's entries as their own rows would", async () => {
    onDisk = 'mix: ["8080", 9090, true, web]\n';
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/mix.yaml" projectId="proj" />);
    });
    await toTree();

    const input = (await screen.findByLabelText("Value of mix")) as HTMLInputElement;
    const mirror = input.closest(".yaml-list-field")!.querySelector(".yaml-list-mirror")!;
    const tone = (cls: string) =>
      Array.from(mirror.querySelectorAll(`.yaml-val-${cls}`)).map((s) => s.textContent?.trim());
    // The quoted "8080" is toned by its NODE — a string, exactly as its row
    // would show it — while the bare 9090 is a number.
    expect(tone("string")).toEqual(["8080", "web"]);
    expect(tone("number")).toEqual(["9090"]);
    expect(tone("boolean")).toEqual(["true"]);

    // Typing recolors live: a new bare number reads as one.
    await act(async () => {
      fireEvent.change(input, { target: { value: "8080, 9090, true, web, 7" } });
    });
    expect(tone("number")).toEqual(["9090", "7"]);
  });

  it("offers chevrons that glide an overflowing comma line while hovered", async () => {
    await renderYaml();
    const tags = screen.getByLabelText("Value of tags") as HTMLInputElement;
    // No overflow, no chevrons.
    expect(screen.queryByLabelText("Scroll tags right")).toBeNull();

    // jsdom reports no geometry, so give the input some: content wider than the
    // field. The scroll listener re-measures and the chevrons appear.
    Object.defineProperty(tags, "scrollWidth", { value: 400, configurable: true });
    Object.defineProperty(tags, "clientWidth", { value: 100, configurable: true });
    await act(async () => {
      fireEvent.scroll(tags);
    });

    // At the left edge only the right chevron is live.
    expect((screen.getByLabelText("Scroll tags left") as HTMLButtonElement).disabled).toBe(true);
    const right = screen.getByLabelText("Scroll tags right") as HTMLButtonElement;
    expect(right.disabled).toBe(false);

    // Hovering it glides the content; leaving stops the glide.
    await act(async () => {
      fireEvent.mouseOver(right);
      await new Promise((r) => setTimeout(r, 120));
      fireEvent.mouseOut(right);
    });
    const moved = tags.scrollLeft;
    expect(moved).toBeGreaterThan(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(tags.scrollLeft).toBe(moved);
  });

  it("keeps a construct it cannot rewrite out of reach instead of offering a bad edit", async () => {
    onDisk = "base: &base\n  a: 1\nchild:\n  <<: *base\n";
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/anchors.yaml" projectId="proj" />);
    });
    await toTree();

    // The anchored mapping and the merge key both render, but as text with no
    // input behind them.
    expect(await screen.findAllByText("source only")).toHaveLength(2);
    expect(screen.queryByLabelText("Value of <<")).toBeNull();
  });
});

describe("copy & paste cursor (#yaml)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("copies an entry to the buffer and the system clipboard, and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderYaml();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy port"));
    });

    // The buffer drives the banner; the clipboard gets the entry as text.
    expect(screen.getByText(/Copied/)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("port: 8080");
  });

  it("places the cursor on a compatible row and pastes there", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy port"));
    });

    // Click the `debug` row itself (not one of its controls): the cursor line and
    // its paste button appear right after it.
    await act(async () => {
      fireEvent.click(rowOf(screen.getByRole("button", { name: /^debug/ })));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "paste port here" }));
    });

    // Pasted as `debug`'s next sibling at its column; nothing else moved.
    expect(await saveAndRead()).toBe(CONFIG.replace("debug: false\n", "debug: false\nport: 8080\n"));
  });

  it("pastes a copied list item after another list item", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy item 0"));
    });
    await act(async () => {
      fireEvent.click(rowOf(screen.getByLabelText("Value of item 1")));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "paste item 0 here" }));
    });

    expect(await saveAndRead()).toContain(
      "    - /data  # scratch\n    - /home\n    - /data  # scratch\n",
    );
  });

  it("refuses the cursor where the entry does not fit", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy port")); // a `key: value` entry
    });

    // A list item's row can't take a mapping entry: no cursor, no paste button.
    const itemRow = rowOf(screen.getByLabelText("Value of item 0"));
    expect(itemRow.className).not.toContain("yaml-row-pastable");
    await act(async () => {
      fireEvent.click(itemRow);
    });
    expect(screen.queryByRole("button", { name: /^paste/ })).toBeNull();
  });

  it("Escape clears the cursor and then the buffer", async () => {
    await renderYaml();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Copy port"));
    });
    await act(async () => {
      fireEvent.click(rowOf(screen.getByRole("button", { name: /^debug/ })));
    });
    expect(screen.getByRole("button", { name: "paste port here" })).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByRole("button", { name: "paste port here" })).toBeNull();
    expect(screen.queryByText(/Copied/)).toBeNull();
  });
});

describe("card view (#yaml-grid)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  async function renderCards() {
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/config.yaml" projectId="proj" />);
    });
    // YAML opens in Tree now — switch to Cards first. The grid is a drill
    // navigation, not a recursive nest: the overview shows only the root
    // "document" card. Open it to reach `server`'s own level, which renders
    // `server`'s scalar fields (host, port) inline.
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Cards" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Open document" }));
    });
    await screen.findByLabelText("Value of port");
  }

  it("opens a structured .yaml file in the tree view by default", async () => {
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/config.yaml" projectId="proj" />);
    });
    // Tree is the default: tree rows render, no cards, and the Cards toggle is
    // present (the file nests something to card) but not active.
    await screen.findByRole("button", { name: "Collapse server" });
    expect((screen.getByRole("button", { name: "Tree" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Cards" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".yaml-row")).not.toBeNull();
    expect(document.querySelector(".yaml-card")).toBeNull();
  });

  it("asks again whether there is anything to card once Source typing settles", async () => {
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/config.yaml" projectId="proj" />);
    });
    await screen.findByRole("button", { name: "Collapse server" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
    });
    // Entering Source keeps the toggle's answer for the live text — no flicker.
    expect(screen.getByRole("button", { name: "Cards" })).toBeTruthy();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    // Typing away every nesting level: the whole-file parse is not re-run per
    // keystroke, so the toggle stays for now ...
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "debug: false\n" } });
    });
    expect(screen.getByRole("button", { name: "Cards" })).toBeTruthy();
    // ... and goes once the typing has settled.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cards" })).toBeNull());
  });

  it("switches to the card view, drilling into records", async () => {
    await renderCards();
    // The Cards toggle is now active, and cards (not tree rows) render.
    expect((screen.getByRole("button", { name: "Cards" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".yaml-card")).not.toBeNull();
    expect(document.querySelector(".yaml-row")).toBeNull();
    // A nested collection is a subcard, a scalar is an editable field.
    expect(screen.getByRole("button", { name: "Open server" })).toBeTruthy();
    expect((screen.getByLabelText("Value of port") as HTMLInputElement).value).toBe("8080");
  });

  it("edits a card field back into the file, comments intact", async () => {
    await renderCards();
    const port = screen.getByLabelText("Value of port") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(port, { target: { value: "9090" } });
      fireEvent.keyDown(port, { key: "Enter" });
    });
    const saved = await saveAndRead();
    expect(saved).toContain("port: 9090");
    expect(saved).toContain("# Server configuration");
  });

  it("reorders sibling cards by dragging one onto another", async () => {
    await renderCards();
    // `server` holds subcards `tags` then `mounts` — drill into `server` to reach
    // them as its own level. Drag `mounts` onto `tags`: with every rect at 0 in
    // jsdom the pointer lands on the first sibling, so mounts moves up before tags.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open server" }));
    });
    const grip = await screen.findByLabelText("Reorder mounts");
    await act(async () => {
      fireEvent.pointerDown(grip, { pointerId: 1 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerUp(grip, { pointerId: 1 });
    });
    // mounts (with its item comment) now precedes tags; nothing else moved.
    expect(await saveAndRead()).toContain(
      "  port: 8080\n  mounts:\n    - /data  # scratch\n    - /home\n  tags:\n    - web\n    - prod\n",
    );
  });

  it("names a list item card by its name-ish field, not #0", async () => {
    // Root is a map (one key, `services`), so reaching the two service items
    // means drilling document → services.
    onDisk = "services:\n  - name: web\n    port: 8080\n  - name: db\n    port: 5432\n";
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="yaml" path="/p/svc.yaml" projectId="proj" />);
    });
    // YAML opens in Tree — switch to Cards first.
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Cards" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Open document" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Open services" }));
    });
    // Cards titled by their `name` field, not `Item N`/`#0`. Neither item has a
    // nested collection, so its title is static text, not a drill button.
    expect(await screen.findByText("web")).toBeTruthy();
    expect(screen.getByText("db")).toBeTruthy();
    expect(screen.queryByText("Item 1")).toBeNull();
    expect(screen.queryByText("#0")).toBeNull();
  });
});
