/**
 * The app root's boundary: a render error must land on a screen with a way
 * out, and that way out must not lead straight back into the crash. Both
 * buttons remount the app, and the app resumes at the saved place — the very
 * screen that threw — so the boundary forgets the place first.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../../mobile-web/src/ErrorBoundary";
import { readLastPlace, rememberLastPlace } from "../../../mobile-web/src/lastPlace";
import { BRAND } from "../../lib/brand";

function Crash(): never {
  throw new Error("boom");
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe(`${BRAND.display} Mobile error boundary`, () => {
  it("draws a way out instead of a blank screen", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary><Crash /></ErrorBoundary>);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("forgets the saved place so a retry cannot resume into the crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rememberLastPlace({ section: "projects", projectId: "p1", tabId: "t1" });
    render(<ErrorBoundary><Crash /></ErrorBoundary>);
    expect(readLastPlace()).toBeNull();
  });

  it("renders its children while nothing throws", () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });
});
