import { Suspense, lazy } from "react";
import { AppShell } from "./components/layout/AppShell";
import { parseDetachedParam } from "./stores/detached";
import { parsePresentParam } from "./lib/viewers/deck/present";
import { isPdfPresentLabel } from "./components/embed/pdf/present";
import { TooltipHost } from "./components/common/TooltipHost";

// Code-split (§5.1 startup size): a static import would pull the deck renderer
// — and through `deckBase`, all of pdfjs-dist — into the startup chunk of
// EVERY window, though only the `?present=` audience window renders this.
const DeckAudienceApp = lazy(() =>
  import("./components/embed/deck/DeckAudienceApp").then((m) => ({ default: m.DeckAudienceApp })),
);

// The other kind of `?present=` window: one PDF, fullscreen, and nothing else
// (`components/embed/pdf/present.ts`). Split for the same reason — it pulls
// pdfjs-dist, which no other window's startup should pay for.
const PdfPresentApp = lazy(() =>
  import("./components/embed/pdf/PdfPresentApp").then((m) => ({ default: m.PdfPresentApp })),
);

// A popped-out subwindow's root (perf plan §6). The main window never renders
// it, so its chunk (the popout's tab bars, drag-claim host and layout) stays
// out of the main window's startup; a popout fetches it before first paint.
// Everything it shares with the main shell (TabPane, the stores) is still one
// shared chunk, loaded once per window either way.
const DetachedApp = lazy(() =>
  import("./components/layout/DetachedApp").then((m) => ({ default: m.DetachedApp })),
);

export function App() {
  return <><AppContent /><TooltipHost /></>;
}

function AppContent() {
  // #42: when launched with `?detached=<scope>:<group>` (a popped-out subwindow),
  // render the lightweight DetachedApp instead of the full shell. DetachedApp is
  // inert to project switches (no projects store / runtime-switch listener), so
  // the main window's project switching never drives the detached renderer.
  const detached = parseDetachedParam(window.location.search);
  if (detached) {
    return (
      <Suspense fallback={null}>
        <DetachedApp param={detached} />
      </Suspense>
    );
  }
  // M#90: `?present=<label>` is a presentation window — lighter still than a
  // popout: no tabs, no layout, no store, just what it is told to show. The label
  // says which kind: the deck presenter's AUDIENCE window (the one that goes on
  // the projector), or a PDF shown fullscreen on its own. Both share the prefix
  // because that is what the window capabilities are granted by.
  const present = parsePresentParam(window.location.search);
  if (present) {
    return (
      <Suspense fallback={null}>
        {isPdfPresentLabel(present) ? (
          <PdfPresentApp label={present} />
        ) : (
          <DeckAudienceApp label={present} />
        )}
      </Suspense>
    );
  }
  return <AppShell />;
}
