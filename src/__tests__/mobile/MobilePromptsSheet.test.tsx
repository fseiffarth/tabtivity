/**
 * `PromptsSheet` on its own (the trip in from the Project screen is
 * MobileProjectPrompts). Pinned here: only *available agent* tabs are targets
 * and with none the send/schedule row says so, the text is the only thing that
 * crosses, an edit PUTs against the prompt's id, Send now posts the chosen
 * tab's opaque id and reports the queue, and a closed desktop disables it all.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectPrompt, TabRow } from "../../../mobile-web/src/api";
import { PromptsSheet } from "../../../mobile-web/src/screens/PromptsSheet";
import { BRAND } from "../../lib/brand";

const PATH = "/api/v1/projects/p%201/prompts";
const tabs: TabRow[] = [
  { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
  { id: "t-gone", label: "Old Claude", kind: "agent", available: false, viewer_busy: false },
  { id: "t-claude", label: "Claude", kind: "agent", available: true, viewer_busy: false },
  { id: "t-codex", label: "Codex", kind: "agent", available: true, viewer_busy: false },
];

let prompts: ProjectPrompt[] = [];
const stamp = (id: string): ProjectPrompt => ({ id, message: "", created_at: "2026-09-15T10:00:00Z", updated_at: "2026-09-15T10:00:00Z" });
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (!url.startsWith(PATH)) throw new Error(`unexpected ${method} ${url}`);
  const rest = url.slice(PATH.length);
  if (method === "POST" && rest === "") {
    prompts = [...prompts, { ...stamp(`q${prompts.length + 1}`), message: JSON.parse(String(init?.body)).message }];
  } else if (method === "PUT") {
    const id = rest.slice(1);
    prompts = prompts.map((p) => (p.id === id ? { ...p, message: JSON.parse(String(init?.body)).message } : p));
  } else if (method === "DELETE") {
    const id = rest.slice(1);
    prompts = prompts.filter((p) => p.id !== id);
  } else if (method === "POST" && rest.endsWith("/send")) {
    const id = rest.slice(1, -"/send".length);
    prompts = prompts.filter((p) => p.id !== id);
  }
  return new Response(JSON.stringify({ prompts }), { status: 200 });
});

const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);

beforeEach(() => {
  prompts = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("Mobile prompts sheet", () => {
  it("offers only available agent tabs as targets", async () => {
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={() => {}} />);
    await screen.findByText("No prompts collected yet.");
    const options = Array.from((screen.getByLabelText("Target tab") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(["Claude", "Codex"]);
  });

  it("collects a prompt by text alone and refuses an empty one without a request", async () => {
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={() => {}} />);
    await screen.findByText("No prompts collected yet.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter a prompt.");
    expect(calls("POST")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Write the changelog" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    expect(String(calls("POST")[0][0])).toBe(PATH);
    expect(JSON.parse(String(calls("POST")[0][1]?.body))).toEqual({ message: "Write the changelog" });
    expect(await screen.findByText("Write the changelog")).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
  });

  it("sends now to the picked tab's opaque id and reports the queue", async () => {
    prompts = [{ ...stamp("q1"), message: "Run the tests" }];
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={() => {}} />);
    await screen.findByText("Run the tests");
    fireEvent.change(screen.getByLabelText("Target tab"), { target: { value: "t-codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now: Run the tests" }));
    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    expect(String(calls("POST")[0][0])).toBe(`${PATH}/q1/send`);
    expect(JSON.parse(String(calls("POST")[0][1]?.body))).toEqual({ tab_id: "t-codex" });
    expect((await screen.findByRole("status")).textContent).toContain("Queued for Codex");
    expect(screen.queryByText("Run the tests")).toBeNull();
  });

  it("hands Schedule… the target tab and the text, sending nothing itself", async () => {
    prompts = [{ ...stamp("q1"), message: "Rotate the logs" }];
    const onSchedule = vi.fn();
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={onSchedule} />);
    await screen.findByText("Rotate the logs");
    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));
    expect(onSchedule).toHaveBeenCalledWith(tabs[2], "Rotate the logs");
    expect(calls("POST")).toHaveLength(0);
  });

  it("edits against the prompt's id, and deletes by it", async () => {
    prompts = [{ ...stamp("q1"), message: "Before" }, { ...stamp("q2"), message: "Other" }];
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={() => {}} />);
    await screen.findByText("Before");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByText("Edit prompt")).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Before");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "After" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("PUT")).toHaveLength(1));
    expect(String(calls("PUT")[0][0])).toBe(`${PATH}/q1`);
    expect(await screen.findByText("After")).toBeTruthy();
    expect(screen.getByText("Add prompt")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
    expect(String(calls("DELETE")[0][0])).toBe(`${PATH}/q2`);
    await waitFor(() => expect(screen.queryByText("Other")).toBeNull());
  });

  it("with no agent tab open, says so and disables sending but still collects", async () => {
    prompts = [{ ...stamp("q1"), message: "Waiting" }];
    render(<PromptsSheet projectId="p 1" tabs={[tabs[0], tabs[1]]} onClose={() => {}} onSchedule={() => {}} />);
    await screen.findByText("Waiting");
    expect(screen.queryByLabelText("Target tab")).toBeNull();
    expect(screen.getByText("Open an agent tab to send or schedule a collected prompt.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send now: Waiting" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Schedule…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the sheet live when the host answered off its files with no window (H3), and says so", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ prompts: [], desktop_available: false }), { status: 200 }));
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={() => {}} />);
    expect((await screen.findByRole("status")).textContent).toContain(`The ${BRAND.display} window is closed`);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Target tab") as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables everything when the desktop is closed, and says why", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    render(<PromptsSheet projectId="p 1" tabs={tabs} onClose={() => {}} onSchedule={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe(`Open desktop ${BRAND.display} to manage collected prompts.`);
    expect((screen.getByLabelText("Target tab") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
