import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HintBubble } from "../../components/common/HintBubble";

afterEach(cleanup);

describe("desktop hint bubble", () => {
  it("Skip closes it for now without reading it or turning hints off", () => {
    const onDismiss = vi.fn();
    const onRead = vi.fn();
    const onDisableAll = vi.fn();
    render(
      <HintBubble
        rect={null}
        placement="top"
        title="Title"
        body="Body"
        onDismiss={onDismiss}
        onRead={onRead}
        onDisableAll={onDisableAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRead).not.toHaveBeenCalled();
    expect(onDisableAll).not.toHaveBeenCalled();
  });
});
