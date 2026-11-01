import { useT } from "../../lib/i18n";

/**
 * What a surface shows while its rows are on the way: static blocks where the
 * rows will land, never a spinner. One `role="status"` per surface says
 * "Loading…" to a screen reader; the blocks themselves are decoration.
 */
export function SkeletonRows({ count = 5, className }: { count?: number; className?: string }) {
  const t = useT();
  return (
    <div className={className ? `skeleton-rows ${className}` : "skeleton-rows"} role="status" aria-label={t("common.loading")}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
