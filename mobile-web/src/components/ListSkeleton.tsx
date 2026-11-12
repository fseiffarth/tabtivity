import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";

/**
 * A list on its way in: a few still, cut-corner rows in the group surface
 * that pulse by opacity alone (none under reduced motion). The block is the
 * screen's one `role=status`, named by the loading text it carries for a
 * screen reader; the rows are decoration.
 */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  const t = useT();
  return <>
    <div className="list-skeleton" role="status">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => <i key={index} aria-hidden="true" />)}
    </div>
    {isUntested("mobile.design.skeletons") && <p className="list-skeleton-note"><span className="untested">{t("mobile.newTab.untested")}</span></p>}
  </>;
}
