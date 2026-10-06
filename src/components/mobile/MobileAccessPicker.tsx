import { useEffect, useState } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import { CheckboxIcon, CheckIcon, SquareIcon } from "../common/icons/Icon";
import { phoneReach, usePairedPhones, type PairedPhone, type PhoneReach } from "./usePairedPhones";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** "All phones" / "1 phone" / "2 phones" / "No phones" — a scope's reach as
 *  its button names it. Off has no label of its own (the switch says it). */
export function phoneReachLabel(reach: PhoneReach, t: Translate): string {
  switch (reach.kind) {
    case "all":
      return t("mobile.phones.all");
    case "some":
      return reach.count === 1 ? t("mobile.phones.countOne") : t("mobile.phones.count", { count: reach.count });
    case "none":
      return t("mobile.phones.none");
    case "off":
      return t("mobile.phones.off");
  }
}

/** The paired date of a phone row, in the reader's locale. */
function pairedOn(phone: PairedPhone): string {
  return new Date(phone.created_at * 1000).toLocaleDateString();
}

/**
 * Which paired phones a project's or box's Mobile access reaches — the one
 * picker behind the project side panel's phone button and the "All phones ▾"
 * buttons of Settings → Mobile. *All phones* (the default, phones paired later
 * included) or *Only these phones*, a checklist of the paired phones; plus
 * *Turn off* while access is on.
 *
 * Built from the members checklist of a box pill's menu (`BoxScopeChip`):
 * `context-menu-group` + `context-menu-check` rows, and like that menu it stays
 * open across clicks — each choice is written at once, through `onApply`.
 * `onApply(true, null)` means every phone; a list means exactly those ids, and
 * is never empty: unticking the last phone is refused (turning access off is
 * the way to reach no phone). Re-reads the paired phones each time it opens.
 */
export function MobileAccessPicker({
  x,
  y,
  kind,
  enabled,
  devices,
  onApply,
  onClose,
}: {
  x: number;
  y: number;
  kind: "project" | "box";
  enabled: boolean;
  /** The stored per-phone list (`undefined` = every phone). */
  devices: unknown;
  onApply: (enabled: boolean, devices: string[] | null) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const { phones } = usePairedPhones();
  const scoped = enabled && devices !== undefined && devices !== null;
  const [only, setOnly] = useState(scoped);
  // Follow what the store holds once a choice lands (All clears the list,
  // the first tick writes one); a bare "Only these" click stays local until
  // a phone is ticked, since an empty list is never written.
  useEffect(() => setOnly(scoped), [scoped, devices]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listed: string[] =
    scoped && Array.isArray(devices) && devices.every((d) => typeof d === "string") ? devices : [];
  const paired = phones ?? [];
  const ticked = listed.filter((id) => paired.some((p) => p.id === id));
  const reach = phoneReach(enabled, devices, phones);

  const apply = (nextEnabled: boolean, nextDevices: string[] | null): Promise<boolean> => {
    setBusy(true);
    setError(null);
    return onApply(nextEnabled, nextDevices)
      .then(() => true)
      .catch((reason) => {
        setError(String(reason));
        return false;
      })
      .finally(() => setBusy(false));
  };

  const chooseAll = () => {
    setOnly(false);
    if (enabled && !scoped) return;
    void apply(true, null);
  };
  const togglePhone = (id: string) => {
    const on = ticked.includes(id);
    if (on && ticked.length === 1) return;
    void apply(true, on ? ticked.filter((x) => x !== id) : [...ticked, id]);
  };

  return (
    <ContextMenuPortal x={x} y={y} onClose={onClose} keepBelow className="context-menu mobile-access-picker">
      <div className="menu-scroll-region">
        <div className="context-menu-group">
          <div className="context-menu-group-label">
            {t("mobile.phones.pickerTitle")} <UntestedTag id="mobile.phonePicker" />
          </div>
          <button
            type="button"
            className="context-menu-check"
            role="menuitemradio"
            aria-checked={enabled && !only}
            disabled={busy}
            onClick={chooseAll}
          >
            <span className="context-menu-checkmark" aria-hidden>
              {enabled && !only ? <CheckIcon /> : null}
            </span>
            {t("mobile.phones.all")}
          </button>
          <div className="context-menu-note">{t("mobile.phones.allHelp")}</div>
          <button
            type="button"
            className="context-menu-check"
            role="menuitemradio"
            aria-checked={only}
            disabled={busy || paired.length === 0}
            onClick={() => setOnly(true)}
          >
            <span className="context-menu-checkmark" aria-hidden>
              {only ? <CheckIcon /> : null}
            </span>
            {t("mobile.phones.only")}
          </button>
          {only &&
            paired.map((phone) => {
              const on = ticked.includes(phone.id);
              const last = on && ticked.length === 1;
              return (
                <button
                  key={phone.id}
                  type="button"
                  className="context-menu-check"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  aria-label={phone.name}
                  disabled={busy || last}
                  title={last ? t("mobile.phones.keepOne") : undefined}
                  onClick={() => togglePhone(phone.id)}
                >
                  <span className="context-menu-checkmark" aria-hidden>
                    {on ? <CheckboxIcon /> : <SquareIcon />}
                  </span>
                  {phone.name}
                  {phone.online && (
                    <span className="tab-new-menu-dot tab-new-menu-dot--accent" title={t("mobile.phones.online")}>
                      {" "}●
                    </span>
                  )}
                  <span className="tab-menu-hint">{t("mobile.phones.paired", { date: pairedOn(phone) })}</span>
                </button>
              );
            })}
          {only && ticked.length === 0 && reach.kind === "none" && (
            <div className="context-menu-note" role="status">{t("mobile.phones.nonePaired")}</div>
          )}
          {only && ticked.length === 0 && reach.kind !== "none" && paired.length > 0 && (
            <div className="context-menu-note">{t("mobile.phones.tickHint")}</div>
          )}
          {only && ticked.length === 1 && <div className="context-menu-note">{t("mobile.phones.keepOne")}</div>}
          {phones !== null && paired.length === 0 && (
            <div className="context-menu-note">{t("mobile.phones.noPhonesYet")}</div>
          )}
          <div className="context-menu-note">{t("mobile.phones.repairNote")}</div>
          {kind === "box" && <div className="context-menu-note">{t("mobile.phones.boxNote")}</div>}
          {error && <ErrorNote className="context-menu-note" role="alert" error={error} />}
        </div>
        {enabled && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void apply(false, null).then((ok) => ok && onClose())}
          >
            {t("mobile.phones.turnOff")}
          </button>
        )}
      </div>
    </ContextMenuPortal>
  );
}
