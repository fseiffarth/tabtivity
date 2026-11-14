import { useRef } from "react";

/**
 * `list`, or the array the last render got when it holds the same items in
 * the same order (`===`). For a list rebuilt on every render from a bigger
 * object (a tab's relabel hands over a new `targets`) that an effect or a
 * memo must not rerun on: depend on the returned array, not the source.
 */
export function useStableList<T>(list: readonly T[]): readonly T[] {
  const kept = useRef(list);
  const last = kept.current;
  if (last !== list && (last.length !== list.length || list.some((item, i) => item !== last[i]))) kept.current = list;
  return kept.current;
}
