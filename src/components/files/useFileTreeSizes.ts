// The file tree's folder sizes: the lazy recursive walks for the rows on
// screen, and the per-section byte totals summed from them.
import { useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import { DirSizeUnavailable, guardedDirSize, isHostTimeout } from "../../lib/projects/dirSizeGuard";
import type { useFileTreeRows } from "./useFileTreeRows";

type FileTreeRows = ReturnType<typeof useFileTreeRows>;

/** The lazy recursive folder-size walks for the rendered rows, and each section's byte total. */
export function useFileTreeDirSizes({
  active, fastMode, rowWindow, sections, requestedSizes, sizeGeneration, isScanExcluded,
  relForEntry, projectDir, scanExcludedList, dirSizes, setDirSizes, dirIgnoredBytes,
  setDirIgnoredBytes,
}: {
  active: boolean;
  fastMode: boolean;
  rowWindow: FileTreeRows["rowWindow"];
  sections: FileTreeRows["sections"];
  requestedSizes: MutableRefObject<Set<string>>;
  sizeGeneration: MutableRefObject<number>;
  isScanExcluded: (rel: string) => boolean;
  relForEntry: (entry: FileEntry) => string;
  projectDir: string;
  scanExcludedList: string[];
  dirSizes: Record<string, number>;
  setDirSizes: Dispatch<SetStateAction<Record<string, number>>>;
  dirIgnoredBytes: Record<string, number>;
  setDirIgnoredBytes: Dispatch<SetStateAction<Record<string, number>>>;
}) {
  // Lazily compute the recursive size of each visible gitignored-section
  // folder. Fires one backend call per not-yet-requested folder (concurrently
  // — they're independent) and fills `dirSizes` as each resolves. A failed
  // call is left unresolved; the `requestedSizes` guard keeps it (and
  // steady-state re-renders / fs-watch reloads) from re-dispatching. Plain
  // `dir_size` is enough here — the whole folder is ignored by definition, so
  // there's no split to compute, unlike the regular/standard effect below.
  //
  // Scoped to the RENDERED rows (`rowWindow`), not the whole section: pricing a
  // folder costs a recursive walk — a `du` over SSH for a remote project — so a
  // listing holding thousands of subfolders would dispatch thousands of them for
  // rows that aren't even on screen. `requestedSizes` dedupes, so raising the
  // render cap prices the newly revealed folders and only those. `active` gates
  // all three size effects the same way: a hidden tree walks nothing, and the
  // dedupe set means reactivation prices exactly the still-unpriced folders.
  useEffect(() => {
    if (!active || fastMode) return;
    const pending = rowWindow.gitignored.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      guardedDirSize(projectDir, () =>
        invoke<number>("dir_size", {
          projectDir,
          relPath: relForEntry(e),
          excluded: scanExcludedList,
        }),
      )
        .then((bytes) => {
          if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
        })
        .catch(() => {
          /* best-effort display aid — leave unresolved on failure */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWindow.gitignored, active, fastMode]);

  // Same as the gitignored effect above, for the visible hidden-by-extension
  // rows — a plain `dir_size` is enough here too, since the group's own
  // total needs no ignored/non-ignored split.
  useEffect(() => {
    if (!active || fastMode) return;
    const pending = rowWindow.hiddenExt.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      guardedDirSize(projectDir, () =>
        invoke<number>("dir_size", {
          projectDir,
          relPath: relForEntry(e),
          excluded: scanExcludedList,
        }),
      )
        .then((bytes) => {
          if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
        })
        .catch(() => {
          /* best-effort display aid — leave unresolved on failure */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWindow.hiddenExt, active, fastMode]);

  // Lazily compute the recursive size of each visible regular/standard-section
  // folder, split into ignored vs. non-ignored bytes in the SAME backend walk
  // that produces the total — so a folder with e.g. a build output dir mixed
  // in with source can show that split, and the ignored figure can never
  // exceed the total it was measured against (two independent walks of the
  // same folder can disagree if it's being actively written to, which is
  // exactly the kind of folder — build/output dirs — this feature targets).
  // Fills both `dirSizes` and `dirIgnoredBytes` from one response, sharing
  // `requestedSizes` with the effect above so no folder is fetched twice.
  // Scoped to the rendered rows for the same reason that effect is — see there.
  useEffect(() => {
    if (!active || fastMode) return;
    const candidates = [...rowWindow.regular, ...rowWindow.standard];
    const pending = candidates.filter(
      (e) => e.is_dir && !requestedSizes.current.has(e.path) && !isScanExcluded(relForEntry(e)),
    );
    if (pending.length === 0) return;
    pending.forEach((e) => requestedSizes.current.add(e.path));
    const gen = sizeGeneration.current;
    for (const e of pending) {
      guardedDirSize(projectDir, () =>
        invoke<{ total: number; ignored: number }>("dir_size_breakdown", {
          projectDir,
          relPath: relForEntry(e),
          excluded: scanExcludedList,
        }),
      )
        .then(({ total, ignored }) => {
          if (sizeGeneration.current !== gen) return;
          setDirSizes((m) => ({ ...m, [e.path]: total }));
          if (ignored > 0) setDirIgnoredBytes((m) => ({ ...m, [e.path]: ignored }));
        })
        .catch((err) => {
          // The fallback is for a `dir_size_breakdown` that failed for a reason
          // `dir_size` wouldn't (a backend that hasn't picked up this newer
          // command, no `git` on PATH) — there, a folder's size matters more than
          // its ignored split. It is NOT for a host that stopped answering: a
          // timed-out or breaker-refused call says nothing about the *command*,
          // so retrying with the other one would just queue a second doomed call
          // per folder — twice the pile-up the guard exists to prevent.
          if (err instanceof DirSizeUnavailable || isHostTimeout(err)) return;
          guardedDirSize(projectDir, () =>
            invoke<number>("dir_size", {
              projectDir,
              relPath: relForEntry(e),
              excluded: scanExcludedList,
            }),
          )
            .then((bytes) => {
              if (sizeGeneration.current === gen) setDirSizes((m) => ({ ...m, [e.path]: bytes }));
            })
            .catch(() => {
              /* best-effort display aid — leave unresolved on failure */
            });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWindow.regular, rowWindow.standard, active, fastMode]);

  // Total bytes contained in each section, kept separate rather than merged
  // into one figure — the point of splitting scaffold/gitignored out visually
  // is that their weight (e.g. a huge gitignored build dir) shouldn't hide
  // inside the "real" content total. Sums whatever `dirSizes`/`e.size` already
  // know; unresolved subfolder sizes count as 0 until their `dir_size` call
  // lands, same best-effort as the per-row display above. `regular`/`standard`
  // are non-ignored-only (mirroring the per-row headline number), with the
  // ignored portion pulled out separately so callers can put it on hover —
  // `gitignored` needs no such split, it's ignored content in its entirety.
  const groupSizes = useMemo(() => {
    const total = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirSizes[e.path] ?? 0) : e.size), 0);
    const ignored = (list: FileEntry[]) =>
      list.reduce((sum, e) => sum + (e.is_dir ? (dirIgnoredBytes[e.path] ?? 0) : 0), 0);
    // Whether the sum is still MISSING a folder — the thing that makes it a lower
    // bound rather than a measurement, and the reason it must not be printed as a
    // plain figure (see `renderGroupTotal`). Three independent causes, deliberately
    // folded into one flag because the reader's question is the same for all of
    // them: a `dir_size` still in flight (on a remote project that is a `du` over
    // SSH, four at a time), one that failed or was refused by the breaker, and a
    // folder past the render cap, which is never requested at all. An excluded
    // folder is NOT missing: it is deliberately unmeasured and contributes 0.
    const incomplete = (list: FileEntry[]) =>
      list.some(
        (e) => e.is_dir && dirSizes[e.path] === undefined && !isScanExcluded(relForEntry(e)),
      );
    const regularIgnored = ignored(sections.regular);
    const standardIgnored = ignored(sections.standard);
    return {
      regular: total(sections.regular) - regularIgnored,
      regularIgnored,
      regularPartial: incomplete(sections.regular),
      standard: total(sections.standard) - standardIgnored,
      standardIgnored,
      standardPartial: incomplete(sections.standard),
      gitignored: total(sections.gitignored),
      gitignoredPartial: incomplete(sections.gitignored),
      hiddenExt: total(sections.hiddenExt),
      hiddenExtPartial: incomplete(sections.hiddenExt),
    };
    // `relForEntry`/`isScanExcluded` depend only on `relPath`/`scanExcluded`, both
    // of which force a re-list (and so a fresh `sections`) when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, dirSizes, dirIgnoredBytes]);
  return { groupSizes };
}
