import { useCallback, useRef, useState } from "react";

import { sentName, viewerFileUrl, type OutboxFile, type ViewerScope } from "./api";

/** The extension a kind the sidecar sniffs travels under. */
const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/** Whether this browser can hand files to the phone's share sheet at all. */
export function canShareFiles(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.share === "function"
    && typeof navigator.canShare === "function";
}

/**
 * The name and type a file is shared as, or `null` when the phone's share
 * sheet would refuse it (Save still works).
 *
 * Asked of a stub, not the bytes: the browser decides by name and type alone,
 * so the Share button can stand from the first frame instead of after the
 * whole file has come over the radio — waiting for that, and then asking with
 * the sidecar's `text/plain; charset=utf-8`, is why it used to never appear.
 * Chrome on Android shares only a short list of extensions: a `notes.md` it
 * refuses goes as `notes.md.txt`, which Signal or WhatsApp will take.
 */
export function shareAs(file: OutboxFile): { name: string; type: string } | null {
  if (!canShareFiles()) return null;
  const type = file.kind.split(";")[0].trim();
  const extension = EXTENSION[type];
  // Shared under the name it was sent as, not the stamped leaf it is kept by.
  const sent = sentName(file);
  const names = [sent];
  if (extension && !sent.toLowerCase().endsWith(`.${extension}`)) names.push(`${sent}.${extension}`);
  for (const name of names) {
    try {
      if (navigator.canShare({ files: [new File([], name, { type })] })) return { name, type };
    } catch { /* A browser that throws here refuses it. */ }
  }
  return null;
}

/** The one file held for sharing: which it is, its bytes, and whether they are here. */
type Held = { key: string; file: Promise<File>; loaded: boolean };

/**
 * Sharing an outbox file through the phone's share sheet.
 *
 * `navigator.share` wants the tap that asked for it to be recent, and the
 * bytes have to come over the radio first. When they took too long the
 * browser refuses the share; the file is then held, and the button asks for a
 * second tap (`ready`), which shares at once. One file is held at a time.
 */
export function useOutboxShare(scope: ViewerScope) {
  const held = useRef<Held | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  /** The shareable bytes, fetched once and held until another file is. */
  const load = useCallback((file: OutboxFile, as: { name: string; type: string }) => {
    const key = `${file.ref ?? file.name}@${file.modified}`;
    if (held.current?.key !== key) {
      const entry: Held = {
        key,
        loaded: false,
        file: fetch(viewerFileUrl(scope, file)).then(async (response) => {
          if (!response.ok) throw new Error("read_failed");
          const prepared = new File([await response.blob()], as.name, { type: as.type });
          entry.loaded = true;
          return prepared;
        }),
      };
      held.current = entry;
      // A failed read is not kept, so the next tap tries again.
      entry.file.catch(() => { if (held.current === entry) held.current = null; });
    }
    return held.current;
  }, [scope]);

  /** Fetches ahead of a tap, where the file is already on screen. */
  const prepare = useCallback((file: OutboxFile) => {
    const as = shareAs(file);
    if (as) load(file, as).file.catch(() => { /* The tap will try again. */ });
  }, [load]);

  const share = useCallback(async (file: OutboxFile) => {
    const as = shareAs(file);
    if (!as) return;
    setFailed(null);
    setReady(null);
    const entry = load(file, as);
    // Bytes already here mean the tap is still fresh when the share is asked.
    const waited = !entry.loaded;
    let prepared: File;
    setBusy(file.name);
    try {
      prepared = await entry.file;
    } catch {
      setFailed(file.name);
      return;
    } finally {
      setBusy(null);
    }
    try {
      await navigator.share({ files: [prepared] });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      // Closing the sheet is not a failure; the bytes stay for another try.
      if (name === "AbortError") return;
      // Refused after waiting for the bytes: the tap went stale, and a second
      // one shares what is now held. Refused without waiting is a real no.
      if (name === "NotAllowedError" && waited) setReady(file.name);
      else setFailed(file.name);
    }
  }, [load]);

  return { share, prepare, busy, ready, failed };
}
