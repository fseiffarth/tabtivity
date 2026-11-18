/**
 * Cards for markups that lost theirs. A file marked up on this phone keeps a
 * card among the project's tabs (`filesPlace.ts`), but a card can go while
 * its marks stay in the layer store: one pushed out by PDFs only read, back
 * when both shared one cap, or marked before cards existed. The layer store
 * is what says a file has marks, so every stored layer of the project without
 * a card gets one again — a project file found by its folder names (a token
 * is sealed afresh with every listing), an outbox file by its leaf name in
 * the outbox. A file that is gone gets no card; its marks are left alone.
 */
import { listOutbox, lookUpFileRow, lookUpProjectFile, sentName } from "../api";
import { findFileTab, isMarkupTab, keepMarkupTab, MARKED_TABS_CAP, readFileTabs, restoreMarkupTabs, type FileTab } from "../filesPlace";
import { layerKeys, REMARKS_KEY } from "./store";

/** A layer key's file: a project file's folders and name, or an outbox leaf. */
type KeyedFile = { from: "files"; folders: string[]; name: string } | { from: "outbox"; name: string };

/** Layer keys whose file was looked up and not found, this page's life: not
 * asked about again on every visit to the project. */
const missing = new Set<string>();

/** The file `key` (`layerKey`) is the layer of, `null` for Annotate's layer
 * or a key of another shape. */
export function keyedFile(projectId: string, key: string): KeyedFile | null {
  if (key.endsWith(REMARKS_KEY)) return null;
  const rest = key.startsWith(`${projectId}:`) ? key.slice(projectId.length + 1) : null;
  if (rest?.startsWith("outbox:")) {
    const name = rest.slice("outbox:".length);
    return name ? { from: "outbox", name } : null;
  }
  if (!rest?.startsWith("files:")) return null;
  // `${place}/${name}`, `place` empty at the root.
  const parts = rest.slice("files:".length).split("/");
  const name = parts[parts.length - 1];
  const folders = parts.slice(0, -1).filter((part) => part.length > 0);
  return name ? { from: "files", folders, name } : null;
}

/** The project file at `folders`/`name` as a card, walking down by name;
 * `null` when it is not there. */
async function projectFileCard(projectId: string, folders: string[], name: string, signal: AbortSignal): Promise<FileTab | null> {
  let folder: string | undefined;
  for (const part of folders) {
    const found = await lookUpProjectFile(projectId, folder, part, undefined, signal);
    if (!found || found === "unlisted" || found.kind !== "dir") return null;
    folder = found.token;
  }
  const entry = await lookUpFileRow(projectId, folder, name);
  if (!entry) return null;
  return { token: entry.token, name, kind: entry.kind, size: entry.size, modified: entry.modified, folder, place: folders.join("/") };
}

/** Gives every markup of `projectId` without a card its card back.
 * `files`: whether project files may be read (the desktop's files switch);
 * an outbox file's card needs only the outbox. Failures leave things as they
 * are — the next visit tries again. */
export async function recoverMarkupTabs(projectId: string, files: boolean, signal: AbortSignal): Promise<void> {
  if (projectId.startsWith("tab:")) return;
  const orphans: { key: string; file: KeyedFile }[] = [];
  for (const key of await layerKeys(projectId)) {
    const file = keyedFile(projectId, key);
    if (!file || missing.has(key)) continue;
    const card = findFileTab(projectId, file.from === "outbox"
      ? { from: "outbox", place: "", name: file.name }
      : { place: file.folders.join("/"), name: file.name });
    // A card opened to read whose file has marks is a markup's card.
    if (card) {
      if (!isMarkupTab(card)) keepMarkupTab(projectId, card);
    } else if (files || file.from === "outbox") {
      orphans.push({ key, file });
    }
  }
  // Never more than the markups' cap has room for: none would stay.
  orphans.splice(Math.max(0, MARKED_TABS_CAP - readFileTabs(projectId).filter(isMarkupTab).length));
  if (!orphans.length || signal.aborted) return;
  const found: FileTab[] = [];
  try {
    const outbox = orphans.some(({ file }) => file.from === "outbox") ? await listOutbox({ project: projectId }, signal) : [];
    for (const { key, file } of orphans) {
      if (signal.aborted) return;
      let card: FileTab | null = null;
      if (file.from === "outbox") {
        const sent = outbox.find((row) => row.name === file.name);
        if (sent) {
          card = { token: sent.name, name: sent.name, kind: sent.kind, size: sent.size, modified: sent.modified, place: "", from: "outbox" };
          if (sentName(sent) !== sent.name) card.label = sentName(sent);
        }
      } else {
        card = await projectFileCard(projectId, file.folders, file.name, signal);
      }
      if (card) found.push(card);
      else missing.add(key);
    }
  } catch {
    // The desktop away, the switch turned off, the page left: what was found
    // so far is kept below, the rest asked again next time.
  }
  if (!signal.aborted) restoreMarkupTabs(projectId, found);
}
