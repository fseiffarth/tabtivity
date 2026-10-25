import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import { DialogShell } from "./PromptDialogs";
import { UntestedTag } from "./UntestedTag";

/**
 * Said once when the API proxy could not bind the port of its last run
 * (`services::api_proxy_port`): a keyed agent that outlived a crash still names
 * that port and would send its conversation to whoever holds it. The backend
 * has already ended the agent sessions that named it; this only tells the user
 * which, and who held the port. Read from a small file, not an event, so a
 * notice written before the window finished loading still arrives.
 */

/** Mirrors `services::api_proxy_port::PortNotice` (camelCase). */
interface PortNotice {
  ts: number;
  port: number;
  newPort: number;
  holder: "fenced" | "otherAccount" | "otherProcess" | "unknown";
  ended: string[];
  failed: string[];
}

const HOLDER_KEY: Record<PortNotice["holder"], TranslationKey> = {
  fenced: "apiProxyPort.holderFenced",
  otherAccount: "apiProxyPort.holderOtherAccount",
  otherProcess: "apiProxyPort.holderOtherProcess",
  unknown: "apiProxyPort.holderUnknown",
};

export function ApiProxyPortDialog() {
  const t = useT();
  const [notice, setNotice] = useState<PortNotice | null>(null);

  useEffect(() => {
    let live = true;
    invoke<PortNotice | null>("api_proxy_port_notice")
      .then((found) => {
        if (live && found) setNotice(found);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!notice) return null;
  const close = () => {
    setNotice(null);
    void invoke("api_proxy_port_notice_ack").catch(() => {});
  };

  return (
    <DialogShell onDismiss={close}>
      <h2>
        {t("apiProxyPort.title")} <UntestedTag id="apiProxyPortDialog.1" />
      </h2>
      <p className="file-delete-body">
        {t("apiProxyPort.lede", { port: notice.port, newPort: notice.newPort, holder: t(HOLDER_KEY[notice.holder]) })}
      </p>
      <p className="file-delete-body">
        {notice.ended.length > 0
          ? t(notice.ended.length === 1 ? "apiProxyPort.endedOne" : "apiProxyPort.endedMany", { count: notice.ended.length })
          : t("apiProxyPort.endedNone")}
      </p>
      {notice.ended.length > 0 && (
        <ul className="file-delete-body">
          {notice.ended.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {notice.failed.length > 0 && (
        <>
          <p className="file-delete-body">{t("apiProxyPort.failed")}</p>
          <ul className="file-delete-body">
            {notice.failed.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </>
      )}
      <div className="file-delete-actions">
        <button type="button" autoFocus onClick={close}>
          {t("howToStart.gotIt")}
        </button>
      </div>
    </DialogShell>
  );
}
