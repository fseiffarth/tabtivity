/**
 * Perf plan §6: `TabPane` code-splits every pane kind but the terminal, the
 * Files tabs and the file viewer. A split pane must show a filling placeholder
 * (`.pane-loading`) while its chunk loads, then render the real pane with the
 * props the switch handed it; the eager kinds must render synchronously, with
 * no loading frame.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../components/terminal/TerminalView", () => ({
  TerminalView: ({ id }: { id: string }) => <div data-testid={`term-${id}`} />,
}));

// Held until the test releases it, so the loading frame can be observed.
let releaseCalendar: () => void = () => {};
const calendarGate = new Promise<void>((resolve) => {
  releaseCalendar = resolve;
});
vi.mock("../../components/calendar/CalendarPane", async () => {
  await calendarGate;
  return {
    CalendarPane: ({ visible }: { visible: boolean }) => (
      <div data-testid="calendar-pane" data-visible={String(visible)} />
    ),
  };
});
vi.mock("../../components/printing/PrintManagerPane", () => ({
  PrintManagerPane: ({ visible }: { visible: boolean }) => (
    <div data-testid="print-pane" data-visible={String(visible)} />
  ),
}));

import { TabPane } from "../../components/tabs/TabPane";
import type { TabEntry } from "../../stores/tabs";

const tab = (key: string, kind: TabEntry["kind"]): TabEntry => ({
  key,
  scope: "root",
  label: key,
  cmd: "",
  cwd: "/",
  kind,
});

describe("TabPane code-split panes (§6)", () => {
  it("shows the filling placeholder until the chunk loads, then the pane", async () => {
    const { container } = render(
      <TabPane tab={tab("c", "calendar")} scope="root" visible focused filesProjectDir="/" terminalCwd="/" />,
    );
    const placeholder = container.querySelector(".pane-loading");
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("calendar-pane")).toBeNull();

    releaseCalendar();
    const pane = await screen.findByTestId("calendar-pane");
    expect(pane.getAttribute("data-visible")).toBe("true");
    expect(container.querySelector(".pane-loading")).toBeNull();
  });

  it("passes the switch's props through to the loaded pane", async () => {
    render(
      <TabPane tab={tab("p", "printing")} scope="root" visible={false} focused={false} filesProjectDir="/" terminalCwd="/" />,
    );
    expect((await screen.findByTestId("print-pane")).getAttribute("data-visible")).toBe("false");
  });

  it("keeps the terminal eager: no loading frame", () => {
    const { container } = render(
      <TabPane tab={tab("t", "shell")} scope="root" visible focused filesProjectDir="/" terminalCwd="/" />,
    );
    expect(screen.getByTestId("term-root:t")).not.toBeNull();
    expect(container.querySelector(".pane-loading")).toBeNull();
  });
});
