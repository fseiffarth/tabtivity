// The mode a PDF the phone can mark up opens in, as a list to tap, from the
// start page's "This device" sheet behind the header's gear (`markupOpen.ts`).
// The pen switches Mark up on in any of them, so this only says where the view
// starts.

import type { TranslationKey } from "../../../src/lib/i18n";
import { useT } from "../../../src/lib/i18n";
import { MARKUP_OPENS, writeMarkupOpen, type MarkupOpen } from "../markupOpen";
import { OptionSheet, type SheetOption } from "./OptionSheet";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

const OPEN_NAME: Record<MarkupOpen, TranslationKey> = {
  auto: "mobile.markup.opensIn.auto",
  reading: "mobile.markup.opensIn.reading",
  markup: "mobile.markup.opensIn.markup",
};

/** What the row says it is set to. */
export function markupOpenSummary(choice: MarkupOpen, t: Translate): string {
  return t(OPEN_NAME[choice]);
}

export function MarkupOpenSheet({ chosen, onChoose, onClose }: {
  chosen: MarkupOpen;
  onChoose: (choice: MarkupOpen) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options: SheetOption[] = MARKUP_OPENS.map((choice) => ({
    key: choice,
    label: t(OPEN_NAME[choice]),
    description: choice === "auto" ? t("mobile.markup.opensIn.autoHint") : undefined,
    current: choice === chosen,
  }));
  return <OptionSheet
    title={t("mobile.markup.opensIn.title")}
    note={{ text: t("mobile.markup.opensIn.hint") }}
    options={options}
    waiting=""
    busy={false}
    onPick={(key) => {
      const choice = key as MarkupOpen;
      writeMarkupOpen(choice);
      onChoose(choice);
      onClose();
    }}
    onClose={onClose}
  />;
}
