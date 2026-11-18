import { useCallback, useEffect, useRef, useState } from "react";
import { readFileText, usePaneVisible } from "../../../lib/files/fileAccess";
import { pythonLibRootsFor } from "../../../lib/terminal/pythonRun";
import {
  pythonImportLinks,
  pythonLinkRanges,
  resolvePythonDefinition,
  type PyReader,
} from "../../../lib/viewers/python";
import { jumpToSource } from "./sourceJump";

/** Wait after the last edit before resolving what it changed. */
const RESOLVE_DEBOUNCE_MS = 300;
/** Re-resolve everything after this long, so a library installed (or a venv
 *  created) while the file is open starts linking. */
const RESOLVED_TTL_MS = 60_000;
/** The most outgoing names one pass resolves; the rest wait for the next pass. */
const MAX_KEYS_PER_PASS = 200;

const NONE: ReadonlySet<string> = new Set();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * Ctrl/Cmd+Click go-to-definition for the Python editor (#py), including names
 * from external libraries in the project's environment.
 *
 * The underline stays honest: a name that leads out of the file is resolved in
 * the background first, and only the ones that land somewhere are underlined.
 * An environment outside the project (conda, pyenv, the system Python) cannot be
 * read by the editor, and a compiled module without stubs has no source, so those
 * names stay plain instead of looking clickable and doing nothing.
 */
export function usePythonLinks(opts: {
  enabled: boolean;
  loaded: boolean;
  draft: string;
  path: string;
  projectDir: string;
  projectId: string | null;
  remote: boolean;
}) {
  const { enabled, loaded, draft, path, projectDir, projectId, remote } = opts;
  const visible = usePaneVisible();
  const [followable, setFollowable] = useState<ReadonlySet<string>>(NONE);
  const known = useRef({ ctx: "", at: 0, keys: new Map<string, boolean>() });

  const read = useCallback<PyReader>(
    async (p) => {
      try {
        return await readFileText(p, projectId);
      } catch {
        return null; // doesn't exist / unreadable — just not this candidate
      }
    },
    [projectId],
  );
  const libRoots = useCallback(
    () => (remote ? Promise.resolve([]) : pythonLibRootsFor(projectId, projectDir)),
    [remote, projectId, projectDir],
  );

  useEffect(() => {
    if (!enabled || !loaded || !visible) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const ctx = `${path}\n${projectDir}\n${projectId ?? ""}\n${remote}`;
        if (known.current.ctx !== ctx || Date.now() - known.current.at > RESOLVED_TTL_MS) {
          known.current = { ctx, at: Date.now(), keys: new Map() };
        }
        const keys = known.current.keys;
        const todo = pythonImportLinks(draft)
          .filter((l) => !keys.has(l.key))
          .slice(0, MAX_KEYS_PER_PASS);
        if (todo.length) {
          const roots = await libRoots();
          // One pass reads each candidate file once, however many names share it.
          const files = new Map<string, Promise<string | null>>();
          const cachedRead: PyReader = (p) => {
            let hit = files.get(p);
            if (!hit) {
              hit = read(p);
              files.set(p, hit);
            }
            return hit;
          };
          for (const l of todo) {
            if (cancelled) return;
            const loc = await resolvePythonDefinition(draft, l.caret, path, projectDir, cachedRead, roots);
            keys.set(l.key, loc != null);
          }
        }
        if (cancelled) return;
        const next = new Set([...keys].filter(([, ok]) => ok).map(([k]) => k));
        setFollowable((prev) => (sameSet(prev, next) ? prev : next));
      })();
    }, RESOLVE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, loaded, visible, draft, path, projectDir, projectId, remote, libRoots, read]);

  // `jumpToSource` re-uses an open editor when there is one (including the same
  // file, and across a detached window) and otherwise opens the target in this
  // tab's subwindow.
  const follow = useCallback(
    async (caret: number) => {
      const loc = await resolvePythonDefinition(draft, caret, path, projectDir, read, await libRoots());
      if (loc) jumpToSource(loc.path, loc.line, loc.column);
    },
    [draft, path, projectDir, read, libRoots],
  );

  const linkRanges = useCallback((source: string) => pythonLinkRanges(source, followable), [followable]);

  return { follow, linkRanges };
}
