/**
 * Gap 35 follow-up: a pull that leaves files over the 64 MiB cap on the host
 * says so in its result line, by count and by name, instead of reading as a
 * complete pull. Nothing renders when nothing was skipped.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SyncSkippedLarge } from "../../components/files/SyncSkippedLarge";

const MIB = 1024 * 1024;

describe("SyncSkippedLarge", () => {
  it("names the count and every skipped file with its size", () => {
    render(
      <span>
        Synced data from the host.
        <SyncSkippedLarge
          files={[
            { rel: "data/big.bin", size: 70 * MIB },
            { rel: "data/run/ckpt.pt", size: 2 * 1024 * MIB },
          ]}
        />
      </span>,
    );
    expect(screen.getByText(/2 file\(s\) over 64 MiB were not pulled/)).toBeTruthy();
    const list = document.querySelector(".error-note-raw")!;
    expect(list.textContent).toContain("data/big.bin (70.0 MB)");
    expect(list.textContent).toContain("data/run/ckpt.pt (2.0 GB)");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when nothing was skipped", () => {
    const { container } = render(<SyncSkippedLarge files={[]} />);
    expect(container.textContent).toBe("");
  });

  it("folds a long list behind a toggle", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ rel: `out/f${i}.h5`, size: 100 * MIB }));
    render(<SyncSkippedLarge files={files} />);
    expect(screen.getByText(/5 file\(s\) over 64 MiB were not pulled/)).toBeTruthy();
    expect(document.querySelector(".error-note-raw")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show files" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(document.querySelector(".error-note-raw")!.textContent).toContain("out/f4.h5 (100.0 MB)");
    expect(screen.getByRole("button", { name: "Hide files" })).toBeTruthy();
  });
});
