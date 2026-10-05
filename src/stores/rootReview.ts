import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { importIcsText } from "./calendar/importIcs";
import { useMailStore } from "./mail";
import { mailAgentDraftsFile, mailDraftDiscard } from "../lib/mail";
import type { MailDraft } from "../types/mail";

export interface ReviewRow {
  kind: string;
  op: string;
  pre: Record<string, unknown> | null;
  post: Record<string, unknown>;
  local: boolean;
}
export interface RootProposal {
  id: string;
  tab: string;
  tool: string;
  args: Record<string, unknown>;
  created: string;
  rows: ReviewRow[];
  calendars: Record<string, unknown>[];
  tainted: boolean;
  status: string;
  undo: boolean;
  digest: string;
  closed: boolean;
  mcp_caller?: "agent" | "local_model" | "reader";
  mcp_access?: { calendars: { all: boolean; ids: string[] }; projects: { all: boolean; ids: string[] } };
}
/** An `.ics` file a root agent staged with `calendar_import_ics`
 *  (`services::root_mcp_import`). Not a proposal: nothing is parsed or written
 *  until the user imports it here, through the calendar's own importer. */
export interface StagedIcsImport {
  id: string;
  tab: string;
  name: string;
  created: string;
  text: string;
}
interface RootReviewState {
  proposals: RootProposal[];
  imports: StagedIcsImport[];
  count: number;
  error: string | null;
  busy: boolean;
  /** Ids of staged files this window already imported. A file whose import
   *  succeeded but whose staged copy could not be removed stays on the list
   *  until the next refresh drops it, and its ✓ must not import it twice. */
  imported: string[];
  /** Whether the console's ✓ Approvals button has its panel dropped. It lives
   *  here rather than in `RootOverlay` so a flow that floats the console can
   *  open it *at* the rows; the console clears it when it closes. */
  panel: boolean;
  setPanel: (panel: boolean) => void;
  refresh: () => Promise<void>;
  decide: (proposal: RootProposal, action: "apply" | "reject" | "undo") => Promise<void>;
  applyAll: (proposals: RootProposal[]) => Promise<void>;
  /** Import exactly the text the card showed, then drop the staged copy.
   *  `fallbackName` names the new calendar when the agent gave none. */
  importStaged: (staged: StagedIcsImport, fallbackName: string) => Promise<void>;
  discardStaged: (staged: StagedIcsImport) => Promise<void>;
  /** Approve agent mail drafts, as shown: they go into the "Drafted by
   *  agents" folder, still unsent — the composer's Send is the user's. */
  fileDrafts: (drafts: MailDraft[]) => Promise<void>;
  discardDraft: (draft: MailDraft) => Promise<void>;
}
let refreshVersion = 0;
/** A draft verb: the mail store's list is the one to read again, not ours. */
async function draftAction(run: () => Promise<unknown>) {
  if (useRootReviewStore.getState().busy) return;
  useRootReviewStore.setState({ busy: true, error: null });
  try {
    await run();
  } catch (error) {
    useRootReviewStore.setState({ error: String(error) });
  } finally {
    await useMailStore.getState().loadAgentDrafts();
    useRootReviewStore.setState({ busy: false });
  }
}
async function action(command: string, args: Record<string, unknown>) {
  if (useRootReviewStore.getState().busy) return;
  useRootReviewStore.setState({ busy: true, error: null });
  try {
    await invoke(command, args);
    await useRootReviewStore.getState().refresh();
  } catch (error) {
    await useRootReviewStore.getState().refresh();
    useRootReviewStore.setState({ error: String(error) });
  } finally {
    useRootReviewStore.setState({ busy: false });
  }
}
export const useRootReviewStore = create<RootReviewState>((set) => ({
  proposals: [], imports: [], count: 0, error: null, busy: false, imported: [], panel: false,
  setPanel: (panel) => set({ panel }),
  refresh: async () => {
    const version = ++refreshVersion;
    try {
      const [proposals, imports] = await Promise.all([
        invoke<RootProposal[]>("root_mcp_review_list"),
        // Its own failure must not take the proposals down with it: a window
        // hot-reloaded over a backend built before this command has no such list.
        invoke<StagedIcsImport[]>("root_mcp_import_list").catch(() => []),
      ]);
      if (version !== refreshVersion) return;
      set({ proposals, imports: Array.isArray(imports) ? imports : [], count: proposals.filter((p) => p.status === "pending").length, error: null });
    } catch (error) {
      if (version === refreshVersion) set({ error: String(error) });
    }
  },
  decide: (p, verb) => action(`root_mcp_review_${verb}`, { id: p.id, digest: p.digest }),
  applyAll: (proposals) => action("root_mcp_review_apply_all", {
    approvals: proposals.map(({ id, digest }) => ({ id, digest })),
  }),
  importStaged: async (staged, fallbackName) => {
    const state = useRootReviewStore.getState();
    if (state.busy || state.imported.includes(staged.id)) return;
    useRootReviewStore.setState({ busy: true, error: null });
    try {
      // The import goes first: a failed one keeps the card (and its error) so
      // the user can try again, and `importIcsText` removes the calendar it
      // began when a row fails, so nothing half-imported is left behind. The
      // staged copy goes only once the import is in — and this window's list
      // of imported ids is what stops a second ✓ on a card whose removal
      // failed from importing the same file into a second calendar.
      await importIcsText(staged.text, staged.name || fallbackName);
      useRootReviewStore.setState((s) => ({ imported: [...s.imported, staged.id] }));
      await invoke("root_mcp_import_remove", { id: staged.id });
      await useRootReviewStore.getState().refresh();
    } catch (error) {
      await useRootReviewStore.getState().refresh();
      useRootReviewStore.setState({ error: String(error) });
    } finally {
      useRootReviewStore.setState({ busy: false });
    }
  },
  discardStaged: (staged) => action("root_mcp_import_remove", { id: staged.id }),
  fileDrafts: (drafts) => draftAction(() => mailAgentDraftsFile(drafts)),
  discardDraft: (draft) => draftAction(() => mailDraftDiscard(draft.id)),
}));
