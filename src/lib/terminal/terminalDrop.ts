import { invoke } from "@tauri-apps/api/core";
import { shellQuote } from "./pythonRun";
import type { TranslationKey } from "../i18n";
import { parseDroppedFiles, type DroppedFile } from "../files/droppedFiles";
import { IS_HOST_WINDOWS } from "../platform";
import { isServerClient } from "../transport/linkState";
import { blobBase64 } from "../viewers/pdfMarkup";

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
 *
 * An image pasted from the clipboard (`pasteClipboardImage`) arrives the same
 * way, written as a PNG by the backend. In the browser client the clipboard is
 * the browser's, not the server's: the page reads the picture and sends it
 * (`pty_paste_image`), and the server files it the same way.
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
  not_found: "terminal.drop.notFound",
  local_models_only: "terminal.drop.localModelsOnly",
};

export function dropErrorKey(code: string): TranslationKey {
  return DROP_ERRORS[code] ?? "terminal.drop.failed";
}

/** The text a drop types: each item followed by a space, so the next word or
 *  file does not run into it. A shell's path is quoted for the backend's OS:
 *  the shell runs there, which in the browser client is the server's. */
export function dropText(items: readonly string[], agent: boolean): string {
  const platform = IS_HOST_WINDOWS ? "windows" : "unix";
  return items.map((item) => (agent ? `@${item} ` : `${shellQuote(item, platform)} `)).join("");
}

/** Hand the dropped files to the backend — an inferred path with the size it
 *  must have (`parseDroppedFiles`); `text` is what to type (empty when nothing
 *  made it), `error` the translation key of why a file did not. */
export async function deliverDrop(
  ptyId: string,
  files: readonly DroppedFile[],
  agent: boolean,
): Promise<{ text: string; error: TranslationKey | null }> {
  try {
    const dropped = await invoke<PtyDropped>("pty_drop_files", {
      id: ptyId,
      paths: files.map((f) => f.path),
      agent,
      sizes: files.map((f) => f.size),
    });
    return {
      text: dropText(dropped.items, agent),
      error: dropped.error ? dropErrorKey(dropped.error) : null,
    };
  } catch (err) {
    return { text: "", error: dropErrorKey(String(err)) };
  }
}

/** What an image paste says when the clipboard's image could not be handed
 *  over. `no_clipboard_image` says nothing: the clipboard held no image. */
const PASTE_ERRORS: Record<string, TranslationKey> = {
  remote_tab: "terminal.paste.imageRemote",
  inbox_full: "terminal.paste.imageInboxFull",
  file_too_large: "terminal.paste.imageTooLarge",
  clipboard_denied: "terminal.paste.imageDenied",
};

/** The picture on the browser's own clipboard (the browser client), `null`
 *  when it holds none; rejects with `clipboard_denied` when the browser
 *  would not let the page read it. */
async function browserClipboardPicture(): Promise<Blob | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") throw new Error("clipboard_denied");
    return null;
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) return item.getType(type);
  }
  return null;
}

/** The server files a picture the browser read (`pty_paste_image`). */
async function pasteBrowserPicture(ptyId: string, agent: boolean, picture: Blob | null | undefined): Promise<string> {
  const found = picture === undefined ? await browserClipboardPicture() : picture;
  if (!found) throw new Error("no_clipboard_image");
  return invoke<string>("pty_paste_image", { id: ptyId, agent, image: await blobBase64(found) });
}

/** Paste the OS clipboard's image into tab `ptyId`, for a paste that found no
 *  text on the clipboard (`pty_paste_clipboard_image`): an agent gets it as a
 *  PNG in its folder's inbox, typed as `@<reference>` like a dropped file, a
 *  shell the quoted path of a copy outside the project. `text` is empty when
 *  there was no image or it could not be stored, `error` the translation key
 *  of why in the latter case.
 *
 *  `picture` is for the browser client only (the window reads the OS
 *  clipboard itself): what a paste event carried, `null` when it carried
 *  none; left out, the browser's clipboard is read. */
export async function pasteClipboardImage(
  ptyId: string,
  agent: boolean,
  picture?: Blob | null,
): Promise<{ text: string; error: TranslationKey | null }> {
  try {
    const item = isServerClient()
      ? await pasteBrowserPicture(ptyId, agent, picture)
      : await invoke<string>("pty_paste_clipboard_image", { id: ptyId, agent });
    return { text: dropText([item], agent), error: null };
  } catch (err) {
    // The backend rejects with its wire code; the browser path's own codes
    // ride an `Error`.
    const code = err instanceof Error ? err.message : String(err);
    if (code === "no_clipboard_image") return { text: "", error: null };
    return { text: "", error: PASTE_ERRORS[code] ?? "terminal.paste.imageFailed" };
  }
}

/** A paste into a box that types for agent tab `ptyId` — the Reader's
 *  composer, its answer field under a question's "Type something." row, the
 *  steering prompt. Files copied in the file manager go to the tab folder's
 *  inbox (`deliverDrop`); with no text on the clipboard, its image goes there
 *  as a PNG (`pasteClipboardImage`). Either way `done` gets the `@<reference>`
 *  text to put at the caret (empty when nothing made it), the translation key
 *  of why something did not, and whether it was a pasted image. A text paste
 *  is left alone: returns false and the box takes it as it always did. */
export function pasteIntoAgentBox(
  event: { clipboardData: DataTransfer; preventDefault: () => void },
  ptyId: string,
  done: (pasted: { text: string; error: TranslationKey | null; image: boolean }) => void,
): boolean {
  const files = parseDroppedFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    void deliverDrop(ptyId, files, true).then((pasted) => done({ ...pasted, image: false }));
    return true;
  }
  if (event.clipboardData.getData("text/plain")) return false;
  event.preventDefault();
  // The browser client files the picture the paste itself carried; the
  // window reads the OS clipboard instead and ignores it.
  const picture = Array.from(event.clipboardData.files ?? []).find((file) => file.type.startsWith("image/")) ?? null;
  void pasteClipboardImage(ptyId, true, picture).then((pasted) => done({ ...pasted, image: true }));
  return true;
}

/** `current` with `text` put in at offset `at`, a space before it unless it
 *  starts the text or follows whitespace: how a box for an agent tab takes an
 *  `@` reference, a pasted file or a dictated piece. */
export function spliceSpaced(current: string, at: number, text: string): string {
  const before = current.slice(0, at);
  return `${before}${before && !/\s$/.test(before) ? " " : ""}${text}${current.slice(at)}`;
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
