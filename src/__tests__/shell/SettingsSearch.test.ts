import { afterEach, describe, expect, it, vi } from "vitest";
import { FLASH_CLASS, revealSetting, scoreSearch, searchTerms } from "../../components/layout/settingsSearch";

describe("settings search ranking", () => {
  it("needs every term, weighs the label over synonyms, and keeps short terms to word starts", () => {
    const terms = searchTerms("Claude-API");
    expect(terms).toEqual(["claude", "api"]);
    const label = { text: "Anthropic API key", weight: 4 };
    const aliases = { text: "Claude, token", weight: 2 };
    expect(scoreSearch(terms, [label, aliases])).toBe(6);
    expect(scoreSearch(terms, [label])).toBeNull();
    expect(scoreSearch(["api"], [{ text: "Capital", weight: 4 }])).toBeNull();
    expect(scoreSearch(["board"], [{ text: "Keyboard", weight: 4 }])).toBe(2);
    expect(scoreSearch(["ubersicht"], [{ text: "Übersicht", weight: 1 }])).toBe(1);
  });
});

describe("revealSetting", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  /** A closed fold whose body mounts on the next tick, like a React fold. */
  function fold(title: string, body: string) {
    const group = document.createElement("div");
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `<span>›</span><span class="title">${title}</span>`;
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-expanded", "true");
      setTimeout(() => group.insertAdjacentHTML("beforeend", body));
    });
    group.append(toggle);
    return group;
  }

  it("opens the fold, waits for the row, highlights it and focuses its one field", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="agents-row"><span class="agents-row-name">Anthropic</span></div>`;
    root.append(fold("Accounts & keys", `<div class="agents-row"><span class="agents-row-name">Anthropic</span> <span>not saved</span><input type="password"></div>`));
    document.body.append(root);
    revealSetting(root, ["Accounts & keys", "Anthropic"]);
    await vi.waitFor(() => expect(root.querySelector(`.${FLASH_CLASS}`)).toBeTruthy());
    const flashed = root.querySelector(`.${FLASH_CLASS}`) as HTMLElement;
    // The row inside the fold, not the one of the same name above it.
    expect(flashed.querySelector("input")).toBeTruthy();
    expect(document.activeElement).toBe(flashed.querySelector("input"));
  });

  it("gives up quietly when the setting never renders", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    revealSetting(root, ["Nowhere"]);
    vi.advanceTimersByTime(5000);
    root.innerHTML = `<div class="settings-card"><span>Nowhere</span></div>`;
    expect(root.querySelector(`.${FLASH_CLASS}`)).toBeNull();
  });
});
