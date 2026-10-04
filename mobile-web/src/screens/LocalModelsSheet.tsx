import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, getLocalModels, localModelAction, wasApplied, type LocalModelAction, type LocalModelList, type LocalModelRow } from "../api";
import { keepAliveKey, modelSizeLabel, placementKey, pollDelay, sortModels, summary } from "../localModels";
import { isUntested } from "../../../src/lib/untested";
import { useT, type TranslationKey } from "../../../src/lib/i18n";

type Translate = ReturnType<typeof useT>;

/** How long a write the phone could not confirm keeps the list on the fast
 * clock: the sidecar's deadline can pass while the load it carried has
 * started on the desktop, and the list is how that shows. */
const SETTLE_MS = 30_000;

function codeOf(reason: unknown): string {
  return reason instanceof ApiError ? reason.code : "request_failed";
}

/** A write whose answer never came back: the window missed the sidecar's
 * deadline (`503`) or the phone gave up first. The action may well have
 * started, so the list is read again rather than a failure claimed. */
function unconfirmed(reason: unknown): boolean {
  return reason instanceof ApiError && (reason.status === 503 || reason.status === 0);
}

/** The sentence for a list that could not be read. */
function failureKey(code: string): TranslationKey {
  if (code === "desktop_unavailable") return "mobile.localModels.needsWindow";
  if (code === "local_models_disabled") return "mobile.localModels.disabled";
  return "mobile.localModels.failed";
}

/** The Home row's caption for a list, or the reason there is none. */
export function localModelsCaption(list: LocalModelList | null, failure: string | null, t: Translate): string {
  if (failure) return t(failureKey(failure));
  if (!list) return t("mobile.localModels.row");
  const line = summary(list);
  return line.key === "summary"
    ? t("mobile.localModels.summary", { loaded: line.loaded, installed: line.installed })
    : t(`mobile.localModels.${line.key}`);
}

function rowMeta(row: LocalModelRow): string {
  return [row.parameter_size, row.quantization, row.size ? modelSizeLabel(row.size) : null].filter(Boolean).join(" · ");
}

/** What the row says about memory: loading, a failed load, or — loaded —
 * where it sits and how long it stays. Absent readings are left out. */
