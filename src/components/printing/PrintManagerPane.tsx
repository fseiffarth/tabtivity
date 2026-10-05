import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { PrinterIcon } from "../common/PrinterIcon";
import {
  formatSize,
  jobStateLabelKey,
  jobsFor,
  orphanJobs,
  printJobCancel,
  printJobsCancelAll,
  printSetDefault,
  printSetEnabled,
  printSnapshot,
  printTestPage,
  printerStateKey,
  printerStateLabelKey,
  printerTone,
} from "../../lib/window/printing";
import {
  networkIdentity,
  networkKey,
  networkLabel,
  type NetworkIdentity,
  type PrinterNetworkDefaults,
} from "../../lib/window/printerNetworkDefaults";
import { useSettingsStore } from "../../stores/settings";
import type { PrintJob, PrintSnapshot, PrinterInfo } from "../../types/printing";
import { ErrorNote } from "../common/ErrorNote";

/**
 * The print manager tab: the machine's printers, what is queued on each, and the
 * few verbs a queue is worth opening for (make default, pause/resume, test page,
 * cancel).
 *
 * It replaces the `print_manager` **global app** slot — the button that launched
 * whatever external printer GUI was configured — for the reason the mail,
 * calendar and file-manager roles were retired before it: what sat behind that
 * button was a list and a handful of actions, and a list is something Tabtivity can
 * render itself, in the same window, under the same theme.
 *
 * Three properties it shares with the other machine-wide panes:
 *
 *  - **No project props.** Printers belong to the machine, not to a project, so
 *    this pane takes only `visible` — the same shape as `CalendarPane`. A tab in
 *    any scope shows the same printers, which is why the tab is a singleton.
 *  - **It polls only while on screen.** Every read shells out to `lpstat`/the
 *    spooler, so a background tab costs nothing: the interval is armed by
 *    `visible` and torn down with it.
 *  - **A failed action reports the print system's own words.** CUPS answers
 *    "Forbidden" when the user is outside `lpadmin`, and that sentence is the
 *    only thing they can act on — so it is shown verbatim rather than replaced
 *    with a generic failure.
 */
export interface PrintManagerPaneProps {
  visible?: boolean;
}

/**
 * How often an on-screen pane re-reads the queues. One read is five short-lived
 * process spawns on CUPS (`lpstat` ×4 + `lpq`), so this is deliberately slower
 * than the system monitor's tick: a queue changes on the scale of a document
 * printing, not a CPU sample. Every action re-reads immediately anyway, so the
 * interval only covers changes made *outside* Tabtivity.
 */
const POLL_MS = 10_000;

