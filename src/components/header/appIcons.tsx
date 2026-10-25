import type { ReactNode } from "react";
import { MailIndicator } from "./MailIndicator";
import { CalendarIndicator } from "./CalendarIndicator";
import { TodoIndicator } from "./TodoIndicator";
import { InboxIndicator } from "./InboxIndicator";
import { HelpAgentButton } from "./HelpAgentButton";
import { SettingsMenu } from "./SettingsMenu";
import { LocalModelMenu } from "../layout/LocalModelMenu";
import type { HeaderItemId } from "../../lib/headerPins";

/** The global apps and menus by top-bar id. `HeaderBar` draws the pinned ones in
 *  its own row; `StatusCluster` draws any the user folded, after the pinned
 *  items, so a folded icon always opens to the right of the rest. */
export const APP_ICONS: Partial<Record<HeaderItemId, ReactNode>> = {
  mail: <MailIndicator />,
  calendar: <CalendarIndicator />,
  todo: <TodoIndicator />,
  inbox: <InboxIndicator />,
  models: <LocalModelMenu />,
  help: <HelpAgentButton />,
  settings: <SettingsMenu />,
};