function rowState(row: LocalModelRow, loading: boolean, t: Translate): ReactNode {
  if (row.remote) return t("mobile.localModels.cloud");
  if (loading) {
    return <><span className="transcript-working-dots" aria-hidden="true"><i /><i /><i /></span> {t("mobile.localModels.loading")}</>;
  }
  if (row.state === "failed") return t("mobile.localModels.loadFailed");
  if (row.state !== "loaded") return null;
  const place = placementKey(row);
  const stay = keepAliveKey(row);
  const parts = [
    place && (place.key === "partGpu" ? t("mobile.localModels.partGpu", { pct: place.pct }) : t(`mobile.localModels.${place.key}`)),
    stay && (stay.key === "pinned" ? t("mobile.localModels.pinned") : t("mobile.localModels.expires", { minutes: stay.minutes })),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The row error a refused write leaves under its model. */
function rowErrorKey(code: string): TranslationKey {
  if (code === "model_loading") return "mobile.localModels.busyLoading";
  if (code === "model_not_installed") return "mobile.localModels.goneModel";
  return "mobile.localModels.actionFailed";
}

/**
 * The desktop's installed Ollama models, from the phone: each with its size,
 * whether it is in memory (and where, and for how long), and Load / Unload.
 * Start Ollama when the desktop can start it without a password. Downloading,
 * updating and deleting are the desktop's alone — the sheet offers none, and
 * the host refuses them.
 *
 * The list is read on open, then every 2.5 s while something is loading or
 * starting (or a request of the sheet's own is unanswered) and every 10 s
 * otherwise; never while the page is hidden.
 */
export function LocalModelsSheet({ onClose, onChange }: {
  onClose: () => void;
  /** The latest list, or the code it could not be read with. */
  onChange?: (list: LocalModelList | null, failure: string | null) => void;
}) {
  const t = useT();
  const [list, setList] = useState<LocalModelList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Requests of the sheet's own still on their way, by model (`""` = Start). */
  const [pending, setPending] = useState<Record<string, LocalModelAction>>({});
  const [rowError, setRowError] = useState<{ model: string; key: TranslationKey } | null>(null);
  /** Writes gone unconfirmed, counted so each one restarts the while the
   * list is read on the fast clock; 0 when none is recent. */
  const [settling, setSettling] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  /** Bumped when a list lands, to schedule the next read from then. */
  const [stamp, setStamp] = useState(0);
  const reading = useRef<AbortController | null>(null);
  /** False once the sheet is closed: a write still on its way then reads
   * nothing more. */
  const alive = useRef(true);
  const changed = useRef(onChange);
  useEffect(() => { changed.current = onChange; });
  // Before the first read's effect, so a remount (StrictMode) reads again.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reading.current?.abort();
    };
  }, []);

  const show = useCallback((next: LocalModelList | null, code: string | null) => {
    // Home keeps its caption from a write answered after the sheet closed.
    if (!alive.current) {
      changed.current?.(next, code);
      return;
    }
    if (next) setList(next);
    setFailure(code);
    changed.current?.(next, code);
    setStamp((count) => count + 1);
  }, []);

  const load = useCallback(async () => {
    if (!alive.current) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const next = await getLocalModels(controller.signal);
      if (!controller.signal.aborted) show(next, null);
    } catch (reason) {
      if (!controller.signal.aborted) show(null, codeOf(reason));
    }
  }, [show]);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // On open, and again whenever the page comes back into view.
  useEffect(() => {
    if (visible) void load();
    else reading.current?.abort();
  }, [visible, load]);

  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(0), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);

  const inFlight = Object.keys(pending).length > 0 || settling > 0;
  const delay = pollDelay(list, inFlight);
  useEffect(() => {
    if (!visible || stamp === 0) return;
    const timer = window.setTimeout(() => void load(), delay);
    return () => window.clearTimeout(timer);
  }, [visible, stamp, delay, load]);

  const act = async (action: LocalModelAction, model = "") => {
    if (pending[model]) return;
    setPending((current) => ({ ...current, [model]: action }));
    setRowError(null);
    // A read on its way — started before or during the write — would land
    // after this answer with the list from before it.
    reading.current?.abort();
    try {
      const next = await localModelAction(action, model || undefined);
      reading.current?.abort();
      show(next, null);
    } catch (reason) {
      reading.current?.abort();
      const code = codeOf(reason);
      if (unconfirmed(reason) || wasApplied(reason)) {
        // Not a failure the reader can act on: the read says what happened
        // (and says "open the app" only if it too finds no window).
        setSettling((count) => count + 1);
        void load();
      } else if (code === "local_models_disabled") {
        show(null, code);
      } else {
        // A refused Start says so under its button, as a refused Load does
        // under its row.
        setRowError({ model, key: rowErrorKey(code) });
        // The list may have moved under the phone (stopped, uninstalled).
        void load();
      }
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[model];
        return next;
      });
    }
  };

  const blocked = failure === "desktop_unavailable" || failure === "local_models_disabled";
  const running = list?.server === "running" && !failure;
  const models = list && !blocked ? sortModels(list.models) : [];

  const status = (() => {
    if (failure) return <p className="sheet-note error" role="alert">{t(failureKey(failure))}</p>;
    if (!list) return <p className="sheet-note" role="status">{t("mobile.localModels.loadingList")}</p>;
    switch (list.server) {
      case "running":
        return list.models.length === 0 ? <p className="sheet-note">{t("mobile.localModels.empty")}</p> : null;
      case "starting":
        return <p className="sheet-note" role="status">{t("mobile.localModels.starting")}</p>;
      case "stopped":
        return <>
          <p className="sheet-note">{t("mobile.localModels.serverStopped")}</p>
          {list.start_failed && <p className="sheet-note error" role="alert">{t("mobile.localModels.startFailed")}</p>}
          {list.can_start && <button className="primary local-models-start" disabled={!!pending[""]} onClick={() => void act("start")}>
            {t("mobile.localModels.start")}{isUntested("mobile.localModels.start") && <span className="untested">{t("mobile.newTab.untested")}</span>}
          </button>}
          {rowError?.model === "" && <p className="sheet-note error" role="alert">{t(rowError.key)}</p>}
        </>;
      case "not_installed":
        return <p className="sheet-note">{t("mobile.localModels.notInstalled")}</p>;
      default:
        return <p className="sheet-note">{t("mobile.localModels.unreachable")}</p>;
    }
  })();

  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet local-models-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.localModels.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header>
        <button className="sheet-close" onClick={onClose} aria-label={t("mobile.localModels.close")}>✕</button>
        <h2>{t("mobile.localModels.title")}{isUntested("mobile.localModels") && <small>{t("mobile.newTab.untested")}</small>}</h2>
        <span className="sheet-close" aria-hidden="true" />
      </header>
      {status}
      {models.length > 0 && <ul className="option-list files-list local-models-list">{models.map((row) => {
        const asked = pending[row.name];
        const loading = row.state === "loading" || asked === "load";
        const loaded = row.state === "loaded";
        const state = rowState(row, loading, t);
        return <li key={row.name}>
          <div className="local-model-info">
            <strong>{row.name}</strong>
            {rowMeta(row) && <small>{rowMeta(row)}</small>}
            {state && <small>{state}</small>}
            {row.for_tabs && <small className="local-model-tabs">{t("mobile.localModels.forTabs")}</small>}
          </div>
          {running && !row.remote && <button
            className="files-share"
            disabled={!!asked || row.state === "loading"}
            aria-label={t(loaded ? "mobile.localModels.unloadModel" : "mobile.localModels.loadModel", { name: row.name })}
            onClick={() => void act(loaded ? "unload" : "load", row.name)}
          >{t(loaded ? "mobile.localModels.unload" : "mobile.localModels.load")}</button>}
          {rowError?.model === row.name && <p className="files-share-error" role="alert">{t(rowError.key)}</p>}
        </li>;
      })}</ul>}
      <p className="sheet-note">{t("mobile.localModels.noDownloads")}</p>
    </section>
  </div>;
}

