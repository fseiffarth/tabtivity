import { UntestedTag } from "../common/UntestedTag";

/**
 * A view's untested pill. The views have no heading row of their own (the
 * strip names the view); the pill rides the first row each view already has —
 * Now's roster head, Projects' toolbar, Tonight's first section head.
 */
export function CockpitUntested({ view }: { view: "now" | "projects" | "tonight" }) {
  // Literal ids: the register's audit reads the pills off the source.
  switch (view) {
    case "now":
      return <UntestedTag id="cockpit.now.heading" />;
    case "projects":
      return <UntestedTag id="cockpit.projects.heading" />;
    case "tonight":
      return <UntestedTag id="cockpit.tonight.heading" />;
  }
}
