import { invoke } from "@tauri-apps/api/core";
import { currentPlatform, shellQuote } from "./pythonRun";
import type { TranslationKey } from "../i18n";

/**
 * Files dropped from the OS file manager onto a terminal tab
 * (`TerminalView`). The backend (`pty_drop_files`) answers per tab: an agent
 * tab gets each file copied into its folder's inbox — the drop box the phone's
 * files land in, the one place a fenced or containerized agent can read — and
 * types `@<reference>`, as the phone's composer does; a local shell gets the
 * path itself, quoted, as a native terminal would type it. A remote tab is
 * refused: the program there cannot see this disk.
 *
 * With the Reader open, the text goes into its composer instead of the
 * terminal (`onReaderInsert`), so a drop lands where the user is typing.
 */

interface PtyDropped {
  items: string[];
  error: string | null;
}

/** What a drop says when it could not deliver every file. */
const DROP_ERRORS: Record<string, TranslationKey> = {
  remote_tab: "terminal.drop.remote",
  file_too_large: "terminal.drop.tooLarge",
  inbox_full: "terminal.drop.inboxFull",
  not_a_file: "terminal.drop.notAFile",
};

export function dropErrorKey(code: string): TranslationKey {
  return DROP_ERRORS[code] ?? "terminal.drop.failed";
}

/** The text a drop types: each item followed by a space, so the next word or
 *  file does not run into it. */
export function dropText(items: readonly string[], agent: boolean): string {
  const platform = currentPlatform();
  return items.map((item) => (agent ? `@${item} ` : `${shellQuote(item, platform)} `)).join("");
}

/** Hand the dropped paths to the backend; `text` is what to type (empty when
 *  nothing made it), `error` the translation key of why a file did not. */
export async function deliverDrop(
  ptyId: string,
  paths: readonly string[],
  agent: boolean,
): Promise<{ text: string; error: TranslationKey | null }> {
  try {
    const dropped = await invoke<PtyDropped>("pty_drop_files", { id: ptyId, paths, agent });
    return {
      text: dropText(dropped.items, agent),
      error: dropped.error ? dropErrorKey(dropped.error) : null,
    };
  } catch (err) {
    return { text: "", error: dropErrorKey(String(err)) };
  }
}

type ReaderInsert = (text: string) => void;
const readerInserts = new Map<string, ReaderInsert>();

/** The Reader's composer for `ptyId` takes dropped text through this while it
 *  is mounted. Returns the unsubscribe. */
export function onReaderInsert(ptyId: string, insert: ReaderInsert): () => void {
  readerInserts.set(ptyId, insert);
  return () => {
    if (readerInserts.get(ptyId) === insert) readerInserts.delete(ptyId);
  };
}

/** Put `text` into the Reader's composer of `ptyId`; false when none is
 *  mounted (the caller types it into the terminal instead). */
export function insertIntoReader(ptyId: string, text: string): boolean {
  const insert = readerInserts.get(ptyId);
  if (!insert) return false;
  insert(text);
  return true;
}
