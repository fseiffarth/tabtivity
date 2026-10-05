/**
 * Opening a session from the project screen's header ＋.
 *
 * The shell and agent buttons used to stand at the foot of the screen, under
 * every tab card: on a project with a screenful of tabs, the one control the
 * screen exists for was past the end of the scroll. They are a sheet now, and
 * what has to hold is that the move changed nothing about what is created —
 * the same kinds, the same agents, the same modes, and the new tab still hands
 * itself to the terminal.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../../mobile-web/src/screens/Project";
import { NewTabSheet } from "../../../mobile-web/src/screens/NewTabSheet";
import type { TabRow } from "../../../mobile-web/src/api";
import { BRAND, NAMES } from "../../lib/brand";

const fetchMock = vi.fn();

const NEW_TAB = { id: "t-new", label: "claude 2", kind: "agent", available: true, viewer_busy: false };

function serve(detail: Record<string, unknown>) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(
    init?.method === "POST"
      ? new Response(JSON.stringify({ tab: NEW_TAB }), { status: 200 })
      : new Response(JSON.stringify(detail), { status: 200 }),
  ));
}

const DETAIL = {
  project: { id: "p", label: "Alpha", status: "active", live_sessions: 1 },
  desktop_available: true,
  tabs: [{ id: "a", label: "claude 1", kind: "agent", available: true, viewer_busy: false }],
  agents: [{ id: "claude", label: "Claude", modes: ["plan", "auto"] }],
  shells: true,
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — the ＋", () => {
  it("keeps the creating buttons out of the page until the header's ＋ asks for them", async () => {
    serve(DETAIL);
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    // Nothing at the foot any more: the only way to a new session is the header.
    expect(screen.queryByRole("button", { name: "New shell" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const sheet = await screen.findByRole("dialog", { name: "New tab" });
    expect(sheet.querySelector(".create")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New shell" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude" })).toBeTruthy();
    // The agent's modes ride beside its name, as they did at the foot.
    expect([...sheet.querySelectorAll(".mode")].map((node) => node.textContent)).toEqual(["plan", "auto"]);
  });

  it("creates what was tapped and hands the new tab to the terminal", async () => {
    serve(DETAIL);
    const opened: TabRow[] = [];
    render(<Project id="p" back={() => {}} terminal={(tab) => opened.push(tab)} />);
    await screen.findByText("claude 1");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(await screen.findByRole("button", { name: "plan" }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]?.id).toBe("t-new");
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(String(post?.[0])).toBe("/api/v1/projects/p/tabs");
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.kind).toBe("agent");
    expect(body.agent_id).toBe("claude");
    expect(body.mode).toBe("plan");
    // The sheet is gone on the tap rather than waiting for the desktop.
    expect(screen.queryByRole("dialog", { name: "New tab" })).toBeNull();
  });

  it("sends a phone file into the project's inbox and shows the reference an agent reads it by", async () => {
    serve(DETAIL);
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => String(url).includes("/inbox")
      ? Promise.resolve(new Response(JSON.stringify({ attachment: { name: "20260923-120000-notes.pdf", reference: `${NAMES.inboxDir}/20260923-120000-notes.pdf`, size: 3 } }), { status: 201 }))
      : base?.(url, init));
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(await screen.findByRole("button", { name: /Send a file from this phone/ }));
    // The picker opened on the tap; the sheet is out of the way of its answer.
    expect(screen.queryByRole("dialog", { name: "New tab" })).toBeNull();

    const input = screen.getByTestId("project-inbox-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["pdf"], "notes.pdf", { type: "application/pdf" })], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText(`In the project as @${NAMES.inboxDir}/20260923-120000-notes.pdf`)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/inbox"));
    expect(String(post?.[0])).toBe("/api/v1/projects/p/inbox?name=notes.pdf");
    expect((post?.[1] as RequestInit).method).toBe("POST");
    // A file is not a tab: nothing was created on the desktop.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/tabs"))).toBe(false);
  });

  it("opens the ＋ while the desktop is away: a shell, a plain agent and a file go, a mode waits", async () => {
    serve({ ...DETAIL, desktop_available: false });
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText(/Desktop unavailable/);
    const open = screen.getByRole("button", { name: "New tab" }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    // The host starts these itself (headless owner plan, H1b) …
    expect((screen.getByRole("button", { name: "New shell" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Claude" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Send a file from this phone/ }) as HTMLButtonElement).disabled).toBe(false);
    // … while a launch mode still needs the window: no dead button in the
    // grid, one folded group at the foot that names it.
    expect(screen.queryByRole("button", { name: "plan" })).toBeNull();
    const held = document.querySelector(".new-tab-held") as HTMLDetailsElement;
    expect(held.open).toBe(false);
    expect(held.querySelector("summary")?.textContent).toContain(`Needs the ${BRAND.display} window (2)`);
    expect(held.textContent).toContain("plan · auto");
    expect(screen.getByText(new RegExp(`No ${BRAND.display} window is open`))).toBeTruthy();
  });

  it("puts the phone file at the sheet's foot and asks for any file, not just media", async () => {
    serve(DETAIL);
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "New tab" }));
    const file = screen.getByRole("button", { name: /Send a file from this phone/ });
    // Last in the sheet, under every agent tile.
    expect(file.parentElement?.lastElementChild).toBe(file);
    // A bare input is media-only to Android Chrome: camera and photos, no files.
    expect(screen.getByTestId("project-inbox-input").getAttribute("accept")).toContain("application/*");
  });

  it("offers no shell while the desktop keeps shells off the phone", async () => {
    for (const detail of [{ ...DETAIL, shells: false }, { ...DETAIL, shells: undefined }]) {
      serve(detail);
      render(<Project id="p" back={() => {}} terminal={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "New tab" }));
      const sheet = await screen.findByRole("dialog", { name: "New tab" });
      expect(screen.queryByRole("button", { name: "New shell" })).toBeNull();
      // The agents lead the sheet instead; the file row stays at its foot.
      expect(sheet.querySelector(".create")?.firstElementChild?.classList.contains("new-tab-agents")).toBe(true);
      expect(screen.getByRole("button", { name: "Claude" })).toBeTruthy();
      cleanup();
    }
  });
});

describe("Mobile ＋ sheet — cloud sessions", () => {
  const agents = [
    { id: "a1", label: "Claude", modes: [] },
    { id: "a2", label: "Codex", modes: [] },
    { id: "a3", label: "Gemini", modes: [] },
  ];
  const cloud = [
    { agent_id: "a1", action: "new", task: true },
    { agent_id: "a1", action: "open", task: false },
    { agent_id: "a2", action: "open", task: false },
  ];

  it("keeps the agent tiles plain and folds the cloud launches into one closed group", async () => {
    serve({ worktrees: [], cloud, sign_in: [] });
    const onPick = vi.fn();
    render(<NewTabSheet projectId="p" agents={agents} shells={false} busy={false} onPick={onPick} onSendFile={() => undefined} onClose={() => undefined} />);
    const group = (await waitFor(() => {
      const found = document.querySelector(".new-tab-cloud");
      expect(found).toBeTruthy();
      return found;
    })) as HTMLDetailsElement;
    // A reader who never used a vendor's cloud meets one closed row, no ☁.
    expect(group.open).toBe(false);
    expect(group.querySelector("summary")?.textContent).toContain("Cloud sessions");
    expect(document.querySelector(".new-tab-agents")?.textContent).toBe("ClaudeCodexGemini");
    expect(document.body.textContent).not.toContain("☁");
    // Only the agents that have a cloud are listed inside, each with its own launches.
    const rows = [...group.querySelectorAll(".new-tab-cloud-agent")].map((row) => row.textContent);
    expect(rows).toEqual(["ClaudeNew sessionOpen existing", "CodexOpen existing"]);

    fireEvent.click(screen.getByRole("group", { name: "Codex" }).querySelector("button")!);
    expect(onPick).toHaveBeenCalledWith("agent", agents[1], undefined, { cloud: "open" });
    // A cloud New that takes its task first asks for it.
    fireEvent.click(screen.getByRole("group", { name: "Claude" }).querySelector("button")!);
    expect(screen.getByText("New Claude cloud session")).toBeTruthy();
  });

  it("shows no cloud group when no agent has a cloud session", async () => {
    serve({ worktrees: [], cloud: [], sign_in: [] });
    render(<NewTabSheet projectId="p" agents={agents} shells={false} busy={false} onPick={vi.fn()} onSendFile={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(document.querySelector(".new-tab-cloud")).toBeNull();
  });
});
