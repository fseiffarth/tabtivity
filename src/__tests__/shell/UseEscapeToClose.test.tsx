/** Escape closes a surface wherever focus is, and leaves a claimed press alone. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEscapeToClose } from "../../lib/useEscapeToClose";

function Surface({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEscapeToClose(open, onClose);
  return <input data-testid="elsewhere" />;
}

afterEach(cleanup);

describe("useEscapeToClose", () => {
  it("closes from anywhere while open", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Surface open onClose={onClose} />);
    fireEvent.keyDown(getByTestId("elsewhere"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing while shut", () => {
    const onClose = vi.fn();
    render(<Surface open={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves a press another handler already claimed", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Surface open onClose={onClose} />);
    const field = getByTestId("elsewhere");
    field.addEventListener("keydown", (e) => e.preventDefault());
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