export function PrintManagerPane({ visible = true }: PrintManagerPaneProps) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<PrintSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [network, setNetwork] = useState<NetworkIdentity | null>(null);
  const netDefaults = useSettingsStore((s) => s.settings?.printer_network_defaults);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  // Guards the poll against overlapping reads: a probe that outlives its
  // interval (an unreachable CUPS server waits out the backend's cap) must not
  // stack a second one behind it.
  const readingRef = useRef(false);

  const read = useCallback(async () => {
    if (readingRef.current) return;
    readingRef.current = true;
    try {
      // The network is read with the queues so the per-network controls follow
      // a laptop that changes networks while this pane is open.
      const [snap, net] = await Promise.all([printSnapshot(), networkIdentity()]);
      setSnapshot(snap);
      setNetwork(net);
    } finally {
      readingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void read();
    const id = window.setInterval(() => void read(), POLL_MS);
    return () => window.clearInterval(id);
  }, [visible, read]);

  // Run one action, then re-read: every verb here changes something the
  // snapshot reports, and a queue that still shows a cancelled job reads as a
  // failed cancel. `onDone` names what happened, for the actions whose effect is
  // otherwise invisible (a test page leaves no trace in the UI).
  const act = useCallback(
    async (fn: () => Promise<void>, onDone?: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await fn();
        if (onDone) setNotice(onDone);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
        await read();
      }
    },
    [read],
  );

  const refreshing = snapshot === null;
  const netKey = networkKey(network);
  const netLabel = network && netKey ? networkLabel(network, t) : "";

  // Saving a per-network default also makes it the default now: the user is on
  // that network, and a choice that only took effect after the next network
  // change would read as a button that did nothing.
  const setNetworkDefault = (printer: string | null) => {
    if (!netKey) return;
    const next: PrinterNetworkDefaults = { ...netDefaults };
    if (printer) next[netKey] = { printer, label: netLabel };
    else delete next[netKey];
    void act(async () => {
      await updateSettings({ printer_network_defaults: next });
      if (printer) await printSetDefault(printer);
    });
  };
  const forgetNetwork = (key: string) => {
    const next: PrinterNetworkDefaults = { ...netDefaults };
    delete next[key];
    void act(() => updateSettings({ printer_network_defaults: next }));
  };
  const savedNetworks = Object.entries(netDefaults ?? {});
  const orphans = snapshot ? orphanJobs(snapshot) : [];

  return (
    <div className="print-pane">
      <div className="print-toolbar">
        <span className="print-title">
          <PrinterIcon className="print-title-icon" />
          {t("printing.title")} <UntestedTag id="printing.title" />
        </span>
        <span className="print-toolbar-spacer" />
        {netLabel && (
          <span className="print-default-note" title={netLabel}>
            {t("printing.networkIs", { network: netLabel })}
          </span>
        )}
        {snapshot?.default_printer && (
          <span className="print-default-note" title={snapshot.default_printer}>
            {t("printing.defaultIs", { printer: snapshot.default_printer })}
          </span>
        )}
        <button
          type="button"
          className="print-btn"
          onClick={() => void read()}
          disabled={busy || refreshing}
        >
          {t("printing.refresh")}
        </button>
      </div>

      {error && <ErrorNote className="print-strip error" error={error} />}
      {notice && <div className="print-strip notice">{notice}</div>}
      {/* The backend's own note (no tooling, a probe that timed out). Kept
          separate from `error`, which only ever holds an action's failure. */}
      {snapshot?.note && <div className="print-strip notice">{snapshot.note}</div>}

      <div className="print-body">
        {refreshing && <div className="print-empty">{t("printing.reading")}</div>}

        {snapshot && !snapshot.supported && (
          <div className="print-empty">{t("printing.noSystem")}</div>
        )}

        {snapshot?.supported && snapshot.printers.length === 0 && (
          <div className="print-empty">{t("printing.noPrinters")}</div>
        )}

        {snapshot?.printers.map((printer) => (
          <PrinterCard
            key={printer.name}
            printer={printer}
            jobs={jobsFor(snapshot.jobs, printer.name)}
            busy={busy}
            onAct={act}
            networkLabel={netLabel}
            networkDefault={netKey ? netDefaults?.[netKey]?.printer === printer.name : false}
            onNetworkDefault={netKey ? setNetworkDefault : undefined}
          />
        ))}

        {orphans.length > 0 && (
          <section className="print-card">
            <div className="print-card-head">
              <span className="print-printer-name">{t("printing.otherJobs")}</span>
            </div>
            <JobTable jobs={orphans} busy={busy} onAct={act} />
          </section>
        )}

        {savedNetworks.length > 0 && (
          <section className="print-card">
            <div className="print-card-head">
              <span className="print-printer-name">{t("printing.networkDefaults")}</span>
              <UntestedTag id="printing.networkDefaults" />
            </div>
            <table className="print-jobs">
              <thead>
                <tr>
                  <th>{t("printing.colNetwork")}</th>
                  <th>{t("printing.colPrinter")}</th>
                  <th aria-label={t("printing.colActions")} />
                </tr>
              </thead>
              <tbody>
                {savedNetworks.map(([key, entry]) => (
                  <tr key={key}>
                    <td className="print-job-title" title={entry.label || key}>
                      {entry.label || key}
                      {key === netKey && ` ${t("printing.networkCurrent")}`}
                    </td>
                    <td>{entry.printer}</td>
                    <td>
                      <button
                        type="button"
                        className="print-btn small danger"
                        disabled={busy}
                        title={t("printing.networkForget")}
                        onClick={() => forgetNetwork(key)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

interface ActRunner {
  (fn: () => Promise<void>, onDone?: string): Promise<void>;
}

function PrinterCard({
  printer,
  jobs,
  busy,
  onAct,
  networkLabel,
  networkDefault,
  onNetworkDefault,
}: {
  printer: PrinterInfo;
  jobs: PrintJob[];
  busy: boolean;
  onAct: ActRunner;
  networkLabel: string;
  /** This printer is the saved default for the network the machine is on. */
  networkDefault: boolean;
  /** Save (a name) or clear (null) the current network's default; absent when
   *  the network cannot be told apart, so the button is not offered. */
  onNetworkDefault?: (printer: string | null) => void;
}) {
  const t = useT();
  const tone = printerTone(printer);
  const paused = printerStateKey(printer.state) === "stopped";
  const detail = [printer.description, printer.location].filter(Boolean).join(" · ");

  return (
    <section className="print-card">
      <div className="print-card-head">
        <span className={`print-lamp ${tone}`} aria-hidden />
        <span className="print-printer-name">{printer.name}</span>
        {printer.is_default && <span className="print-badge">{t("printing.defaultBadge")}</span>}
        {networkDefault && (
          <span className="print-badge" title={t("printing.networkBadgeHint")}>
            {t("printing.networkBadge", { network: networkLabel })}
          </span>
        )}
        <span className="print-state">{t(printerStateLabelKey(printer))}</span>
        {/* Stopped and "not accepting" are different failures and are reported
            as two, because a queue that takes jobs it will never print is the
            case a single status word hides. */}
        {!printer.accepting && (
          <span className="print-state warn">{t("printing.notAccepting")}</span>
        )}
        {printer.state_message && (
          <span className="print-state-message">{printer.state_message}</span>
        )}
      </div>

      {detail && <div className="print-card-detail">{detail}</div>}

      <div className="print-card-actions">
        {!printer.is_default && (
          <button
            type="button"
            className="print-btn"
            disabled={busy}
            onClick={() => void onAct(() => printSetDefault(printer.name))}
          >
            {t("printing.setDefault")}
          </button>
        )}
        {onNetworkDefault && (
          <button
            type="button"
            className="print-btn"
            disabled={busy}
            title={t("printing.networkDefaultHint", { network: networkLabel })}
            onClick={() => onNetworkDefault(networkDefault ? null : printer.name)}
          >
            {networkDefault ? t("printing.networkUnset") : t("printing.networkSet")}
            <UntestedTag id="printing.networkSet" />
          </button>
        )}
        <button
          type="button"
          className="print-btn"
          disabled={busy}
          title={t("printing.pauseHint")}
          onClick={() => void onAct(() => printSetEnabled(printer.name, paused))}
        >
          {paused ? t("printing.resume") : t("printing.pause")}
        </button>
        <button
          type="button"
          className="print-btn"
          disabled={busy}
          onClick={() =>
            void onAct(
              () => printTestPage(printer.name),
              t("printing.testPageSent", { printer: printer.name }),
            )
          }
        >
          {t("printing.testPage")}
        </button>
        {jobs.length > 0 && (
          <button
            type="button"
            className="print-btn danger"
            disabled={busy}
            onClick={() => void onAct(() => printJobsCancelAll(printer.name))}
          >
            {t("printing.cancelAll")}
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <div className="print-queue-empty">{t("printing.queueEmpty")}</div>
      ) : (
        <JobTable jobs={jobs} busy={busy} onAct={onAct} />
      )}
    </section>
  );
}

/** The queue itself, in the order the print system reported it — deliberately
 *  not re-sorted, because that order IS what a queue tells you. */
function JobTable({ jobs, busy, onAct }: { jobs: PrintJob[]; busy: boolean; onAct: ActRunner }) {
  const t = useT();
  return (
    <table className="print-jobs">
      <thead>
        <tr>
          <th>{t("printing.colDocument")}</th>
          <th>{t("printing.colUser")}</th>
          <th>{t("printing.colSize")}</th>
          <th>{t("printing.colSubmitted")}</th>
          <th>{t("printing.colState")}</th>
          <th aria-label={t("printing.colActions")} />
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id}>
            <td className="print-job-title" title={job.title}>
              {job.title}
            </td>
            <td>{job.user}</td>
            <td>{formatSize(job.size_bytes)}</td>
            <td className="print-job-time">{job.submitted}</td>
            <td>{t(jobStateLabelKey(job))}</td>
            <td>
              <button
                type="button"
                className="print-btn small danger"
                disabled={busy}
                title={t("printing.cancelJob")}
                onClick={() => void onAct(() => printJobCancel(job.printer, job.id))}
              >
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
