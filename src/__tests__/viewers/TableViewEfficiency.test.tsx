import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ content: "name,value\nalpha,1\nbeta,2\nalpha,1" }));
vi.mock("../../components/embed/fileViewer/editableFile", () => ({
  useEditableFile: () => ({
    content: state.content, draft: state.content, loaded: true, error: null,
    setDraft: vi.fn(), save: vi.fn(), undo: vi.fn(), redo: vi.fn(),
  }),
  ExternalChangeBanner: () => null,
}));
import { TableView } from "../../components/embed/TableView";

beforeEach(() => {
  vi.useFakeTimers();
  state.content = "name,value\nalpha,1\nbeta,2\nalpha,1";
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const table = () => <TableView path="/p/data.csv" onOpenExternally={() => {}} />;

describe("table update efficiency", () => {
  it("applies only settled input, with labels and clearing following the applied query", async () => {
    render(table());
    const input = screen.getByPlaceholderText("Filter rows…");
    fireEvent.change(input, { target: { value: "al" } });
    await advance(100);
    fireEvent.change(input, { target: { value: "missing" } });
    expect((input as HTMLInputElement).value).toBe("missing");
    await advance(149);
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText(/of 3 rows/)).toBeNull();
    await advance(1);
    expect(screen.getByText("0 of 3 rows")).toBeTruthy();
    expect(screen.getByText("No rows match “missing”.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    await advance(149);
    expect(screen.getByText("No rows match “missing”.")).toBeTruthy();
    await advance(1);
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText(/of 3 rows/)).toBeNull();
  });

  it("seeds without flashes, matches duplicate multisets on reorder, and expires pending flashes", async () => {
    const { container, rerender, unmount } = render(table());
    const flashed = () => [...container.querySelectorAll(".csv-row-flash")].map((row) => row.getAttribute("data-row"));
    expect(flashed()).toEqual([]);
    state.content = "name,value\nbeta,2\nalpha,1\nalpha,1";
    rerender(table());
    expect(flashed()).toEqual([]);
    state.content += "\nalpha,1";
    rerender(table());
    expect(container.querySelectorAll(".csv-row-flash")).toHaveLength(1);
    await advance(1_000);
    state.content += "\ngamma,3";
    rerender(table());
    expect(container.querySelectorAll(".csv-row-flash")).toHaveLength(2);
    await advance(2_000);
    expect(container.querySelectorAll(".csv-row-flash")).toHaveLength(1);
    await advance(1_000);
    expect(flashed()).toEqual([]);
    state.content += "\ndelta,4";
    rerender(table());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
