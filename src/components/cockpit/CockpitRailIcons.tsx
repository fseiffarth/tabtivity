import type { ReactElement } from "react";

import type { DecisionGroupId, Decisions } from "../../lib/cockpit/decisions";
import { useT } from "../../lib/i18n";
import { BellIcon } from "../common/BellIcon";
import {
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  PencilIcon,
  QuestionIcon,
  StopIcon,
  UploadIcon,
  type IconProps,
} from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { GROUP_LABEL } from "./CockpitRail";

const GROUP_ICON: Record<DecisionGroupId, (p: IconProps) => ReactElement> = {
  asking: QuestionIcon,
  interrupted: StopIcon,
  push: UploadIcon,
  schedule: ClockIcon,
  markup: PencilIcon,
  unseen: CheckIcon,
  alerts: (p) => <BellIcon className={p.className} />,
};

/**
 * `CockpitRail`'s groups in a 40 px column: one icon per non-empty group with its
 * count (amber while agents ask, red while a turn was cut off), the same
 * `Decisions` model in a different density. A click on an icon, or the top
 * button, opens the full rail (`onExpand`, scrolled to that group). Its buttons
 * do not take the keyboard from a terminal on a mouse press (`preventDefault`
 * on mousedown keeps the focus where it was); Tab still reaches them.
 */
export function CockpitRailIcons({
  decisions,
  onExpand,
}: {
  decisions: Decisions;
  onExpand: (group: DecisionGroupId | null) => void;
}) {
  const t = useT();
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <nav className="cockpit-rail-icons" aria-label={t("cockpit.rail.title")}>
      <button
        type="button"
        className="cockpit-rail-icon cockpit-rail-expand"
        title={t("cockpit.rail.expand")}
        aria-label={t("cockpit.rail.expand")}
        onMouseDown={keepFocus}
        onClick={() => onExpand(null)}
      >
        <ChevronRightIcon />
      </button>
      {decisions.groups.map(({ id, count }) => {
        const Icon = GROUP_ICON[id];
        const label = `${t(GROUP_LABEL[id])}: ${count}`;
        return (
          <button
            key={id}
            type="button"
            className={`cockpit-rail-icon group-${id}`}
            data-group={id}
            title={label}
            aria-label={label}
            onMouseDown={keepFocus}
            onClick={() => onExpand(id)}
          >
            <Icon />
            <span className="cockpit-rail-icon-count">{count > 99 ? "99+" : count}</span>
          </button>
        );
      })}
      <UntestedTag id="cockpit.rootRail" />
    </nav>
  );
}
