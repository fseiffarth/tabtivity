import { useCallback, useRef, useState } from "react";

import { MAX_VIEW_FILE, sentName, viewerFileUrl, type OutboxFile, type ViewerScope } from "./api";

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
 * refuses goes as `notes.md.txt`, which Signal or WhatsApp will take. Any
 * other refused file (a binary `part.stl`, a `.zip`) goes the same way, as
 * `part.stl.txt` in `text/plain` with its bytes unchanged: the messenger sends
 * it as a file, and whoever gets it drops the `.txt`.
 */
export function shareAs(file: OutboxFile): { name: string; type: string } | null {
  if (!canShareFiles()) return null;
  const type = file.kind.split(";")[0].trim();
  const extension = EXTENSION[type];
  // Shared under the name it was sent as, not the stamped leaf it is kept by.
  const sent = sentName(file);
  const tries = [{ name: sent, type }];
  if (extension && !sent.toLowerCase().endsWith(`.${extension}`)) tries.push({ name: `${sent}.${extension}`, type });
  if (!sent.toLowerCase().endsWith(".txt") && type !== "text/plain") tries.push({ name: `${sent}.txt`, type: "text/plain" });
  for (const as of tries) {
    try {
      if (navigator.canShare({ files: [new File([], as.name, { type: as.type })] })) return as;
    } catch { /* A browser that throws here refuses it. */ }
  }
  return null;
}

/**
 * What goes to the share sheet: the files, titled by their names. The title
 * is for apps whose share extension skips a share of bare files — Teams on
 * iPadOS listed Signal but not itself for one (untested whether a title is
 * what it waits for). No URL: a link to this page opens for nobody else.
 */
export function shareData(files: File[]): ShareData {
  return { files, title: files.map((file) => file.name).join(", ") };
}

/** The most bytes several files are shared with at once without asking first:
 * each is fetched whole into the phone's memory first. */
export const MAX_SHARE_MANY = 48 * 1024 * 1024;

/**
 * Whether a share of `size` bytes from `scope` goes at once (`ok`), asks first
 * (`ask`: past `limit`, it is held whole in the phone's memory, which can be
 * slow or fail), or cannot go at all (`null`): a drop box, the outbox and a
 * remote host hand over at most `MAX_VIEW_FILE` whole, so past it there are no
 * whole bytes to share. Never zipped.
 */
export function shareSize(scope: ViewerScope, size: number, limit = MAX_VIEW_FILE): "ok" | "ask" | null {
  if (size <= limit) return "ok";
  const whole = "files" in scope && scope.on !== "host";
  return whole || size <= MAX_VIEW_FILE ? "ask" : null;
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
 * A file past `MAX_VIEW_FILE` is not fetched until the user said yes to its
 * size (`asking`, answered by `confirm` or `cancel`).
 */
export function useOutboxShare(scope: ViewerScope) {
  const held = useRef<Held | null>(null);
  const [asking, setAsking] = useState<OutboxFile | null>(null);
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

  /** Fetches ahead of a tap, where the file is already on screen — never one
   * whose size is still to be asked about. */
  const prepare = useCallback((file: OutboxFile) => {
    const as = shareAs(file);
    if (as && shareSize(scope, file.size) === "ok") load(file, as).file.catch(() => { /* The tap will try again. */ });
  }, [load, scope]);

  const share = useCallback(async (file: OutboxFile, confirmed = false) => {
    const as = shareAs(file);
    const size = shareSize(scope, file.size);
    if (!as || !size) return;
    if (size === "ask" && !confirmed && held.current?.key !== `${file.ref ?? file.name}@${file.modified}`) {
      setAsking(file);
      return;
    }
    setAsking(null);
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
      await navigator.share(shareData([prepared]));
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      // Closing the sheet is not a failure; the bytes stay for another try.
      if (name === "AbortError") return;
      // Refused after waiting for the bytes: the tap went stale, and a second
      // one shares what is now held. Refused without waiting is a real no.
      if (name === "NotAllowedError" && waited) setReady(file.name);
      else setFailed(file.name);
    }
  }, [load, scope]);

  /** The size question's yes: the tap on it is the share's fresh tap. */
  const confirm = useCallback(() => { if (asking) void share(asking, true); }, [asking, share]);
  const cancel = useCallback(() => setAsking(null), []);

  return { share, prepare, busy, ready, failed, asking, confirm, cancel };
}

/** Sharing several files at once (the files library's selection): the first
 * tap fetches them all; the share sheet comes up then, or — when the phone
 * found the tap gone stale meanwhile — on the next tap, which the button
 * asks for (`ready`). Past `MAX_SHARE_MANY` together, or with one past
 * `MAX_VIEW_FILE`, the first tap asks about the size (`asking`) instead. */
export function useShareMany(scope: ViewerScope) {
  const [state, setState] = useState<{ key: string; phase: "fetching" | "ready" | "failed"; files?: File[] } | null>(null);
  const [asking, setAsking] = useState<readonly OutboxFile[] | null>(null);
  const keyOf = (files: readonly OutboxFile[]) => files.map((file) => `${file.ref ?? file.name}@${file.modified}`).join("\n");

  const share = useCallback(async (files: readonly OutboxFile[], confirmed = false) => {
    const key = keyOf(files);
    setAsking(null);
    const send = async (prepared: File[], waited: boolean) => {
      try {
        await navigator.share(shareData(prepared));
        setState(null);
      } catch (error) {
        const name = error instanceof DOMException ? error.name : "";
        if (name === "AbortError") setState(null);
        else if (name === "NotAllowedError" && waited) setState({ key, phase: "ready", files: prepared });
        else setState({ key, phase: "failed" });
      }
    };
    if (state?.key === key && state.phase === "ready" && state.files) return send(state.files, false);
    const kinds = files.map(shareAs);
    const size = sizeOfMany(scope, files);
    if (kinds.some((as) => as === null) || !size) {
      setState({ key, phase: "failed" });
      return;
    }
    if (size === "ask" && !confirmed) {
      setAsking(files);
      return;
    }
    setState({ key, phase: "fetching" });
    try {
      const prepared = await Promise.all(files.map(async (file, index) => {
        const as = kinds[index]!;
        const response = await fetch(viewerFileUrl(scope, file));
        if (!response.ok) throw new Error("read_failed");
        return new File([await response.blob()], as.name, { type: as.type });
      }));
      if (!navigator.canShare({ files: prepared })) throw new Error("refused");
      await send(prepared, true);
    } catch {
      setState({ key, phase: "failed" });
    }
  }, [scope, state]);

  /** Where sharing `files` stands: fetching, held for a second tap, failed. */
  const phaseOf = (files: readonly OutboxFile[]) => state?.key === keyOf(files) ? state.phase : null;
  /** The size question's yes: the tap on it is the share's fresh tap. */
  const confirm = useCallback(() => { if (asking) void share(asking, true); }, [asking, share]);
  const cancel = useCallback(() => setAsking(null), []);
  return { share, phaseOf, asking, confirm, cancel };
}

/** `shareSize` for several files: each must have whole bytes to hand over,
 * and together they ask past `MAX_SHARE_MANY`. */
export function sizeOfMany(scope: ViewerScope, files: readonly OutboxFile[]): "ok" | "ask" | null {
  const each = files.map((file) => shareSize(scope, file.size));
  if (each.some((size) => size === null)) return null;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return each.includes("ask") || total > MAX_SHARE_MANY ? "ask" : "ok";
}
