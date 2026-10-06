import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("Not available in this test")) }));
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useSettingsStore } from "../../stores/settings";
import { SETTINGS_ANCHORS } from "../../components/layout/settingsUi";
import { DEFAULT_PDF_MARKUP_APPLY, DEFAULT_PDF_MARKUP_APPLY_INSTRUCTION, DEFAULT_PDF_MARKUP_INSTRUCTION } from "../../lib/viewers/pdfMarkup";

beforeEach(() => {
  useSettingsStore.setState({ settings: {} } as never);
});

const nav = () => screen.getByRole("navigation", { name: "Settings categories" });
const links = () => nav().querySelector(".settings-navigation-links") as HTMLElement;
const mainScroll = () => document.querySelector(".settings-panel-content .dialog-scroll") as HTMLElement;

describe("settings category navigation", () => {
  it("defaults untested tags off and lets General show and hide them", async () => {
    const originalUpdateSettings = useSettingsStore.getState().updateSettings;
    const updateSettings = vi.fn().mockImplementation(async (patch: { show_untested_tags: boolean }) => {
      useSettingsStore.setState({ settings: { show_untested_tags: patch.show_untested_tags } });
    });
    useSettingsStore.setState({ settings: {}, updateSettings } as never);
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    const toggle = screen.getByRole("checkbox", { name: /Show untested tags/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(document.documentElement.classList.contains("show-untested-tags")).toBe(false);
    await act(async () => { fireEvent.click(toggle); });
    expect(updateSettings).toHaveBeenCalledWith({ show_untested_tags: true });
    expect(document.documentElement.classList.contains("show-untested-tags")).toBe(true);
    expect(toggle.checked).toBe(true);
    await act(async () => { fireEvent.click(toggle); });
    expect(document.documentElement.classList.contains("show-untested-tags")).toBe(false);
    expect(toggle.checked).toBe(false);
    act(() => { useSettingsStore.setState({ updateSettings: originalUpdateSettings }); });
  });

  it("keeps the desktop's own PDF markup prompts, starting from the defaults", async () => {
    const originalUpdateSettings = useSettingsStore.getState().updateSettings;
    const updateSettings = vi.fn().mockImplementation(async (patch: Record<string, unknown>) => {
      useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ...patch } });
    });
    useSettingsStore.setState({ settings: {}, updateSettings } as never);
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor="settings-anchor-pdfMarkup" />); });
    const instruction = screen.getByLabelText("Mark up prompt") as HTMLTextAreaElement;
    // Apply marks directly is on unset: the instruction starts from its default.
    expect(instruction.value).toBe(DEFAULT_PDF_MARKUP_APPLY_INSTRUCTION);
    const apply = screen.getByLabelText("“Make these changes” prompt") as HTMLTextAreaElement;
    expect(apply.value).toBe(DEFAULT_PDF_MARKUP_APPLY);
    await act(async () => { fireEvent.change(apply, { target: { value: "Apply all and rebuild." } }); });
    expect(updateSettings).toHaveBeenLastCalledWith({ pdf_markup_apply: "Apply all and rebuild." });
    // Typed back to the default, or emptied: the default stands, unsaved.
    await act(async () => { fireEvent.change(instruction, { target: { value: ` ${DEFAULT_PDF_MARKUP_APPLY_INSTRUCTION}` } }); });
    expect(updateSettings).toHaveBeenLastCalledWith({ pdf_markup_instruction: undefined });
    const resets = screen.getAllByRole("button", { name: "Use the default" }) as HTMLButtonElement[];
    expect(resets[0].disabled).toBe(true);
    await act(async () => { fireEvent.click(resets[1]); });
    expect(updateSettings).toHaveBeenLastCalledWith({ pdf_markup_apply: undefined });
    act(() => { useSettingsStore.setState({ updateSettings: originalUpdateSettings }); });
  });

  it("switches Apply marks directly, on unset, and the instruction follows its mode", async () => {
    const originalUpdateSettings = useSettingsStore.getState().updateSettings;
    const updateSettings = vi.fn().mockImplementation(async (patch: Record<string, unknown>) => {
      useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ...patch } });
    });
    useSettingsStore.setState({ settings: {}, updateSettings } as never);
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor="settings-anchor-pdfMarkup" />); });
    const toggle = screen.getByRole("checkbox", { name: /Apply marks directly/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => { fireEvent.click(toggle); });
    expect(updateSettings).toHaveBeenLastCalledWith({ pdf_markup_direct: false });
    expect(toggle.checked).toBe(false);
    expect((screen.getByLabelText("Mark up prompt") as HTMLTextAreaElement).value).toBe(DEFAULT_PDF_MARKUP_INSTRUCTION);
    act(() => { useSettingsStore.setState({ updateSettings: originalUpdateSettings }); });
  });

  it("shows this mode's default over the other mode's kept from before, and a user's own instruction as written", async () => {
    // An older build kept the list default as the user's text: no instruction
    // of theirs — the field shows (and a Submit sends) the apply default.
    useSettingsStore.setState({ settings: { pdf_markup_instruction: DEFAULT_PDF_MARKUP_INSTRUCTION } } as never);
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor="settings-anchor-pdfMarkup" />); });
    expect((screen.getByLabelText("Mark up prompt") as HTMLTextAreaElement).value).toBe(DEFAULT_PDF_MARKUP_APPLY_INSTRUCTION);
    expect((screen.getAllByRole("button", { name: "Use the default" })[0] as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    useSettingsStore.setState({ settings: { pdf_markup_instruction: "Fix typos only. " } } as never);
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor="settings-anchor-pdfMarkup" />); });
    expect((screen.getByLabelText("Mark up prompt") as HTMLTextAreaElement).value).toBe("Fix typos only. ");
    expect((screen.getAllByRole("button", { name: "Use the default" })[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens one page per entry and honors the Mobile deep link", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialAnchor={SETTINGS_ANCHORS.mobile} />); });
    // The deep link lands on the Mobile page alone — not a long scroll that
    // happens to contain it.
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeTruthy();
    expect(document.getElementById("settings-anchor-general")).toBeNull();
    expect(within(nav()).getByRole("button", { name: "Mobile" }).getAttribute("aria-current")).toBe("location");

    fireEvent.click(within(nav()).getByRole("button", { name: "Calendar" }));
    expect(document.getElementById("settings-anchor-calendar")).toBeTruthy();
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeNull();
  });

  it("groups the entries by topic and keeps General to its own page", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    const agents = within(nav()).getByRole("group", { name: "Agents" });
    expect(within(agents).getByRole("button", { name: "Manage CLIs" })).toBeTruthy();
    expect(within(agents).getByRole("button", { name: "Root console and MCPs" })).toBeTruthy();
    const general = within(nav()).getByRole("group", { name: "General" });
    expect(within(general).getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("location");
    // General's page holds the theme picker and nothing from other pages.
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(document.getElementById("settings-anchor-rootConsole")).toBeNull();
    expect(document.getElementById("settings-anchor-experimental")).toBeNull();
  });

  it("restores a page's scroll after a subpanel round trip", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    mainScroll().scrollTop = 480;
    await act(async () => { fireEvent.click(within(nav()).getByRole("button", { name: "Git Hosting" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Back/ })); });
    expect(mainScroll().scrollTop).toBe(480);
  });

  it("opens an existing named subpanel and offers a compact route to the pages", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} initialPanel="git" />); });
    expect(screen.getByRole("button", { name: /Back/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings categories" }));
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: "Mobile" })); });
    expect(document.getElementById(SETTINGS_ANCHORS.mobile)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("searches the entries by the labels of the settings on their page", async () => {
    await act(async () => { render(<SettingsDialog onClose={() => {}} />); });
    const search = screen.getByRole("textbox", { name: "Search settings…" });
    fireEvent.change(search, { target: { value: "zoom" } });
    const buttons = within(links()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["LayoutWindow zoom"]);
    // Enter opens the first match.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(document.getElementById("settings-anchor-layout")).toBeTruthy();
    // Escape clears the query before it could close the dialog.
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(within(nav()).getByRole("button", { name: "Calendar" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "no such setting anywhere" } });
    expect(within(links()).queryAllByRole("button")).toEqual([]);
    expect(within(nav()).getByText("No setting matches")).toBeTruthy();
  });
});
