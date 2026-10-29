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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../../mobile-web/src/screens/Project";
import { NewTabSheet } from "../../../mobile-web/src/screens/NewTabSheet";
import type { AgentRow, TabRow } from "../../../mobile-web/src/api";
import { BRAND, NAMES, storageKey } from "../../lib/brand";

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
  localStorage.clear();
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

    fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
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
    fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
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
    fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
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
    fireEvent.contextMenu(open);
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
    fireEvent.contextMenu(await screen.findByRole("button", { name: "New tab" }));
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
      fireEvent.contextMenu(await screen.findByRole("button", { name: "New tab" }));
      const sheet = await screen.findByRole("dialog", { name: "New tab" });
      expect(screen.queryByRole("button", { name: "New shell" })).toBeNull();
      // The agents lead the sheet instead; the file row stays at its foot.
      expect(sheet.querySelector(".create")?.firstElementChild?.classList.contains("new-tab-agents")).toBe(true);
      expect(screen.getByRole("button", { name: "Claude" })).toBeTruthy();
      cleanup();
    }
  });
});

describe("Mobile project screen — the ＋'s tap and hold", () => {
  const AGENTS = { ...DETAIL, agents: [{ id: "claude", label: "Claude", modes: ["plan"] }, { id: "codex", label: "Codex", modes: [], default: true }] };
  const posted = () => fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  it("opens the desktop's default agent on a tap, with no sheet and no mode", async () => {
    serve(AGENTS);
    const opened = vi.fn();
    render(<Project id="p" back={() => {}} terminal={opened} />);
    await screen.findByText("claude 1");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(opened).toHaveBeenCalledWith(NEW_TAB, undefined);
    expect(screen.queryByRole("dialog", { name: "New tab" })).toBeNull();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({ kind: "agent", agent_id: "codex" });
    expect(posted()[0]?.mode).toBeUndefined();
  });

  it("opens the sheet on a hold, and the click that ends the hold creates nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve(AGENTS);
      render(<Project id="p" back={() => {}} terminal={() => {}} />);
      await screen.findByText("claude 1");
      const fab = screen.getByRole("button", { name: "New tab" });
      fireEvent.pointerDown(fab, { button: 0, clientX: 5, clientY: 5 });
      await act(() => vi.advanceTimersByTimeAsync(500));
      fireEvent.pointerUp(fab);
      fireEvent.click(fab);
      expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
      expect(posted()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stars another agent in the sheet, on this phone, for the next tap", async () => {
    serve(AGENTS);
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
    const sheet = await screen.findByRole("dialog", { name: "New tab" });
    // The desktop's default wears the star until the phone picks its own.
    expect(within(sheet).getByRole("button", { name: "Codex opens when ＋ is tapped" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Open Claude when ＋ is tapped" }));
    expect(within(sheet).getByRole("button", { name: "Claude opens when ＋ is tapped" }).getAttribute("aria-pressed")).toBe("true");
    // Starring is not a pick: the sheet stays and nothing was created.
    expect(posted()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ kind: "agent", agent_id: "claude" });
    // Kept on the phone, never sent to the desktop.
    expect(fetchMock.mock.calls.some(([url]) => /settings|default/.test(String(url)))).toBe(false);
  });

  it("falls back to the desktop's default once the starred agent is gone, and to the sheet with no agent", async () => {
    localStorage.setItem(`${storageKey("mobile.")}newTabAgent`, "gemini");
    serve(AGENTS);
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ agent_id: "codex" });
    cleanup();
    fetchMock.mockReset();
    serve({ ...DETAIL, agents: [] });
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
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

describe("Mobile ＋ sheet — API key", () => {
  const agents = [
    { id: "a1", label: "Claude", modes: [] },
    { id: "a2", label: "Gemini", modes: [] },
  ];

  it("offers an (API) start per keyed agent, in the picked worktree, and holds a spent budget", async () => {
    const keyed = [{ agent_id: "a1" }, { agent_id: "a2", budget_reached: true }];
    serve({
      worktrees: [{ id: "w0", label: "", main: true }, { id: "w1", label: "fix", branch: "fix-build", main: false }],
      cloud: [],
      sign_in: [],
      api_key: keyed,
    });
    const onPick = vi.fn();
    render(<NewTabSheet projectId="p" agents={agents} shells={false} busy={false} onPick={onPick} onSendFile={() => undefined} onClose={() => undefined} />);
    const group = await screen.findByRole("group", { name: "API key" });
    fireEvent.click(within(group).getByText("Claude (API)"));
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[0], undefined, { api_key: true });
    expect((within(group).getByText("Gemini (API) — budget reached") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("fix-build"));
    fireEvent.click(within(group).getByText("Claude (API)"));
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[0], undefined, { worktree: "w1", api_key: true });
  });

  it("shows no API group when no key is saved", async () => {
    serve({ worktrees: [], cloud: [], sign_in: [] });
    render(<NewTabSheet projectId="p" agents={agents} shells={false} busy={false} onPick={vi.fn()} onSendFile={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "API key" })).toBeNull();
  });
});

describe("Mobile ＋ sheet — a remote-only project", () => {
  const agents: AgentRow[] = [{ id: "claude", label: "Claude", modes: ["plan"] }];
  const machines = (primaryUp: boolean) => ({
    worktrees: [{ id: "w0", label: "", main: true }, { id: "w1", label: "fix", branch: "fix", main: false }],
    cloud: [{ agent_id: "claude", action: "new", task: false }],
    sign_in: [{ agent_id: "claude", signed_in: false }],
    hosts: [
      { id: "m-primary", label: "h.invalid", primary: true, connected: primaryUp },
      { id: "m-w1", label: "gpu-1", primary: false, connected: true },
    ],
    here: false,
  });
  const sheet = (onPick = vi.fn(), headless = false) => {
    render(<NewTabSheet projectId="p" agents={agents} shells busy={false} headless={headless} agentsOnly remoteOnly sendsFile={false} onPick={onPick} onSendFile={() => {}} onClose={() => {}} />);
    return onPick;
  };

  it("lists its machines alone, the primary picked, and starts the agent there", async () => {
    serve(machines(true));
    const onPick = sheet();
    const picker = await screen.findByRole("combobox", { name: /^Runs on/ }) as HTMLSelectElement;
    expect((within(picker).getAllByRole("option") as HTMLOptionElement[]).map((row) => row.textContent)).toEqual(["h.invalid (primary)", "gpu-1"]);
    expect(picker.value).toBe("m-primary");
    // Nothing that runs on this computer: no shell, worktree, cloud, sign-in,
    // file row, nor the note about the desktop's copy.
    expect(screen.queryByText("Desktop (local copy)")).toBeNull();
    expect(screen.queryByRole("button", { name: "New shell" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Agents start in" })).toBeNull();
    expect(screen.queryByText("Cloud sessions")).toBeNull();
    expect(screen.queryByText("Sign in to an agent")).toBeNull();
    expect(screen.queryByText("Send a file from this phone")).toBeNull();
    expect(screen.queryByText(/stay with the desktop's copy/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[0], undefined, { host: "m-primary" });
    fireEvent.click(screen.getByRole("button", { name: "plan" }));
    expect(onPick).toHaveBeenLastCalledWith("agent", agents[0], "plan", { host: "m-primary" });
  });

  it("starts nothing while its primary is not connected, until a connected machine is picked", async () => {
    serve(machines(false));
    const onPick = sheet();
    const picker = await screen.findByRole("combobox", { name: /^Runs on/ });
    expect(screen.getByText(/connect it in the project on the desktop/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Claude" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Desktop (local copy)")).toBeNull();
    fireEvent.change(picker, { target: { value: "m-w1" } });
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(onPick).toHaveBeenCalledWith("agent", agents[0], undefined, { host: "m-w1" });
  });

  it("starts nothing with no window, and says the window has to be open", async () => {
    serve(machines(true));
    sheet(vi.fn(), true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await screen.findByText(/starts once the desktop window is open/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Claude" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/starts on the host itself/)).toBeNull();
  });

  it("is a project screen whose ＋ opens the sheet, never a one-tap agent here", async () => {
    serve({
      ...DETAIL,
      project: { ...DETAIL.project, host: "remote", remote_only: true },
      folder: false,
      host_files: true,
      create: "agents",
    });
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.getByText(/Remote-only project: everything runs on the remote host/)).toBeTruthy();
    expect(screen.getByText(/keeps no copy of its files on the desktop; ☰ Files shows them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0);
  });
});
