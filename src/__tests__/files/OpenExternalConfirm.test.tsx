/**
 * Threat recheck gap 21 (decision C2): every hand-off of a file to the OS
 * default app asks first, naming the file, and a launcher or executable the
 * backend refuses (`open_refused_launcher`) is not opened, with a note. The
 * choke point is the windows store's `openFile` (every caller, Reader change
 * cards and terminal path links included, goes through it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useWindowsStore, type TrackedWindow } from "../../stores/windows";
import { useOpenExternalStore } from "../../stores/openExternal";
import { OpenExternalHost } from "../../components/common/OpenExternalHost";
import { QUEUED_CONFIRM_DELAY_MS } from "../../components/common/PromptDialogs";
import { EmbedPane } from "../../components/embed/EmbedPane";
import { adaptClientCommand } from "../../lib/transport/clientAdapters";
import { describeFileErrorKey } from "../../components/embed/fileAccess";
import { openErrorText } from "../../lib/openExternal";
import type { WsClient } from "../../lib/transport/wsClient";

const invokeMock = vi.mocked(invoke);

const WIN: TrackedWindow = {
  id: "w1",
  exec: "open-file",
  file: "/p/data.xyz",
  pid: 0,
  project_id: "p",
  role: null,
  opened_at: 1,
  window_id: null,
  origin: "side_file_tree",
};

function realOpens() {
  return invokeMock.mock.calls.filter(
    ([cmd, args]) => cmd === "open_file" && !(args as { checkOnly?: boolean }).checkOnly,
  );
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  useOpenExternalStore.setState({ pending: null, queue: [] });
  useWindowsStore.setState({ windows: [] });
});

describe("openFile asks before the OS opens a file", () => {
  it("checks, asks naming the file, and opens only after Open", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args?: unknown) =>
      (args as { checkOnly?: boolean }).checkOnly ? null : WIN,
    );
    render(<OpenExternalHost />);
    const opened = useWindowsStore.getState().openFile("/p/data.xyz", undefined, "p", "side_file_tree");
    expect(await screen.findByText("Open data.xyz with the system's default app?")).toBeTruthy();
    expect(screen.getByText("/p/data.xyz")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("open_file", expect.objectContaining({ path: "/p/data.xyz", checkOnly: true }));
    expect(realOpens()).toEqual([]);
    // Cancel is the default (focused) button.
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await opened).toEqual(WIN);
    expect(realOpens()).toHaveLength(1);
    expect(useWindowsStore.getState().windows).toEqual([WIN]);
  });

  it("opens nothing when the user cancels", async () => {
    invokeMock.mockResolvedValue(null);
    render(<OpenExternalHost />);
    const opened = useWindowsStore.getState().openFile("/p/a.bin");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await opened).toBeNull();
    expect(realOpens()).toEqual([]);
  });

  it("refuses a launcher with a note and never makes the real call", async () => {
    invokeMock.mockRejectedValue("open_refused_launcher");
    render(<OpenExternalHost />);
    const opened = useWindowsStore.getState().openFile("/p/run.desktop", undefined, "p");
    expect(await screen.findByText("run.desktop was not opened")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await opened).toBeNull();
    expect(realOpens()).toEqual([]);
  });

  it("shows the note when the file turned into a launcher after the check", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args?: unknown) => {
      if ((args as { checkOnly?: boolean }).checkOnly) return null;
      throw "open_refused_launcher";
    });
    const opened = useWindowsStore.getState().openFile("/p/notes.txt");
    await waitFor(() => expect(useOpenExternalStore.getState().pending?.request.kind).toBe("confirm"));
    act(() => useOpenExternalStore.getState().answer(true));
    await waitFor(() => expect(useOpenExternalStore.getState().pending?.request.kind).toBe("refused"));
    act(() => useOpenExternalStore.getState().answer(false));
    expect(await opened).toBeNull();
  });

  it("does not ask for an explicit handler (the user's own choice)", async () => {
    invokeMock.mockResolvedValue(WIN);
    expect(await useWindowsStore.getState().openFile("/p/x.txt", "gedit", "p")).toEqual(WIN);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_file", expect.not.objectContaining({ checkOnly: true }));
    expect(useOpenExternalStore.getState().pending).toBeNull();
  });

  it("does not open twice on a backend that predates checkOnly", async () => {
    invokeMock.mockResolvedValue(WIN);
    expect(await useWindowsStore.getState().openFile("/p/x.xyz")).toEqual(WIN);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useOpenExternalStore.getState().pending).toBeNull();
  });

  it("asks for each of several files opened at once, in turn", async () => {
    // A multi-file drop or drag-out opens every no-viewer file together; a
    // later question used to supersede (decline unseen) the earlier ones.
    invokeMock.mockImplementation(async (_cmd: string, args?: unknown) => {
      const { checkOnly, path } = args as { checkOnly?: boolean; path: string };
      return checkOnly ? null : { ...WIN, id: path, file: path };
    });
    render(<OpenExternalHost />);
    const first = useWindowsStore.getState().openFile("/p/a.xyz");
    const second = useWindowsStore.getState().openFile("/p/b.xyz");
    expect(await screen.findByText("Open a.xyz with the system's default app?")).toBeTruthy();
    const open = screen.getByRole("button", { name: "Open" });
    open.focus();
    fireEvent.click(open);
    expect(await screen.findByText("Open b.xyz with the system's default app?")).toBeTruthy();
    // The next question starts on Cancel again, not on the Open just pressed.
    expect(document.activeElement?.textContent).toBe("Cancel");
    // A queued question's Open arms only after a short delay (a double
    // click's second click must not answer it unseen).
    await act(() => new Promise((r) => setTimeout(r, QUEUED_CONFIRM_DELAY_MS + 20)));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect((await first)?.file).toBe("/p/a.xyz");
    expect((await second)?.file).toBe("/p/b.xyz");
    expect(realOpens().map(([, args]) => (args as { path: string }).path)).toEqual(["/p/a.xyz", "/p/b.xyz"]);
    expect(useOpenExternalStore.getState().pending).toBeNull();
  });

  it("other check errors surface as before", async () => {
    invokeMock.mockRejectedValue("/p/gone.xyz: No such file or directory");
    await expect(useWindowsStore.getState().openFile("/p/gone.xyz")).rejects.toBe("/p/gone.xyz: No such file or directory");
    expect(useOpenExternalStore.getState().pending).toBeNull();
  });
});

describe("a dropped file's embed tab", () => {
  it("asks and lets the backend judge instead of running the OS default it resolved", async () => {
    // `embed_capability` resolves `.js` to WScript.exe on Windows; as a
    // handler that ran the script unasked, past the launcher refusal.
    invokeMock.mockRejectedValue("open_refused_launcher");
    render(
      <>
        <EmbedPane path="/p/evil.js" exec="C:\\Windows\\System32\\WScript.exe" projectId="p" visible />
        <OpenExternalHost />
      </>,
    );
    expect(await screen.findByText("evil.js was not opened")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "open_file",
      expect.objectContaining({ path: "/p/evil.js", handler: null, checkOnly: true }),
    );
    expect(realOpens()).toEqual([]);
  });
});

describe("browser and deck plumbing", () => {
  it("a browser's checkOnly opens no download", async () => {
    const client = { call: vi.fn() } as unknown as WsClient;
    await expect(adaptClientCommand(client, "open_file", { path: "/p/x.pdf", checkOnly: true })).resolves.toBeNull();
    expect((client as unknown as { call: ReturnType<typeof vi.fn> }).call).not.toHaveBeenCalled();
  });

  it("a figure folder that is a link reads as the link refusal", () => {
    expect(
      describeFileErrorKey("'/p/talk.tex-figures/a.png' is in a folder that is a link; viewers do not save through links"),
    ).toBe("fileError.link");
    expect(describeFileErrorKey("'/p/talk.tex-figures/a.tex' or its folder is a link; the figure was not compiled")).toBe(
      "fileError.link",
    );
  });
});

describe("reveal error line", () => {
  it("names a refused macOS bundle in words, not the backend code", () => {
    const text = openErrorText("open_refused_launcher", "/p/Evil.app");
    expect(text).toContain("Evil.app was not opened");
    expect(text).not.toContain("open_refused_launcher");
    expect(openErrorText("Not a directory: /p/x", "/p/x")).toBe("Not a directory: /p/x");
  });
});