/**
 * Home's **Local models** section: one row that opens the sheet, captioned
 * from one read of the list. It is left out entirely when the desktop's switch
 * is off (`403 local_models_disabled`), when the sidecar predates the feature
 * (`404`, or an answer that is not a list), and when Ollama is not installed
 * on the desktop. With no window open it says to open the app.
 */
export function LocalModelsSection() {
  const t = useT();
  const [list, setList] = useState<LocalModelList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  const [open, setOpen] = useState(false);

  const take = useCallback((next: LocalModelList | null, code: string | null) => {
    setList(next);
    setFailure(code);
    setHidden(code === "local_models_disabled" || code === "not_found" || next?.server === "not_installed");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const read = () => {
      getLocalModels(controller.signal).then(
        (next) => take(next, null),
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          const code = codeOf(reason);
          // A 404 here is a sidecar older than the routes, and a body that
          // is not a list one whose catch-all answered: no feature, no row.
          take(null, reason instanceof ApiError && reason.status === 404 || code === "malformed_response" ? "not_found" : code);
        },
      );
    };
    read();
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [take]);

  // The sheet keeps the caption current while it is open; a row it found
  // switched off stays until the sheet is closed, so the dialog keeps a place.
  const fromSheet = useCallback((next: LocalModelList | null, code: string | null) => {
    if (next) setList(next);
    setFailure(code);
  }, []);
  const close = () => {
    setOpen(false);
    setHidden(failure === "local_models_disabled" || list?.server === "not_installed");
  };

  if (hidden && !open) return null;
  return <>
    <section className="phone-settings local-models-home" aria-labelledby="local-models-heading">
      <h2 id="local-models-heading">{t("mobile.localModels.heading")}</h2>
      <ul className="option-list">
        <li><button aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <span><strong>{t("mobile.localModels.row")}{isUntested("mobile.localModels") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{localModelsCaption(list, failure, t)}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button></li>
      </ul>
    </section>
    {/* Beside the section, not in it: the Home row styling must not reach the
        sheet's buttons (`.phone-settings .option-list button`). */}
    {open && <LocalModelsSheet onChange={fromSheet} onClose={close} />}
  </>;
}
