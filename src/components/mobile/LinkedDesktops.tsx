/**
 * Settings → Mobile → Linked desktops (`docs/phone_multi_desktop_plan.md`,
 * Phase 2): the other desktops' phone hosts this desktop's phone UI may be
 * framed by and may frame, so one installed phone app switches between them.
 * A link names an address only and grants no sign-in; each desktop lists the
 * other. The list is part of the phone-host block and written whole, like
 * `root_devices` (every other writer of the block carries it).
 *
 * Desktop only: behind the server gateway the sidecar ignores the list.
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settings";
import { useT, translateNow, type TranslationKey } from "../../lib/i18n";
import { MOBILE_HOST_KEY } from "../../lib/brand";
import { isServerClient } from "../../lib/transport/linkState";
import { canLink, validateLinkedOrigin, type LinkRefusal } from "../../lib/linkedDesktops";
import { UntestedTag } from "../common/UntestedTag";
import { ErrorNote } from "../common/ErrorNote";

const REFUSAL_KEY: Record<LinkRefusal, TranslationKey> = {
  invalid_origin: "mobile.linkedDesktopsErrInvalid",
  not_same_tailnet: "mobile.linkedDesktopsErrTailnet",
  own_origin: "mobile.linkedDesktopsErrOwn",
  already_linked: "mobile.linkedDesktopsErrDuplicate",
  limit: "mobile.linkedDesktopsErrLimit",
};

export function LinkedDesktops({ busy }: { busy: boolean }) {
  const t = useT();
  const stored = useSettingsStore((state) => state.settings?.[MOBILE_HOST_KEY]);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  if (isServerClient()) return null;

  const own = stored?.serve_origin;
  const list = stored?.linked_desktops ?? [];
  const disabled = busy || saving;

  /** One whole-block write, like `setRootReach`; an empty list is no list. */
  const write = async (next: string[]) => {
    setSaving(true);
    try {
      await updateSettings({
        [MOBILE_HOST_KEY]: {
          ...(stored ?? { enabled: false }),
          linked_desktops: next.length > 0 ? next : undefined,
        },
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const add = async () => {
    setError(null);
    const verdict = validateLinkedOrigin(own, entry, list);
    if (!verdict.ok) {
      setError(translateNow(REFUSAL_KEY[verdict.reason]));
      return;
    }
    await write([...list, verdict.origin]);
    setEntry("");
  };

  return (
    <>
      <div className="settings-subheader">
        {t("mobile.linkedDesktops")} <UntestedTag id="mobile.linkedDesktops" />
      </div>
      <p className="settings-help">{t("mobile.linkedDesktopsHelp")}</p>
      {!canLink(own) ? (
        <p className="settings-help">{t("mobile.linkedDesktopsNeedsServe")}</p>
      ) : (
        <>
          <div className="settings-link-row">
            <span className="settings-help">{t("mobile.linkedDesktopsOwn")}</span>
            <code className="settings-help" style={{ userSelect: "all" }}>{own}</code>
            <button
              type="button"
              className="settings-btn sm"
              onClick={() => {
                invoke("copy_text_to_clipboard", { text: own })
                  .then(() => setCopied(true))
                  .catch((reason) => setError(String(reason)));
              }}
            >
              {copied ? t("mobile.browserClientCopied") : t("mobile.linkedDesktopsCopy")}
            </button>
          </div>
          {list.map((origin) => (
            <div className="settings-link-row" key={origin}>
              <code className="settings-help">{origin}</code>
              <button
                type="button"
                className="settings-btn sm"
                disabled={disabled}
                aria-label={t("mobile.linkedDesktopsRemoveOne", { origin })}
                onClick={() => {
                  setError(null);
                  void write(list.filter((other) => other !== origin));
                }}
              >
                {t("mobile.linkedDesktopsRemove")}
              </button>
            </div>
          ))}
          <div className="settings-link-row">
            <input
              className="ollama-pull-input"
              aria-label={t("mobile.linkedDesktopsAddLabel")}
              placeholder="https://laptop.example.ts.net"
              value={entry}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setEntry(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && entry.trim()) {
                  event.preventDefault();
                  void add();
                }
              }}
            />
            <button type="button" className="settings-btn sm" disabled={disabled || !entry.trim()} onClick={() => void add()}>
              {t("mobile.linkedDesktopsAdd")}
            </button>
          </div>
          <p className="settings-help">{t("mobile.linkedDesktopsBothSides")}</p>
        </>
      )}
      {error && <ErrorNote className="project-dialog-error" error={error} />}
    </>
  );
}
