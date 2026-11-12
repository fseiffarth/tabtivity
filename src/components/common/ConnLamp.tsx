import type { ConnState } from "../../stores/remote/remoteStatus";

/**
 * A small red/orange/green status lamp for a remote connection channel.
 *  - off        → dim grey
 *  - connecting → orange
 *  - connected  → green
 *  - error      → red
 * Used both in the project dialog (next to the SSH / OpenVPN controls) and in
 * the header (the active remote project's live SSH / VPN state). Nothing here
 * animates: see the `--status-*` note in themes.css — a state told apart by an
 * animation is one you have to *watch* to read, and sixteen breathing lamps in
 * an open Machines menu were also the most expensive thing on screen.
 *
 * `busy` is a second, **orthogonal** axis, not a fifth state: a connected host
 * with live work on it (≥1 tmux session — see `stores/remote/hostBusy`). It exists
 * because with a fleet held open all day "connected" is the resting state and
 * stops distinguishing anything, so the lamp answers "where am I actually
 * running something?" instead — as HOLLOW vs FILLED, the tab ring's
 * unfinished-vs-finished vocabulary applied to a dot: a machine that is merely
 * up is an outline, one with work on it is solid. Same green either way, so the
 * connection state it carries is never in doubt, and it never adds a lamp.
 *
 * Passing `busy` **at all** is what opts a lamp into that distinction, which is
 * why it is `boolean | undefined` rather than defaulting to false: a caller that
 * tracks no work axis (a VPN tunnel, a dialog's SSH channel) has nothing to say
 * about running-vs-up, and for it "connected" IS the whole story — so its lamp
 * stays solid rather than being demoted to an outline by a fact nobody measured.
 * The distinction is only honoured for `connected`; a hollow red or orange would
 * read as a state of the *connection*, which is what the colour already says.
 *
 * `tooltip={false}` keeps the label for screen readers but drops the native
 * `title`: on a button that opens a hover menu, WebKitGTK's tooltip is a window
 * of its own under the resting pointer, and a pointer leaving across it is not
 * seen leaving the page until it is past it — the menu stays up meanwhile.
 */
export function ConnLamp({
  status,
  label,
  busy,
  tooltip = true,
}: {
  status: ConnState;
  label: string;
  busy?: boolean;
  tooltip?: boolean;
}) {
  const isBusy = busy === true && status === "connected";
  // Up, and known to have nothing running — only claimable when the caller
  // measured it (see above).
  const isIdle = busy !== undefined && !isBusy && status === "connected";
  const title = isBusy
    ? `${label}: connected, working`
    : isIdle
      ? `${label}: connected, nothing running`
      : `${label}: ${status}`;
  return (
    <span
      className={`conn-lamp conn-lamp-${status}${isBusy ? " conn-lamp-busy" : ""}${
        isIdle ? " conn-lamp-idle" : ""
      }`}
      role="img"
      aria-label={title}
      title={tooltip ? title : undefined}
    />
  );
}
