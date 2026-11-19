import { useT, type TranslationKey } from "../../lib/i18n";
import { modifierLabel } from "../../lib/shortcuts/shortcuts";
import { HelpIcon } from "../common/icons/Icon";
import { PromptChartPopoverButton } from "./PromptChartCommandBar";

type HelpKey = TranslationKey;

/** The chart's gestures, grouped by what they are for. Each row is a gesture
 *  and what it does; the keys are the dictionary's, so every language reads
 *  the same rows. */
const GROUPS: { title: HelpKey; rows: [HelpKey, HelpKey][]; note?: HelpKey }[] = [
  {
    title: "promptChart.help.sendTitle",
    rows: [
      ["promptChart.help.draftToTime", "promptChart.help.draftToTimeDo"],
      ["promptChart.help.draftToNow", "promptChart.help.draftToNowDo"],
      ["promptChart.help.dragScheduled", "promptChart.help.dragScheduledDo"],
      ["promptChart.help.cardToDrafts", "promptChart.help.cardToDraftsDo"],
    ],
  },
  {
    title: "promptChart.help.linkTitle",
    rows: [
      ["promptChart.help.port", "promptChart.help.portDo"],
      ["promptChart.help.sequenceToTime", "promptChart.help.sequenceToTimeDo"],
    ],
    note: "promptChart.help.completion",
  },
  {
    title: "promptChart.help.selectTitle",
    rows: [
      ["promptChart.help.multi", "promptChart.help.multiDo"],
      ["promptChart.help.marquee", "promptChart.help.marqueeDo"],
      ["promptChart.help.lift", "promptChart.help.liftDo"],
      ["promptChart.help.wheel", "promptChart.help.wheelDo"],
      ["promptChart.help.draftDouble", "promptChart.help.draftDoubleDo"],
    ],
  },
];

/**
 * The "?" in the command bar: the gestures that used to be printed inline as
 * five standing hint sentences. A reader who knows them never sees them; one
 * who does not opens this once.
 */
export function PromptChartHelp() {
  const t = useT();
  const modifier = modifierLabel();
  return (
    <PromptChartPopoverButton label={t("promptChart.help")} icon={<HelpIcon />} testId="prompt-chart-help" popoverClass="agent-prompt-help-popover">
      {GROUPS.map((group) => (
        <section key={group.title} className="agent-prompt-help-group">
          <h4 className="context-menu-group-label">{t(group.title)}</h4>
          <dl>
            {group.rows.map(([gesture, effect]) => (
              <div key={gesture}>
                <dt>{t(gesture, { modifier })}</dt>
                <dd>{t(effect)}</dd>
              </div>
            ))}
          </dl>
          {group.note && <p>{t(group.note)}</p>}
        </section>
      ))}
    </PromptChartPopoverButton>
  );
}
