import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog, DialogShell, TextPromptDialog } from "../../components/common/PromptDialogs";
import { Dropdown } from "../../components/common/Dropdown";
import { hasActiveModal, useModalFocus } from "../../hooks/useModalFocus";

function Nested() {
  const [child, setChild] = useState(false);
  const [parent, setParent] = useState(true);
  return parent && <DialogShell onDismiss={() => setParent(false)}>
    <h2>Parent</h2>
    <button onClick={() => setChild(true)}>Open child</button>
    <Dropdown value="a" options={[{ value: "a", label: "Alpha" }]} onChange={() => {}} />
    {child && <ConfirmDialog title="Child" body="Confirm" danger onCancel={() => setChild(false)} onConfirm={() => {}} />}
  </DialogShell>;
}

describe("desktop modal focus", () => {
  it("names the dialog, defaults a destructive confirmation to Cancel, traps Tab and restores the opener", async () => {
    const user = userEvent.setup();
    function Example() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>{open && <ConfirmDialog title="Delete file" body="Irreversible" danger onCancel={() => setOpen(false)} onConfirm={() => {}} />}</>;
    }
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Delete file" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(hasActiveModal()).toBe(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
    expect(hasActiveModal()).toBe(false);
  });

  it("dismisses a dropdown before its parent and only the top nested dialog", async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole("button", { name: /Alpha/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy();
    const opener = screen.getByRole("button", { name: "Open child" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Child" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy();
    expect(document.activeElement).toBe(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a host that stays mounted gives focus back to what was focused when it opened", () => {
    let setOpen: (open: boolean) => void = () => {};
    function Host() {
      const [open, set] = useState(false);
      setOpen = set;
      const ref = useModalFocus(() => set(false), open);
      return (
        <>
          <button>At mount</button>
          <button>At open</button>
          {open && <div ref={ref} tabIndex={-1} role="dialog"><button>Inside</button></div>}
        </>
      );
    }
    render(<Host />);
    screen.getByRole("button", { name: "At mount" }).focus();
    const opener = screen.getByRole("button", { name: "At open" });
    opener.focus();
    act(() => setOpen(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside" }));
    expect(hasActiveModal()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(hasActiveModal()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps rename selection, refuses busy dismissal and retains the value on failure", async () => {
    let reject: (reason: Error) => void = () => {};
    const submit = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
    const cancel = vi.fn();
    render(<TextPromptDialog title="Rename" label="Name" initial="paper.tex" selectStem onSubmit={submit} onCancel={cancel} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    fireEvent.change(input, { target: { value: "new.tex" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => reject(new Error("No space")));
    expect(input.value).toBe("new.tex");
    expect(screen.getByText(/No space/)).toBeTruthy();
  });
});
