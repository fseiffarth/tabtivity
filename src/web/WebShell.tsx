/**
 * What the browser desktop client mounts beside the app (hosted plan §3.5,
 * §7.1): the one "server connection lost" banner, and the host for the
 * dialogs the `__TAURI_INTERNALS__` shim raises — the server-side file picker
 * for `plugin:dialog|open/save`, the shared prompt dialogs for
 * `confirm`/`message`. Mounted by `main-web.tsx` into its own root after the
 * server's `hello`, before `bootstrap.tsx`; never part of the Tauri window.
 */
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ConfirmDialog, MessageDialog } from "../components/common/PromptDialogs";
import { ServerFilePicker, type ServerFilePickerProps } from "../components/common/ServerFilePicker";
import { UntestedTag } from "../components/common/UntestedTag";
import { SharePresence } from "../components/server/ServerSharing";
import { useT } from "../lib/i18n";
import { linkState, onLinkState, type LinkState } from "../lib/transport/linkState";
import { setDialogAdapter, type DialogAdapter, type MessageOptions, type OpenOptions, type SaveOptions } from "../lib/transport/dialogAdapter";
import type { WsClient } from "../lib/transport/wsClient";

type PendingDialog =
  | { kind: "picker"; props: ServerFilePickerProps }
  | { kind: "confirm"; message: string; options: MessageOptions; done: (ok: boolean) => void }
  | { kind: "message"; message: string; options: MessageOptions; done: () => void };

/** The banner: visible while the link is anything but up. */
export function ServerLinkBanner() {
  const t = useT();
  const [state, setState] = useState<LinkState>(linkState());
  useEffect(() => onLinkState(setState), []);
  if (state === "up") return null;
  return (
    <div className="server-link-banner" role="status" aria-live="polite" data-state={state}>
      {state === "down" ? t("server.banner.down") : t("server.banner.connecting")}
      <UntestedTag id="server.banner.down" />
    </div>
  );
}

/** Renders whichever dialog the shim asked for; registers itself as the adapter. */
export function WebDialogHost() {
  const t = useT();
  const [pending, setPending] = useState<PendingDialog | null>(null);
  useEffect(() => {
    const adapter: DialogAdapter = {
      open: (options: OpenOptions) =>
        new Promise((resolve) =>
          setPending({
            kind: "picker",
            props: {
              mode: "open",
              title: options.title,
              directory: options.directory,
              multiple: options.multiple,
              defaultPath: options.defaultPath,
              filters: options.filters,
              onPick: (picked) => {
                setPending(null);
                resolve(picked);
              },
              onCancel: () => {
                setPending(null);
                resolve(null);
              },
            },
          }),
        ),
      save: (options: SaveOptions) =>
        new Promise((resolve) =>
          setPending({
            kind: "picker",
            props: {
              mode: "save",
              title: options.title,
              defaultPath: options.defaultPath,
              filters: options.filters,
              onPick: (picked) => {
                setPending(null);
                resolve(Array.isArray(picked) ? picked[0] ?? null : picked);
              },
              onCancel: () => {
                setPending(null);
                resolve(null);
              },
            },
          }),
        ),
      confirm: (message, options) => new Promise((resolve) => setPending({ kind: "confirm", message, options, done: resolve })),
      message: (message, options) => new Promise((resolve) => setPending({ kind: "message", message, options, done: resolve })),
    };
    setDialogAdapter(adapter);
    return () => setDialogAdapter(null);
  }, []);

  if (!pending) return null;
  if (pending.kind === "picker") return <ServerFilePicker {...pending.props} />;
  if (pending.kind === "confirm") {
    const { message, options, done } = pending;
    return (
      <ConfirmDialog
        title={options.title ?? t("server.dialog.confirm")}
        body={message}
        confirmLabel={options.okLabel}
        danger={options.kind === "warning" || options.kind === "error"}
        onCancel={() => {
          setPending(null);
          done(false);
        }}
        onConfirm={() => {
          setPending(null);
          done(true);
        }}
      />
    );
  }
  const { message, options, done } = pending;
  return (
    <MessageDialog
      title={options.title ?? t("server.dialog.notice")}
      body={message}
      error={options.kind === "error"}
      onClose={() => {
        setPending(null);
        done();
      }}
    />
  );
}

export function WebShell(_: { client: WsClient }) {
  return (
    <>
      <ServerLinkBanner />
      <WebDialogHost />
      <SharePresence />
    </>
  );
}

/** Mount the shell into its own root, outside the app's `#root`. */
export function mountWebShell(client: WsClient): void {
  const host = document.createElement("div");
  host.id = "web-shell";
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<WebShell client={client} />);
}
