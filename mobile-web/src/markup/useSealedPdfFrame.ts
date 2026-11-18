// Phone only: this hook imports the phone's `api.ts`, so the desktop (which
// shares the rest of `mobile-web/src/markup/`) must never import it.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { MAX_INBOX_FILE } from "../api";
import { formatBytes } from "../../../src/lib/formatBytes";
import { acceptFrameMessage, MAX_FRAME_PAGES, type FrameFailure, type FromFrame, type ToFrame } from "./frameProtocol";

export type Size = [number, number];
export type Picture = { bitmap: ImageBitmap; width: number };
type FrameBoxes ={ x: number; y: number; w: number; h: number }[];
export type Failure = FrameFailure | "tooLarge" | "fetch" | "timeout" | "picture";

/** How long the frame may take to open a document once its bytes are in,
 * and to draw one page before that page is. The download has no limit of
 * its own: a slow link is fine as long as bytes keep coming, and only
 * `STALL_TIMEOUT` without one gives it up. */
const OPEN_TIMEOUT = 45_000;
export const RENDER_TIMEOUT = 20_000;
const STALL_TIMEOUT = 30_000;

/** `response`'s body as it comes in, `onChunk` told the bytes so far (and the
 * declared length, 0 when there is none) after each piece; `null` once it
 * grows past `max`. */
async function readBody(response: Response, max: number, onChunk: (got: number, total: number) => void): Promise<ArrayBuffer | null> {
  const total = Number(response.headers.get("content-length")) || 0;
  if (total > max) { void response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) {
    const data = await response.arrayBuffer();
    return data.byteLength > max ? null : data;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > max) { void reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
    onChunk(got, total);
  }
  const whole = new Uint8Array(got);
  let at = 0;
  for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength; }
  return whole.buffer;
}

export type SealedPdfFrame = ReturnType<typeof useSealedPdfFrame>;

/**
 * The phone's sealed PDF frame (`pdf-frame.html`): the byte fetch (with its
 * stall and open timeouts), the frame's messages, and what they fill — page
 * sizes, page pictures, per-page failures, the download line, the document's
 * failure, where each question's quote was found. It is called before the
 * pages' layout is worked out: `sizes` feeds the layout, the layout feeds
 * which pages are alive, and `useFrameRenderQueue` (called after) draws those.
 *
 * `reopening` is the Reload's flag, kept by the view (it is set with the new
 * file); the frame's `meta` answer clears it. A picture (not a PDF) sets
 * `sizes` / `failure` from its own load handlers.
 */
