import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import {
  carefulIsExplicit,
  isCarefulHost,
  setCarefulPatch,
  type Target,
} from "../../lib/remote/carefulHost";
import { isHpcHost } from "../../lib/remote/hpc/hpcHost";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";

/**
 * "Go easy on this machine" — the per-host **careful** switch.
 *
 * It exists because Tabtivity's background work is priced for a machine you own. On
 * a host you merely have an account on — an HPC login node above all — three of
 * those habits are things the site actively watches: CPU on the login node, a
 * recursive `du` over a tree that usually lives on a *parallel* filesystem (a
 * metadata storm against a shared server), and repeated account lookups against a
 * shared directory service. None of them are expensive for Tabtivity; all of them
 * are rude at a cadence, and one of them is the kind of thing a usage policy
 * names by hand.
 *
 * The switch is **per host, keyed by SSH target**, not per project — see
 * `lib/remote/carefulHost.ts` for why that is the only identity that works when one
 * login node is a primary `remote`, a worker and a global machine at once. This
 * component is deliberately the single rendering of it, so the remote hub, the
 * header's Machines menu and the system monitor can never grow three switches
 * that disagree.
 *
 * **It is on by default and there is no detection behind it.** Every remote host
 * starts careful, because Tabtivity cannot tell whose machine it is and guessing
 * only ever guesses wrong expensively. Flipping it off is a statement about *this*
 * machine — "this one is mine" — recorded per SSH target and kept from then on,
 * which is why it has to be stored rather than re-derived.
 */
export function CarefulHostToggle({
  target,
  disabled,
}: {
  /** The host this governs. Null (a local project) renders nothing. */
  target: Target | null | undefined;
  disabled?: boolean;
}) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  if (!target?.host) return null;

  // A machine tagged HPC is read carefully whatever this says, so the switch
  // shows that rather than offering a choice it doesn't have. Same precedence the
  // backend applies (`services::hpc_mode::is_careful_host`) and the monitor pane's
  // Light/Detailed pair shows — three surfaces, one rule.
  const tagged = isHpcHost(settings, target);
  const careful = tagged || isCarefulHost(settings, target);
  const explicit = carefulIsExplicit(settings, target);

  return (
    <label
      className="remote-connect-remember careful-host-toggle"
      title={t("carefulHost.title")}
    >
      <Toggle
        size="sm"
        checked={careful}
        disabled={disabled || tagged}
        onChange={(e) => void updateSettings(setCarefulPatch(settings, target, e.target.checked))}
      />
      {t("carefulHost.label")} <UntestedTag id="carefulHost.label" />
      <span className="ssh-optional-hint">
        {tagged
          ? t("carefulHost.hintHpcTagged")
          : !explicit
          ? t("carefulHost.hintOnByDefault")
          : careful
            ? t("carefulHost.hintDefault")
            : t("carefulHost.hintNotCareful")}
      </span>
    </label>
  );
}
