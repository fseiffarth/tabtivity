import { lazy, Suspense } from "react";
import type { ConsoleView } from "../../lib/cockpit/views";
import { CockpitNow } from "./CockpitNow";
import { CockpitProjects } from "./CockpitProjects";
import { CockpitTonight } from "./CockpitTonight";

// The system pages' graphs stay out of the startup chunk and mount only while
// shown. (Mail, Calendar and To-do are mounted by the window itself: Mail's
// unsent composers outlive the view, `layout/RootOverlay`.)
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