export function useSealedPdfFrame({ isPdf, url, size, generation, frame, setReopening }: {
  isPdf: boolean;
  url: string;
  /** The file's declared size, bytes. */
  size: number;
  /** Bumped by Reload: the frame is remounted and the bytes fetched again. */
  generation: number;
  frame: RefObject<HTMLIFrameElement | null>;
  setReopening: (reopening: boolean) => void;
}) {
  const [sizes, setSizes] = useState<Size[] | null>(null);
  /** The PDF's bytes so far while they come in; `null` once they are in. */
  const [download, setDownload] = useState<{ got: number; total: number } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pictures, setPictures] = useState<Record<number, Picture>>({});
  const [pageFailures, setPageFailures] = useState<Set<number>>(() => new Set());
  /** Bumped when a page came back (or failed): the render queue looks again. */
  const [renderTick, setRenderTick] = useState(0);
  /** Where each question's quote was found on its page (`findText`), by
   * `page\nquote`; absent while the frame has not answered. */
  const [found, setFound] = useState<Record<string, FrameBoxes>>({});
  const findAsked = useRef(new Map<string, number>());
  const findKeys = useRef(new Map<number, string>());
  const findId = useRef(0);
  /** Submit's own questions to the frame (`snapshot`, `text`), by id. */
  const frameCalls = useRef(new Map<number, (answer: FromFrame | null) => void>());
  const frameCallId = useRef(0);
  const bytes = useRef<ArrayBuffer | null>(null);
  const frameReady = useRef(false);
  const opened = useRef(false);
  const inFlight = useRef<number | null>(null);
  const pageCount = useRef(MAX_FRAME_PAGES);
  const awaitingMeta = useRef(true);
  const renderTimer = useRef<number | undefined>(undefined);
  const picturesRef = useRef(pictures);
  picturesRef.current = pictures;

  const post = useCallback((message: unknown, transfer: Transferable[] = []) => {
    frame.current?.contentWindow?.postMessage(message, "*", transfer);
  }, [frame]);
  /** The page in flight could not be drawn (or never answered): it is marked
   * failed so the queue moves on to the next one. */
  const renderFailed = useCallback((n = inFlight.current) => {
    window.clearTimeout(renderTimer.current);
    if (n === null) return;
    if (inFlight.current === n) inFlight.current = null;
    setPageFailures((known) => new Set(known).add(n));
    setRenderTick((tick) => tick + 1);
  }, []);
  const openIfReady = useCallback(() => {
    if (opened.current || !frameReady.current || !bytes.current) return;
    opened.current = true;
    const data = bytes.current;
    bytes.current = null;
    post({ type: "open", bytes: data }, [data]);
  }, [post]);

  /** One question to the frame for Submit; `null` when it does not answer in
   * time or the frame is remounted meanwhile. */
  const askFrame = useCallback((message: ToFrame & { id: number }): Promise<FromFrame | null> => new Promise((resolve) => {
    const timer = window.setTimeout(() => settle(null), RENDER_TIMEOUT);
    const settle = (answer: FromFrame | null) => {
      window.clearTimeout(timer);
      frameCalls.current.delete(message.id);
      resolve(answer);
    };
    frameCalls.current.set(message.id, settle);
    post(message);
  }), [post]);
  const nextCallId = useCallback(() => ++frameCallId.current, []);
  // A remounted frame answers nothing it was asked before.
  useEffect(() => () => {
    for (const settle of [...frameCalls.current.values()]) settle(null);
  }, [generation]);

  /** The frame has opened its document: Submit may ask it for pictures. */
  const ready = useCallback(() => frameReady.current && opened.current, []);

  /** Where a question's quote is looked for, once per document: the frame
   * reads the page's text and answers boxes (`findText`), never the text. */
  const askFind = useCallback((page: number, quote: string) => {
    const key = `${page}\n${quote}`;
    if (findAsked.current.has(key)) return;
    const id = ++findId.current;
    findAsked.current.set(key, id);
    findKeys.current.set(id, key);
    post({ type: "findText", id, page, quote });
  }, [post]);

  /** A Reload mounts a new frame for a new document: everything the old one
   * set goes (the view clears `reopening` with the new `meta`). */
  const restart = useCallback(() => {
    window.clearTimeout(renderTimer.current);
    frameReady.current = false;
    opened.current = false;
    inFlight.current = null;
    bytes.current = null;
    pageCount.current = MAX_FRAME_PAGES;
    awaitingMeta.current = true;
    setPictures((known) => {
      for (const picture of Object.values(known)) picture.bitmap.close?.();
      return {};
    });
    setPageFailures(new Set());
    // The new document's text is looked through afresh.
    findAsked.current.clear();
    findKeys.current.clear();
    setFound({});
    setFailure(null);
  }, []);

  useEffect(() => {
    if (!isPdf) return;
    if (size > MAX_INBOX_FILE) { setFailure("tooLarge"); return; }
    const controller = new AbortController();
    let stalled = false;
    let stallTimer: number | undefined;
    let openTimer: number | undefined;
    const arm = () => {
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(() => { stalled = true; controller.abort(); }, STALL_TIMEOUT);
    };
    arm();
    setDownload({ got: 0, total: size });
    // Redrawn only when the line's words change: a tenth of a MB, not each piece.
    let shown = "";
    void fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? readBody(response, MAX_INBOX_FILE, (got, total) => {
        arm();
        const label = formatBytes(got);
        if (label === shown) return;
        shown = label;
        setDownload({ got, total: total || size });
      }) : Promise.reject(new Error("fetch"))))
      .then((data) => {
        window.clearTimeout(stallTimer);
        setDownload(null);
        if (!data) { setFailure("tooLarge"); return; }
        bytes.current = data;
        openIfReady();
        openTimer = window.setTimeout(() => { if (awaitingMeta.current) setFailure((was) => was ?? "timeout"); }, OPEN_TIMEOUT);
      }, () => {
        window.clearTimeout(stallTimer);
        if (stalled || !controller.signal.aborted) { setDownload(null); setFailure("fetch"); }
      });
    return () => { controller.abort(); window.clearTimeout(stallTimer); window.clearTimeout(openTimer); };
    // `generation`: a Reload fetches the bytes again, for the new frame.
  }, [isPdf, url, size, openIfReady, generation]);

  useEffect(() => {
    if (!isPdf) return;
    const onMessage = (event: MessageEvent) => {
      const message = acceptFrameMessage(event, frame.current?.contentWindow, pageCount.current);
      if (!message) {
        // A page the checks refused still came from the frame: give its
        // bitmap back and let the queue move on rather than wait forever.
        const data = event.data as { type?: unknown; bitmap?: unknown } | null;
        if (frame.current && event.source === frame.current.contentWindow && data && typeof data === "object" && data.type === "page") {
          if (typeof ImageBitmap !== "undefined" && data.bitmap instanceof ImageBitmap) data.bitmap.close();
          renderFailed();
        }
        return;
      }
      if (message.type === "ready") {
        frameReady.current = true;
        openIfReady();
      } else if (message.type === "meta") {
        pageCount.current = message.pages.length;
        awaitingMeta.current = false;
        setReopening(false);
        setSizes(message.pages.map(({ w, h }) => [w, h]));
      } else if (message.type === "page") {
        window.clearTimeout(renderTimer.current);
        inFlight.current = null;
        setPictures((known) => {
          known[message.n]?.bitmap.close?.();
          return { ...known, [message.n]: { bitmap: message.bitmap, width: message.width } };
        });
        setRenderTick((tick) => tick + 1);
      } else if (message.type === "snapshot" || message.type === "text") {
        const answer = frameCalls.current.get(message.id);
        if (answer) answer(message);
        else if (message.type === "snapshot") message.bitmap?.close();
      } else if (message.type === "found") {
        const key = findKeys.current.get(message.id);
        if (key !== undefined) setFound((known) => ({ ...known, [key]: message.rects }));
      } else if (message.n !== undefined) {
        renderFailed(message.n);
      } else {
        setFailure(message.code);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isPdf, frame, openIfReady, renderFailed, setReopening]);

  useEffect(() => () => {
    // Bitmaps are GPU memory; hand them back as the view goes.
    for (const picture of Object.values(picturesRef.current)) picture.bitmap.close?.();
    window.clearTimeout(renderTimer.current);
  }, []);

  return {
    sizes, setSizes, pictures, setPictures, pageFailures, download, failure, setFailure, found, renderTick,
    inFlight, renderTimer,
    post, askFrame, nextCallId, renderFailed, askFind, ready, restart,
  };
}
