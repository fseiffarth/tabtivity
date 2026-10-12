/**
 * The BibTeX card view, driven through the real UI: a `.bib` file opens as one
 * card per entry, and every card action writes back into the SAME draft the
 * Source half edits and Ctrl+S saves.
 *
 * The property these tests pin is the one the whole viewer is built on — the cards
 * edit the file's *text*, not a model of it: an edit made in a card leaves the
 * `%` comment, the `@string` macro, the hand-aligned `=` columns and every other
 * entry byte-identical, and lands as an ordinary (dirty, undoable, saveable)
 * change. A card view that re-serialized parsed records would pass none of this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
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

const LIBRARY = `% my library, hand-sorted
@string{jml = {J. Machine Learning}}

@article{smith2020,
  author  = {Smith, Jane and Doe, John},
  title   = {On {LaTeX} Autocomplete},
  journal = jml,
  year    = 2020,
}

@book{knuth1984,
  author = "Knuth, Donald",
  title  = "The TeXbook",
  year   = {1984},
}
`;

let onDisk = LIBRARY;

function setup() {
  onDisk = LIBRARY;
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "read_file_text") return Promise.resolve(onDisk);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    if (cmd === "write_file_text") {
      onDisk = args.content as string;
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

/** Render the pane and wait for the cards to be on screen. `settleKey` is a
 *  citation key the file contains — the cards are the default view, so the first
 *  key field appearing is what says the file has loaded and parsed. */
async function renderBib(settleKey = "smith2020") {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="bib" path="/p/refs.bib" projectId="proj" />);
  });
  await screen.findAllByDisplayValue(settleKey);
}

/** Type into a field and commit it the way a user does — by leaving it. */
async function commit(el: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
    fireEvent.blur(el);
  });
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

warmFileViewer();

