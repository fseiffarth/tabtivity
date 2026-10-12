/**
 * What a sleeping pane renders in place of its `TabPane` (performance plan
 * §5.3): an empty box, so the viewer below it is unmounted — its documents,
 * workers, timers and DOM released — while the `TabEntry` keeps everything the
 * wake remount restores from. A pane is asleep only while hidden, so this is
 * never on screen; the positioned `.center-pane` box around it (steering's
 * region, the drag ghost's `data-tab-key`, the focus handler) stays in the
 * layer. Rendered by `PaneSlot`, outside `TabPane`'s `LazyPane`, so a sleeping
 * slot never triggers a chunk load.
 */
export function SleepingPane({ kind }: { kind: string }) {
  return <div className="sleeping-pane" data-sleeping={kind} aria-hidden="true" />;
}
