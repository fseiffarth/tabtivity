// The file tree's ▶ Run state: TeX build state, the remembered run arguments
// and their popover, and the "main script" check that gates the button.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import type { TexCapability } from "../../lib/viewers/tex/tex";
import { isPythonPath } from "../../lib/viewers/python";
import { checkMainScripts, needsMainCheck } from "../../lib/terminal/pythonMainCache";
import { readFileText } from "../../lib/files/fileAccess";
import { useClampToViewport } from "../../hooks/useClampToViewport";

// A stable empty-object fallback for the `python_run_args` selector below — a
// fresh `{}` literal on every render would change the snapshot's reference
// identity each time, which `useSyncExternalStore` (what the store hook is
// built on) reads as "changed" and re-renders forever.
const EMPTY_PY_ARGS: Record<string, string> = {};

/** TeX toolchain presence, the .tex files compiling, and the Run button's remembered arguments with their popover. */
export function useFileTreeRunState() {
  // TeX toolchain presence (null until probed); absolute paths of .tex files
  // currently compiling, for the inline build spinner.
  const [texCap, setTexCap] = useState<TexCapability | null>(null);
  const [compiling, setCompiling] = useState<Set<string>>(new Set());
  // Per-file arguments for the ▶ Run button, remembered so a re-run reuses them.
  // Set via the right-click popover (`argsPopover`, positioned at the cursor).
  // Same shared, persisted map the open-editor's Run/Debug toolbar reads/writes
  // (`FileViewerPane.tsx`'s `pyArgs`/`setPyArgs`) — keyed by absolute path in
  // global settings, not local component state, so it survives this tree
  // unmounting (side-panel hide/close) and a Tabtivity restart. Shell scripts
  // (`.sh` & co.) share the map: it is keyed by path, and the name predates them.
  const runArgsByPath = useSettingsStore((s) => s.settings?.python_run_args ?? EMPTY_PY_ARGS);
  const setRunArgs = useCallback((path: string, v: string) => {
    void useSettingsStore.getState().setPythonRunArgs(path, v);
  }, []);
  const [argsPopover, setArgsPopover] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
    draft: string;
  } | null>(null);
  const argsPopoverRef = useRef<HTMLDivElement | null>(null);
  const argsInputRef = useRef<HTMLTextAreaElement | null>(null);
  useClampToViewport(argsPopoverRef, argsPopover, setArgsPopover);
  useEffect(() => {
    if (!argsPopover) return;
    argsInputRef.current?.focus();
    argsInputRef.current?.select();
  }, [argsPopover?.entry.path]);
  return { texCap, setTexCap, compiling, setCompiling, runArgsByPath, setRunArgs, argsPopover, setArgsPopover, argsPopoverRef, argsInputRef };
}

/** The Run button's "is this a main script" check for the listed .py files. */
export function useFileTreePythonMain({
  entries, projectId, fastMode,
}: {
  entries: FileEntry[];
  projectId: string | null;
  fastMode: boolean;
}) {
  // Whether a visible Python file is a "main" script (has a module-level
  // `if __name__ == "__main__":` guard) — the Run ▶ button only shows for
  // those, not for every importable module. It needs the file's content, which
  // the tree listing doesn't carry, so it is read once per *version* of a file
  // and the verdict is persisted in settings.json (`lib/terminal/pythonMainCache`).
  //
  // Persisting is what makes this affordable on BOTH sides. It used to be a
  // component-lifetime ref, so every reopen of the viewer re-read every visible
  // .py — and because that is an SFTP round trip per file on a remote listing,
  // remote skipped the check entirely and showed ▶ on every .py. That is the
  // local/remote disagreement this replaces: the same library module offered a
  // Run button on the host and none on the mirror. Now both sides ask the same
  // question and pay for the answer once.
  const pyMainCache = useSettingsStore((s) => s.settings?.python_main_scripts);
  // Guards against a second scan of files whose read is still in flight (the
  // cache only learns the answer when it lands). Keyed by path + version, so a
  // file edited mid-scan is still re-checked.
  const pyMainInFlight = useRef<Set<string>>(new Set());
  // Bumped by the ↻ refresh button: re-check every listed .py regardless of its
  // stamp. The stamp cannot see a same-second write that lands on an identical
  // size, and "I pressed refresh" is exactly the gesture that should not trust it.
  const [pyMainNonce, setPyMainNonce] = useState(0);
  const pyMainNonceSeen = useRef(0);
  useEffect(() => {
    // Fast mode stops the *scanning*, not the answers already paid for: the
    // cache is still read below, so a file whose verdict is known keeps its \u25b6.
    if (fastMode) return;
    const forced = pyMainNonceSeen.current !== pyMainNonce;
    pyMainNonceSeen.current = pyMainNonce;
    // The ref object's identity never changes, so holding the Set itself is the
    // same Set the cleanup must clear — and it satisfies the hooks lint, which
    // can't know that a ref to a plain Set is not a ref to a DOM node.
    const inFlight = pyMainInFlight.current;
    const version = (e: FileEntry) => `${e.path}#${e.size}#${e.modified_secs ?? 0}`;
    const pending = entries
      .filter((e) => !e.is_dir && isPythonPath(e.path) && !inFlight.has(version(e)))
      .map((e) => ({ path: e.path, size: e.size, mtime: e.modified_secs ?? 0 }))
      .filter((f) => forced || needsMainCheck(pyMainCache, f));
    if (pending.length === 0) return;
    pending.forEach((f) => inFlight.add(`${f.path}#${f.size}#${f.mtime}`));
    let cancelled = false;
    void (async () => {
      const verdicts = await checkMainScripts(
        pending,
        (path) => readFileText(path, projectId),
        { cancelled: () => cancelled },
      );
      if (cancelled) return;
      // One settings write for the whole folder, not one per file.
      await useSettingsStore.getState().setPythonMainVerdicts(verdicts);
    })();
    return () => {
      cancelled = true;
      // A cancelled scan's files were never answered, so they must not stay
      // marked as in flight or the next listing would skip them forever.
      pending.forEach((f) => inFlight.delete(`${f.path}#${f.size}#${f.mtime}`));
    };
  }, [entries, projectId, pyMainCache, pyMainNonce, fastMode]);
  return { pyMainCache, pyMainInFlight, setPyMainNonce };
}
