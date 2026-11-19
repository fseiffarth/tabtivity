import { useT } from "../../lib/i18n";
import { Dropdown, type DropdownOption } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { GearIcon } from "../common/icons/Icon";
import { PromptChartPopoverButton } from "./PromptChartCommandBar";

interface Props {
  linkKind: "related" | "after";
  onLinkKind: (kind: "related" | "after") => void;
  /** The agents a draft's "New agent tab" can open, and the model picks of the chosen one. */
  agent: string;
  agentOptions: DropdownOption[];
  onAgent: (agent: string) => void;
  model: string;
  models: string[];
  onModel: (model: string) => void;
}

/**
 * The gear in the command bar: the two sticky defaults that used to sit in the
 * top row like primary actions. What a new link is (After or Related) and what
 * a draft's "New agent tab" opens (the agent, and the model it is told to use
 * ahead of the prompt). Both are read where they are used; nothing here acts.
 */
export function PromptChartOptions({ linkKind, onLinkKind, agent, agentOptions, onAgent, model, models, onModel }: Props) {
  const t = useT();
  return (
    <PromptChartPopoverButton label={t("promptChart.options")} icon={<GearIcon />} testId="prompt-chart-options" popoverClass="agent-prompt-options-popover">
      <div className="menu-form agent-prompt-options">
        <div className="context-menu-group-label">{t("promptChart.options")} <UntestedTag id="promptChart.options" /></div>
        <div className="agent-prompt-options-row" role="group" aria-label={t("promptChart.linkKind")}>
          <span>{t("promptChart.linkKind")}</span>
          <div className="agent-prompts-tags">
            <button type="button" className={`agent-composer-chip${linkKind === "after" ? " active" : ""}`} aria-pressed={linkKind === "after"} onClick={() => onLinkKind("after")}>{t("promptChart.after")}</button>
            <button type="button" className={`agent-composer-chip${linkKind === "related" ? " active" : ""}`} aria-pressed={linkKind === "related"} onClick={() => onLinkKind("related")}>{t("promptChart.related")}</button>
          </div>
        </div>
        <div className="agent-prompt-options-row" role="group" aria-label={t("promptChart.newTabDefaults")} title={t("promptChart.newTabDefaultsTitle")}>
          <span>{t("promptChart.newTabDefaults")}</span>
          <Dropdown title={t("promptChart.newTabAgent")} value={agent} options={agentOptions} onChange={onAgent} />
          {models.length > 0 && (
            <Dropdown
              title={t("agentPrompts.modelTitle")}
              value={model}
              placeholder={t("promptChart.newTabModelDefault")}
              options={[{ value: "", label: t("promptChart.newTabModelDefault") }, ...models.map((name) => ({ value: name, label: name }))]}
              onChange={onModel}
            />
          )}
        </div>
      </div>
    </PromptChartPopoverButton>
  );
}
