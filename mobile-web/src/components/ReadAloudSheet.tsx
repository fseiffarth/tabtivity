// How read-aloud reads: whole answers or brief ones, and how fast. One sheet
// off This device, because both belong to the phone and its owner rather
// than to a session; the spoken "faster" / "slower" move the same rate
// (`speechOutput.ts`).

import { useState } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { READING_RATES, readBrief, readingRate, setReadBrief, setReadingRate } from "../speechOutput";
import { OptionSheet, type SheetOption } from "./OptionSheet";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function rateLabel(rate: number, t: Translate): string {
  return t("mobile.speech.rateValue", { rate: new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(rate) });
}

/** What the row that opens the sheet says it is set to. */
export function readAloudSummary(brief: boolean, rate: number, t: Translate): string {
  return `${t(brief ? "mobile.speech.modeBrief" : "mobile.speech.modeFull")} · ${rateLabel(rate, t)}`;
}

export function ReadAloudSheet({ onChange, onClose }: {
  onChange: (brief: boolean, rate: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [brief, setBrief] = useState(readBrief);
  const [rate, setRate] = useState(readingRate);
  const answers = t("mobile.speech.modeGroup");
  const speed = t("mobile.speech.rateGroup");
  const options: SheetOption[] = [
    { key: "mode:full", label: t("mobile.speech.modeFull"), description: t("mobile.speech.modeFullHint"), group: answers, current: !brief },
    { key: "mode:brief", label: t("mobile.speech.modeBrief"), description: t("mobile.speech.modeBriefHint"), group: answers, current: brief },
    ...READING_RATES.map((step) => ({
      key: `rate:${step}`,
      label: rateLabel(step, t),
      description: step === 1 ? t("mobile.speech.rateNormal") : undefined,
      group: speed,
      current: step === rate,
    })),
  ];
  // The sheet stays open: the two groups are picked one after the other.
  return <OptionSheet
    title={t("mobile.speech.reading")}
    note={{ text: t("mobile.speech.readingHint") }}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      const [kind, value] = key.split(":");
      let nextBrief = brief;
      let nextRate = rate;
      if (kind === "mode") {
        nextBrief = value === "brief";
        setReadBrief(nextBrief);
        setBrief(nextBrief);
      } else {
        nextRate = Number(value);
        setReadingRate(nextRate);
        setRate(nextRate);
      }
      onChange(nextBrief, nextRate);
    }}
    onClose={onClose}
  />;
}