describe("bib card viewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("opens a .bib in the CARDS view, one card per record", async () => {
    await renderBib();
    // Cards, not source: the key and every field value is its own control, and the
    // brace protection that stops BibTeX lowercasing "LaTeX" is kept verbatim.
    expect((screen.getAllByLabelText("Value of title")[0] as HTMLTextAreaElement).value).toBe(
      "On {LaTeX} Autocomplete",
    );
    expect(screen.getByDisplayValue("knuth1984")).toBeTruthy();
    // The @string record is present too — the view hides no part of the file.
    expect(screen.getByText("@string")).toBeTruthy();
    expect(screen.getByText("3 entries")).toBeTruthy();
    // …and the `%` comment it cannot show is admitted rather than dropped.
    expect(screen.getByText(/1 line outside any entry/)).toBeTruthy();
  });

  it("edits a value and saves it, leaving every other byte of the file alone", async () => {
    await renderBib();
    const title = screen.getAllByLabelText("Value of title")[0];
    await commit(title, "On BibTeX Cards");
    expect(await saveAndRead()).toBe(LIBRARY.replace("On {LaTeX} Autocomplete", "On BibTeX Cards"));
  });

  it("makes a card edit an ordinary undo step", async () => {
    await renderBib();
    await commit(screen.getAllByLabelText("Value of title")[0], "Changed");
    expect((screen.getAllByLabelText("Value of title")[0] as HTMLTextAreaElement).value).toBe(
      "Changed",
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Undo"));
    });
    // One undo takes the whole card edit back, and the draft is clean again — which
    // is why there is nothing left to save (the Save button reports it).
    expect((screen.getAllByLabelText("Value of title")[0] as HTMLTextAreaElement).value).toBe(
      "On {LaTeX} Autocomplete",
    );
    expect((screen.getByLabelText("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a macro-valued field read-only instead of offering to rewrite it", async () => {
    await renderBib();
    // `journal = jml` names a @string macro: there is no input for it, only its
    // source form.
    expect(screen.queryByLabelText("Value of journal")).toBeNull();
    expect(screen.getByText("jml")).toBeTruthy();
  });

  it("filters the list on any field, and says how much it is showing", async () => {
    await renderBib();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter entries…"), { target: { value: "knuth" } });
    });
    expect(screen.getByText("1 of 3 entries")).toBeTruthy();
    expect(screen.queryByDisplayValue("smith2020")).toBeNull();
    expect(screen.getByDisplayValue("knuth1984")).toBeTruthy();
  });

  it("clears the filter when an entry is added, so the new card is visible", async () => {
    await renderBib();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Filter entries…"), { target: { value: "knuth" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add a new @misc entry at the end of the file"));
    });
    // A brand-new entry has no title, so it could never match the query it was
    // added under — the click would otherwise look like it did nothing.
    expect((screen.getByLabelText("Filter entries…") as HTMLInputElement).value).toBe("");
    expect(screen.getByDisplayValue("entry")).toBeTruthy();
    expect(screen.getByText("4 entries")).toBeTruthy();
  });

  it("flags a duplicate citation key", async () => {
    onDisk = "@misc{same,}\n@article{same,}\n";
    await renderBib("same");
    expect(screen.getAllByText("duplicate key")).toHaveLength(2);
  });

  it("filters by venue, resolving a @string macro to the journal it names", async () => {
    await renderBib();
    const venues = screen.getByLabelText("Venue") as HTMLSelectElement;
    // `journal = jml` names a macro; the picker offers the journal, not "jml" —
    // the macro's name appears nowhere in the printed bibliography.
    expect([...venues.options].map((o) => o.text)).toEqual([
      "All venues",
      "J. Machine Learning",
    ]);
    await act(async () => {
      fireEvent.change(venues, { target: { value: "J. Machine Learning" } });
    });
    expect(screen.getByText("1 of 3 entries")).toBeTruthy();
    expect(screen.getByDisplayValue("smith2020")).toBeTruthy();
    expect(screen.queryByDisplayValue("knuth1984")).toBeNull();
  });

  it("orders the list without touching the file's own order", async () => {
    await renderBib();
    const keys = () =>
      (screen.getAllByLabelText("Citation key") as HTMLInputElement[]).map((i) => i.value);
    expect(keys()).toEqual(["smith2020", "knuth1984"]); // file order
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Order"), { target: { value: "year" } });
    });
    expect(keys()).toEqual(["knuth1984", "smith2020"]); // 1984 before 2020
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/^Ascending/));
    });
    expect(keys()).toEqual(["smith2020", "knuth1984"]);
    // The direction is the list's, not the key's: it stays put across a change of
    // sort, so Z→A still means Z→A after switching to authors.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Order"), { target: { value: "author" } });
    });
    expect(keys()).toEqual(["smith2020", "knuth1984"]);
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/^Descending/));
    });
    expect(keys()).toEqual(["knuth1984", "smith2020"]); // Knuth before Smith
    // Reading the list in another order is not an edit: there is nothing to save.
    expect((screen.getByLabelText("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("mounts only a window of a long list, and extends it on demand", async () => {
    // 150 entries: more than one page (60), so the file opens with most of its
    // cards NOT in the DOM — which is the whole point on a real library.
    onDisk = Array.from({ length: 150 }, (_, i) => `@misc{e${i}, title = {T${i}},}\n`).join("");
    await renderBib("e0");
    const cards = () => screen.getAllByLabelText("Citation key").length;
    expect(cards()).toBe(60);
    expect(screen.queryByDisplayValue("e120")).toBeNull();
    // The extension control says how much is left rather than just "more".
    await act(async () => {
      fireEvent.click(screen.getByText("Show 90 more"));
    });
    expect(cards()).toBe(120);
    await act(async () => {
      fireEvent.click(screen.getByText("Show 30 more"));
    });
    expect(cards()).toBe(150);
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    // …and the count has always spoken for the whole file, not for the window.
    expect(screen.getByText("150 entries")).toBeTruthy();
  });

  it("brings a new entry into view past the window, and offers the way back", async () => {
    onDisk = Array.from({ length: 150 }, (_, i) => `@misc{e${i}, title = {T${i}},}\n`).join("");
    await renderBib("e0");
    await act(async () => {
      fireEvent.click(screen.getByTitle("Add a new @misc entry at the end of the file"));
    });
    // The new card is appended at the very end — the window jumps to it rather
    // than mounting the 150 cards above it.
    expect(screen.getByDisplayValue("entry")).toBeTruthy();
    expect(screen.getAllByLabelText("Citation key").length).toBeLessThan(60);
    expect(screen.getByText(/Show \d+ earlier/)).toBeTruthy();
    expect(screen.queryByDisplayValue("e0")).toBeNull();
    // Back up: one click restores everything above it.
    await act(async () => {
      fireEvent.click(screen.getByText(/Show \d+ earlier/));
    });
    expect(screen.getByDisplayValue("e0")).toBeTruthy();
    expect(screen.getByDisplayValue("entry")).toBeTruthy();
  });

  it("offers Cards ⇄ Source, and Source is the code editor over the same draft", async () => {
    await renderBib();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
    });
    // The raw text is on screen and the cards' filter box is gone.
    expect(screen.queryByLabelText("Filter entries…")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    });
    expect(screen.getByLabelText("Filter entries…")).toBeTruthy();
  });
});
