import type { FilesPanelView } from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import {
  RailAgentsIcon,
  RailAppsIcon,
  RailAssistantIcon,
  RailDivergedIcon,
  RailFilesIcon,
  RailGitIcon,
  RailJobsIcon,
  RailRemarksIcon,
  RailSessionsIcon,
  RailTodoIcon,
} from "../common/EdgeRailIcons";

/**
 * Every side panel view, in the one order both of its doors show them: the
 * panel's view row (`ProjectFilesView`) and the edge rail (`AppShell`). Each
 * gets the same glyph and label in both, so the rail and the row can never
 * read differently.
 */
export interface SidePanelViewDef {
  view: FilesPanelView;
  labelKey: TranslationKey;
  Icon: (props: { className?: string }) => JSX.Element;
}

export const SIDE_PANEL_VIEWS: ReadonlyArray<SidePanelViewDef> = [
  { view: "files", labelKey: "projectFilesView.tabFiles", Icon: RailFilesIcon },
  { view: "git", labelKey: "projectFilesView.tabGit", Icon: RailGitIcon },
  { view: "windows", labelKey: "projectFilesView.tabApps", Icon: RailAppsIcon },
  { view: "agents", labelKey: "projectFilesView.tabAgents", Icon: RailAgentsIcon },
  { view: "orange", labelKey: "projectFilesView.tabDiverged", Icon: RailDivergedIcon },
  { view: "sessions", labelKey: "projectFilesView.tabSessions", Icon: RailSessionsIcon },
  { view: "jobs", labelKey: "projectFilesView.tabJobs", Icon: RailJobsIcon },
  { view: "remarks", labelKey: "projectFilesView.tabRemarks", Icon: RailRemarksIcon },
  { view: "todo", labelKey: "projectFilesView.tabTodo", Icon: RailTodoIcon },
  { view: "assistant", labelKey: "assistant.title", Icon: RailAssistantIcon },
];

/** What decides which of the views a scope offers. */
export interface SidePanelViewGates {
  /** A box scope: no single project, so no project-bound views. */
  inBox: boolean;
  projectId: string | null | undefined;
  remote: boolean;
  /** The remote project keeps a local mirror — false for a host-pinned one
   *  (`isHostPinned`), which has nothing to diverge from the host. */
  mirror: boolean;
  slurm: boolean;
  remarks: boolean;
  todo: boolean;
  /** Tabby offered here (side panel only) and its experimental switch on. */
  assistant: boolean;
}

export function sidePanelViewAvailable(view: FilesPanelView, g: SidePanelViewGates): boolean {
  const project = !g.inBox && !!g.projectId;
  switch (view) {
    case "orange":
      return project && g.remote && g.mirror;
    case "sessions":
      return project && g.remote;
    case "jobs":
      return project && g.slurm;
    case "remarks":
      return project && g.remarks;
    case "todo":
      return !g.inBox && g.todo;
    case "assistant":
      return g.assistant;
    default:
      return true;
  }
}

export function availableSidePanelViews(g: SidePanelViewGates): SidePanelViewDef[] {
  return SIDE_PANEL_VIEWS.filter((d) => sidePanelViewAvailable(d.view, g));
}
