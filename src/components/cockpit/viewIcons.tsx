import { FolderIcon, ClockIcon } from "../common/icons/Icon";
import { StarIcon } from "../layout/StarIcon";
import type { TranslationKey } from "../../lib/i18n";
import type { WindowView } from "../../lib/cockpit/views";
import {
  AgentsGlyph,
  BrainGlyph,
  CalendarGlyph,
  CockpitGlyph,
  MachinesGlyph,
  MailGlyph,
  TodoGlyph,
} from "../header/HeaderGlyphs";

/** Each view's name in the strip, its ▾ overflow menu and its icon's tooltip. */
export const VIEW_LABEL: Record<WindowView, TranslationKey> = {
  now: "cockpit.view.now",
  projects: "cockpit.view.projects",
  tonight: "cockpit.view.tonight",
  mail: "cockpit.view.mail",
  calendar: "cockpit.view.calendar",
  todo: "cockpit.view.todo",
  agents: "cockpit.view.agents",
  models: "cockpit.view.models",
  machines: "cockpit.view.machines",
  root: "rootConsole.view.root",
};

/** A view's icon: the header button's glyph for the apps and system pages. */
export function ViewIcon({ view, className = "root-view-icon" }: { view: WindowView; className?: string }) {
  switch (view) {
    case "now":
      return <CockpitGlyph className={className} />;
    case "projects":
      return <FolderIcon className={className} />;
    case "tonight":
      return <ClockIcon className={className} />;
    case "mail":
      return <MailGlyph className={className} />;
    case "calendar":
      return <CalendarGlyph className={className} />;
    case "todo":
      return <TodoGlyph className={className} />;
    case "agents":
      return <AgentsGlyph className={className} />;
    case "models":
      return <BrainGlyph className={className} />;
    case "machines":
      return <MachinesGlyph className={className} />;
    case "root":
      return <StarIcon className={className} />;
  }
}
