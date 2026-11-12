import { useEffect, useState } from "react";

/**
 * Whether a view's section is mounted: the shown one, and every one shown
 * before while the view is, so a section's component state (an install log)
 * outlives a switch away. Derived with `section`, so a first show renders in
 * the same frame, not one effect later.
 */
export function useVisitedSections<T extends string>(section: T): (id: T) => boolean {
  const [visited, setVisited] = useState<ReadonlySet<T>>(() => new Set([section]));
  useEffect(() => {
    setVisited((v) => (v.has(section) ? v : new Set(v).add(section)));
  }, [section]);
  return (id: T) => id === section || visited.has(id);
}
