import { useState } from "react";
import { CloseIcon } from "../glyphs";
import { useT } from "../../../src/lib/i18n";
import { useBackLayer } from "../backStack";
import { cleanGroupName, MAX_GROUP_NAME } from "../projectGroups";

/** Name a new project group, or rename one (`projectGroups.ts`). The tab
 *  rename's shape (`RenameSheet`): the same classes, the same Cancel/Save
 *  row. Nothing leaves the phone, so Save cannot fail. */
export function GroupNameSheet({ title, initial = "", onSave, onClose }: {
  title: string;
  initial?: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  useBackLayer(onClose);
  const t = useT();
  const [name, setName] = useState(initial);
  const clean = cleanGroupName(name);
  const save = () => { if (clean) onSave(clean); };
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet schedule-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("common.close")}><CloseIcon size="1em" /></button><h2>{title}</h2><span className="sheet-close" aria-hidden="true" /></header>
      <p className="sheet-note">{t("mobile.home.groupNote")}</p>
      <div className="mobile-schedule-form">
        <label>{t("mobile.home.groupName")}<input
          type="text"
          value={name}
          autoFocus
          maxLength={MAX_GROUP_NAME}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
        /></label>
        <div className="mobile-schedule-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" disabled={!clean} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </section>
  </div>;
}
