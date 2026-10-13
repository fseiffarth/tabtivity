/**
 * `AsyncConfirmDialog` — the project pill's danger-zone confirms (archive,
 * forget, detach, unpublish, delete history), one dialog on `DialogShell`:
 * Escape and × close it, a running confirm shows its busy label and cannot be
 * dismissed, a failure keeps it open with the reason, and while it is up the
 * app's global shortcuts stay off (`useKeyboard` checks `hasActiveModal`).
 */
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { AsyncConfirmDialog } from "../../components/common/PromptDialogs";
import { hasActiveModal } from "../../hooks/useModalFocus";
import { useKeyboard } from "../../hooks/useKeyboard";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";

function confirmDialog(props: Partial<Parameters<typeof AsyncConfirmDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn(() => Promise.resolve());
  render(
    <AsyncConfirmDialog
      title="Delete project"
      confirmLabel="Delete"
      busyLabel="Deleting…"
      danger
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    >
      <p className="settings-help">It goes to the archive.</p>
    </AsyncConfirmDialog>,
  );
  return { onClose, onConfirm };
}

describe("AsyncConfirmDialog", () => {
  beforeEach(() => {
    cleanup();
  });

  it("is a named dialog on the project-dialog surface; Escape and × close it", () => {
    const { onClose } = confirmDialog();
    const dialog = screen.getByRole("dialog", { name: "Delete project" });
    expect(dialog.classList.contains("project-dialog")).toBe(true);
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm.classList.contains("danger")).toBe(true);
    expect(document.activeElement).toBe(confirm);
    expect(hasActiveModal()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows the busy label, refuses dismissal while running, and keeps the reason on failure", async () => {
    let reject: (reason: Error) => void = () => {};
    let resolve: () => void = () => {};
    const onConfirm = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }))
      .mockImplementationOnce(() => new Promise<void>((yes) => { resolve = yes; }));
    const { onClose } = confirmDialog({ onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const busy = screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => reject(new Error("disk full")));
    expect(screen.getByText(/disk full/)).toBeTruthy();
    const again = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(again);
    await act(async () => resolve());
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays unarmed until its gate opens, and a body field's Enter confirms", () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    function Typed() {
      const [typed, setTyped] = useState("");
      return (
        <AsyncConfirmDialog
          title="Delete history"
          confirmLabel="Delete"
          busyLabel="Removing…"
          danger
          armed={typed === "demo"}
          autoFocusConfirm={false}
          onConfirm={onConfirm}
          onClose={() => {}}
        >
          {(confirm) => (
            <input
              aria-label="Name"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
            />
          )}
        </AsyncConfirmDialog>
      );
    }
    render(<Typed />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(input);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "demo" } });
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("AsyncConfirmDialog and the app's shortcuts", () => {
  function Harness({ dialog }: { dialog: boolean }) {
    useKeyboard({ onTogglePanels: () => {} });
    return dialog ? (
      <AsyncConfirmDialog
        title="Detach"
        confirmLabel="Detach"
        busyLabel="Detaching…"
        onConfirm={() => Promise.resolve()}
        onClose={() => {}}
      >
        <p>Keeps the host's files.</p>
      </AsyncConfirmDialog>
    ) : null;
  }

  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
      fullscreenGroupId: null,
    });
    useSettingsStore.setState({ settings: null });
    const store = useTabsStore.getState();
    store.addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
    useTabsStore.getState().focusGroup(allGroups(useTabsStore.getState().layout)[0].id);
  });

  const activeKey = () => allGroups(useTabsStore.getState().layout)[0].activeKey;
  const stepRight = () =>
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });

  it("holds a global chord while open and lets it through once closed", () => {
    const before = activeKey();
    const { rerender } = render(<Harness dialog />);
    stepRight();
    expect(activeKey()).toBe(before);

    rerender(<Harness dialog={false} />);
    expect(hasActiveModal()).toBe(false);
    stepRight();
    expect(activeKey()).not.toBe(before);
  });
});
