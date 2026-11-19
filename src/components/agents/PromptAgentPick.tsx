import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { useT } from "../../lib/i18n";
import { Dropdown } from "../common/Dropdown";

export interface PromptCardTarget {
  id: string;
  label: string;
}

interface Props {
  card: PromptChartCard;
  /** A later occurrence of a recurring rule: read-only, like a sent card. */
  occurrence?: string;
  /** The live agent tabs a card can be aimed at. */
  targets: PromptCardTarget[];
  /** What a sent card shows instead of a picker: the tab it went to. */
  targetLabel?: string;
  /** The tab a draft is aimed at, when that tab already holds a scheduled
   *  prompt: the picker no longer lists it, and the card says why. */
  targetBlocked?: string;
  /** For a draft: the picker's first, default choice — a new agent tab
   *  running the chart's agent (`lib/agents/prompt/newTab`). Its value is the
   *  empty target, so an unaimed draft selects it, and Send opens the tab. */
  newTabLabel?: string;
  onAgent: (targetId: string) => Promise<void>;
  className?: string;
}

/**
 * Which agent tab a prompt is aimed at: the picker a draft, scheduled, queued
 * or chained card wears on its face (2026-09-10: it stays there) and the
 * inspector repeats; for a sent card or an occurrence, the tab as plain text.
 */
export function PromptAgentPick({ card, occurrence, targets, targetLabel, targetBlocked, newTabLabel, onAgent, className = "agent-prompt-card-agent" }: Props) {
  const t = useT();
  const readOnly = card.state === "sent" || !!occurrence;
  const newTab = card.state === "draft" && !occurrence ? newTabLabel : undefined;
  const options = [
    ...(newTab ? [{ value: "", label: newTab }] : []),
    ...targets.map((target) => ({ value: target.id, label: target.label })),
  ];
  return (
    <div className={className} onClick={(event) => event.stopPropagation()}>
      {readOnly || options.length === 0
        ? <small>{targetLabel ?? targets.find((target) => target.id === card.targetId)?.label ?? t("promptChart.noAgent")}</small>
        : (
          <Dropdown
            className="agent-prompt-card-agent-pick"
            title={t("promptChart.agent")}
            value={card.targetId ?? ""}
            placeholder={t("promptChart.noAgent")}
            options={options}
            onChange={(value) => void onAgent(value)}
          />
        )}
      {targetBlocked && <div className="agent-schedule-warn agent-prompt-card-warn">{t("promptChart.targetOccupiedShort", { tab: targetBlocked })}</div>}
    </div>
  );
}
