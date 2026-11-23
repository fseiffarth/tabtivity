import { create } from "zustand";

/**
 * The Reader's conversation in the side panel (`reader_side_chat`): while an
 * agent tab's Reader shows Diffs or Data, its chat — hidden there, never
 * unmounted — is drawn in the main window's side panel instead of the one
 * status line over the docked composer.
 *
 * Two sides meet here. Each qualifying Reader (switch on, its pane visible in
 * the main window, Diffs or Data open) **wants** the panel; the last to want
 * it holds it, and when it lets go the one before it gets it back (two
 * subwindows both on Diffs: the one last focused wins). The panel registers the
 * **slot** element it draws the chat into while it shows one; the holder moves
 * its chat's DOM there (`TerminalReaderView`), so there is one chat per tab and
 * nothing is mounted twice. Session state only: the switch is the setting.
 */
export interface SideChatClaim {
  ptyId: string;
  /** The tab's label, for the panel's head. */
  label: string;
  /** Back to the tab's Chat (closes Diffs or Data, which ends the claim). */
  showChat: () => void;
}

interface ReaderSideChatState {
  /** Readers that want the panel, the holder last. */
  claims: SideChatClaim[];
  /** The panel's chat element while it is mounted. */
  slot: HTMLElement | null;
  /** Add a Reader as the holder, or update its claim where it stands. */
  want: (claim: SideChatClaim) => void;
  /** Make a Reader that already wants the panel its holder. */
  raise: (ptyId: string) => void;
  drop: (ptyId: string) => void;
  setSlot: (slot: HTMLElement | null) => void;
}

export const useReaderSideChatStore = create<ReaderSideChatState>((set) => ({
  claims: [],
  slot: null,
  want: (claim) =>
    set((s) => {
      const at = s.claims.findIndex((c) => c.ptyId === claim.ptyId);
      if (at < 0) return { claims: [...s.claims, claim] };
      const cur = s.claims[at];
      if (cur.label === claim.label && cur.showChat === claim.showChat) return s;
      const claims = s.claims.slice();
      claims[at] = claim;
      return { claims };
    }),
  raise: (ptyId) =>
    set((s) => {
      const at = s.claims.findIndex((c) => c.ptyId === ptyId);
      if (at < 0 || at === s.claims.length - 1) return s;
      return { claims: [...s.claims.filter((c) => c.ptyId !== ptyId), s.claims[at]] };
    }),
  drop: (ptyId) =>
    set((s) => (s.claims.some((c) => c.ptyId === ptyId) ? { claims: s.claims.filter((c) => c.ptyId !== ptyId) } : s)),
  setSlot: (slot) => set((s) => (s.slot === slot ? s : { slot })),
}));

/** The Reader that holds the panel, if any. */
export function sideChatHolder(s: Pick<ReaderSideChatState, "claims">): SideChatClaim | null {
  return s.claims[s.claims.length - 1] ?? null;
}
