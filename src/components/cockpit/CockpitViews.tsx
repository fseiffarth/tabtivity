import { lazy, Suspense } from "react";
import type { ConsoleView } from "../../lib/cockpit/views";
import { CockpitNow } from "./CockpitNow";
import { CockpitProjects } from "./CockpitProjects";
import { CockpitTonight } from "./CockpitTonight";

// The system pages' graphs stay out of the startup chunk and mount only while
// shown. (Mail is mounted by the window itself: its unsent composers outlive the
// view, `layout/RootOverlay`.)
const CalendarView = lazy(() => import("../calendar/CalendarView").then((m) => ({ default: m.CalendarView })));
const TodoView = lazy(() => import("../todo/TodoView").then((m) => ({ default: m.TodoView })));
const AgentsView = lazy(() => import("../models/AgentsView").then((m) => ({ default: m.AgentsView })));
const ModelsView = lazy(() => import("../models/ModelsView").then((m) => ({ default: m.ModelsView })));
const MachinesView = lazy(() => import("../header/MachinesIndicator").then((m) => ({ default: m.MachinesView })));

/** The shown view's body — only the shown one mounts, so a hidden view
 *  computes and loads nothing. */
export function CockpitViewBody({ view }: { view: ConsoleView }) {
  switch (view) {
    case "now":
      return <CockpitNow />;
    case "projects":
      return <CockpitProjects />;
    case "tonight":
      return <CockpitTonight />;
    case "calendar":
      return <Suspense fallback={null}><CalendarView /></Suspense>;
    case "todo":
      return <Suspense fallback={null}><TodoView /></Suspense>;
    case "agents":
      return <Suspense fallback={null}><AgentsView /></Suspense>;
    case "models":
      return <Suspense fallback={null}><ModelsView /></Suspense>;
    case "machines":
      return <Suspense fallback={null}><MachinesView /></Suspense>;
    default:
      return null;
  }
}
