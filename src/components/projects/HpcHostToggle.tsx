import { Toggle } from "../common/Toggle";
import { UntestedTag } from "../common/UntestedTag";
import { isHpcHost, setHpcPatch, type Target } from "../../lib/remote/hpc/hpcHost";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";

/**
 * The **HPC tag**, wherever a host is logged in to — the connect dialog's twin of
 * the tick on the Machines menu's add-a-machine form.
 *
 * It sits beside `CarefulHostToggle` and says a strictly stronger thing. Careful
 * is about *reading* (how much of this machine may Tabtivity look at) and has a safe
 * default. This is about *doing*: on a tagged machine Tabtivity runs no disk-usage
 * scan or folder census, no background sync or lockstep poll, never connects at
 * launch by itself, and asks before a run lands on the login node
 * (`lib/remote/hpc/hpcHost.ts`, `docs/context/hpc_careful_mode.md`). None of that can be
 * defaulted on — it would break the features for every ordinary remote box — and
 * none of it can be inferred from the host, since a scheduler on `PATH` says the
 * machine *has* SLURM, not that its operators mind. So it is asked, once, of the
 * only party who knows.
 *
 * Stored per SSH target, so tagging a login node here also tags it as a global
 * machine and as any other project's worker: one physical machine, one answer.
 */
export function HpcHostToggle({
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

  const tagged = isHpcHost(settings, target);

  return (
    <label className="remote-connect-remember careful-host-toggle" title={t("hpcHost.title")}>
      <Toggle
        size="sm"
        checked={tagged}
        disabled={disabled}
        onChange={(e) => void updateSettings(setHpcPatch(settings, target, e.target.checked))}
      />
      {t("hpcHost.label")} <UntestedTag id="hpcHost.label" />
      <span className="ssh-optional-hint">
        {tagged ? t("hpcHost.hintOn") : t("hpcHost.hintOff")}
      </span>
    </label>
  );
}
