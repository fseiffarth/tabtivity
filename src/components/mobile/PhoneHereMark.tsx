import { useT } from "../../lib/i18n";
import { usePhonesInProject, usePhonesOnTab, type PhoneHere } from "../../stores/phonePresence";
import { PhoneIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The 📱 mark on a project pill or a tab: a paired phone is looking into the
 * project, or holds the tab open (`stores/phonePresence`). Faded while every
 * phone there has its screen away (a pocketed phone keeps its tab). Nothing
 * when no phone is there.
 */
export function PhoneHereMark({ phones, place }: { phones: PhoneHere[]; place: "project" | "tab" }) {
  const t = useT();
  if (phones.length === 0) return null;
  const watched = phones.some((p) => p.watched);
  const list = phones
    .map((p) => (p.watched ? p.name : t("phoneHere.screenAway", { name: p.name })))
    .join(", ");
  const title = t(place === "project" ? "phoneHere.projectTitle" : "phoneHere.tabTitle", { list });
  return (
    <span
      className={`${place === "project" ? "pill-vm-glyph" : "tab-schedule-indicator"} phone-here-mark${watched ? "" : " is-away"}`}
      title={title}
      aria-label={title}
    >
      <PhoneIcon size={place === "project" ? 12 : 11} />
      {place === "project" ? <UntestedTag id="phoneHere.projectTitle" /> : <UntestedTag id="phoneHere.tabTitle" />}
    </span>
  );
}

/** The mark for a project pill (scope id). */
export function ProjectPhoneMark({ scope }: { scope: string }) {
  return <PhoneHereMark phones={usePhonesInProject(scope)} place="project" />;
}

/** The mark for a tab, by its tmux session (`TabEntry.tmuxSession`). */
export function TabPhoneMark({ tmuxSession }: { tmuxSession: string | undefined }) {
  return <PhoneHereMark phones={usePhonesOnTab(tmuxSession)} place="tab" />;
}
