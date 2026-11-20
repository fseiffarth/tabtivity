import { PROMPT_CHART_WINDOWS, type PromptChartFilter, type PromptChartWindow } from "../../lib/agents/prompt/chart";
import { useT } from "../../lib/i18n";

interface Props {
  filter: PromptChartFilter;
  onChange: (next: PromptChartFilter) => void;
  agents: string[];
  tags: { tag: string; count: number }[];
  hideOthers: boolean;
  onHideOthers: () => void;
  /** The "When" facet: it narrows the timeline's cards only (a draft has no instant). */
  window: PromptChartWindow;
  onWindow: (next: PromptChartWindow) => void;
  /** How many cards the facets let through, and of how many: a dimmed card and
   *  a hidden one both read as "nothing here". */
  shown: number;
  total: number;
  /** Reset every facet — view state, never written anywhere. */
  onClear: () => void;
  testId: string;
}

const RESULTS = ["delivered", "queued", "missed", "failed"] as const;

/** One row of mutually exclusive chips (a facet); the first chip clears it. */
function FacetRow({ label, options, value, onPick }: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="agent-prompt-filter-facet" role="group" aria-label={label}>
      <div className="context-menu-group-label">{label}</div>
      <div className="agent-prompts-tags">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`agent-composer-chip${value === option.value ? " active" : ""}`}
            aria-pressed={value === option.value}
            onClick={() => onPick(option.value)}
          >{option.label}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * The body of the command bar's Filters popover: the facets of the ONE filter
 * the whole chart reads. The drafts column and the timeline used to carry a
 * filter each; a search typed to find a draft that also dims the axis is the
 * price of reading the chart as one thing. Text lives in the bar itself.
 */
export function PromptChartFilterBar({ filter, onChange, agents, tags, hideOthers, onHideOthers, window, onWindow, shown, total, onClear, testId }: Props) {
  const t = useT();
  const filtering = !!(filter.text || filter.tag || filter.agent || filter.result || window !== "any");
  return (
    <div className="agent-prompt-chart-filter menu-form" data-testid={testId}>
      {agents.length > 0 && (
        <FacetRow
          label={t("agentPrompts.filterAgent")}
          value={filter.agent}
          options={[{ value: "", label: t("agentPrompts.filterAgentAll") }, ...agents.map((agent) => ({ value: agent, label: agent }))]}
          onPick={(agent) => onChange({ ...filter, agent })}
        />
      )}
      <FacetRow
        label={t("agentPrompts.filterResult")}
        value={filter.result}
        options={[{ value: "", label: t("agentPrompts.filterResultAll") }, ...RESULTS.map((result) => ({ value: result, label: t(`promptChart.result.${result}` as "promptChart.result.delivered") }))]}
        onPick={(result) => onChange({ ...filter, result })}
      />
      <FacetRow
        label={t("promptChart.window")}
        value={window}
        options={PROMPT_CHART_WINDOWS.map((value) => ({ value, label: t(`promptChart.window.${value}` as "promptChart.window.any") }))}
        onPick={(value) => onWindow(value as PromptChartWindow)}
      />
      {tags.length > 0 && (
        <div className="agent-prompt-filter-facet">
          <div className="context-menu-group-label">{t("agentPrompts.filterTag")}</div>
          <div className="agent-prompts-tags">
            {tags.map(({ tag, count }) => (
              <button key={tag} type="button" className={`agent-composer-chip agent-prompts-tag${filter.tag === tag ? " active" : ""}${tag.includes(":") ? " is-auto" : ""}`} aria-pressed={filter.tag === tag} onClick={() => onChange({ ...filter, tag: filter.tag === tag ? "" : tag })}>
                #{tag}<span>{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="agent-prompt-filter-foot">
        <button className={`agent-composer-chip${hideOthers ? " active" : ""}`} type="button" aria-pressed={hideOthers} onClick={onHideOthers}>{t("promptChart.hideOthers")}</button>
        <span className="agent-prompt-chart-selection" data-testid={`${testId}-count`}>
          {t("promptChart.filterCount", { shown, total })}
          {filtering && <button type="button" className="agent-composer-chip" onClick={onClear}>{t("promptChart.clearFilter")}</button>}
        </span>
      </div>
    </div>
  );
}
