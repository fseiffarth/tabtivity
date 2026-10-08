/**
 * The spreadsheet and SQLite viewers hand the backend their owning project
 * (threat recheck gap 39: `read_spreadsheet`, `sqlite_tables` and `sqlite_page`
 * confine the path to that project's roots), and show a backend parser-limit
 * code (gaps 24 and 37) as translated text rather than the raw code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import { FileScopeContext } from "../../components/embed/fileAccess";
import { viewerErrorText, viewerLimitKey } from "../../lib/viewers/limitError";

const inProject = ({ children }: { children: ReactNode }) => (
  <FileScopeContext.Provider value="proj-1">{children}</FileScopeContext.Provider>
);

function callsOf(cmd: string) {
  return mockInvoke.mock.calls.filter(([c]) => c === cmd);
}

beforeEach(() => {
  cleanup();
  mockInvoke.mockReset();
});

describe("viewer scope", () => {
  it("the spreadsheet viewer passes its project id", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "read_spreadsheet"
          ? { sheet_names: ["S"], active_sheet: "S", rows: [["v"]] }
          : null,
      ),
    );
    const { TableView } = await import("../../components/embed/TableView");
    render(<TableView path="/p/book.xlsx" onOpenExternally={() => {}} />, { wrapper: inProject });
    await waitFor(() => expect(callsOf("read_spreadsheet")).toHaveLength(1));
    expect(callsOf("read_spreadsheet")[0][1]).toMatchObject({
      path: "/p/book.xlsx",
      projectId: "proj-1",
    });
  });

  it("the SQLite viewer passes its project id to both commands", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "sqlite_tables"
          ? ["people"]
          : cmd === "sqlite_page"
            ? { columns: ["id"], rows: [["1"]], total: 1 }
            : null,
      ),
    );
    const { SqliteView } = await import("../../components/embed/SqliteView");
    render(<SqliteView path="/p/data.db" onOpenExternally={() => {}} />, { wrapper: inProject });
    await waitFor(() => expect(callsOf("sqlite_page")).toHaveLength(1));
    expect(callsOf("sqlite_tables")[0][1]).toEqual({ path: "/p/data.db", projectId: "proj-1" });
    expect(callsOf("sqlite_page")[0][1]).toMatchObject({
      path: "/p/data.db",
      table: "people",
      projectId: "proj-1",
    });
  });
});

describe("parser-limit errors", () => {
  it("a crashed spreadsheet read shows the translated message", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_spreadsheet"
        ? Promise.reject("viewer-limit:sheet-crashed")
        : Promise.resolve(null),
    );
    const { TableView } = await import("../../components/embed/TableView");
    render(<TableView path="/p/bomb.xls" onOpenExternally={() => {}} />, { wrapper: inProject });
    expect(await screen.findByText(/the reader stopped/i)).toBeTruthy();
    expect(screen.queryByText("viewer-limit:sheet-crashed")).toBeNull();
  });

  it("a timed-out SQLite view shows the translated message", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "sqlite_tables"
        ? Promise.resolve(["forever"])
        : cmd === "sqlite_page"
          ? Promise.reject("viewer-limit:sqlite-timeout")
          : Promise.resolve(null),
    );
    const { SqliteView } = await import("../../components/embed/SqliteView");
    render(<SqliteView path="/p/loop.db" onOpenExternally={() => {}} />, { wrapper: inProject });
    expect(await screen.findByText(/took too long and was stopped/i)).toBeTruthy();
  });

  it("maps only the known codes; other errors pass through", () => {
    const t = (key: string) => `T:${key}`;
    expect(viewerLimitKey("viewer-limit:sheet-too-large")).toBe("viewerLimit.sheetTooLarge");
    expect(viewerLimitKey("viewer-limit:sqlite-too-large")).toBe("viewerLimit.sqliteTooLarge");
    expect(viewerLimitKey("viewer-limit:toString")).toBeNull();
    expect(viewerLimitKey("constructor")).toBeNull();
    expect(viewerErrorText(t, "viewer-limit:sheet-unsupported")).toBe(
      "T:viewerLimit.sheetUnsupported",
    );
    expect(viewerErrorText(t, "path '/x' is not in the current project")).toBe(
      "path '/x' is not in the current project",
    );
  });
});
