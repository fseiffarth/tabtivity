/**
 * The terminal half of path links (`pathLinks.ts`): an xterm link provider that
 * underlines the paths on a row that name an existing file, looked up when
 * the pointer reaches the row (xterm asks per hovered row and waits for the
 * answer), so nothing is resolved for output nobody points at.
 */
import type { IDisposable, ILink, Terminal } from "@xterm/xterm";
import type { FileEntry } from "../viewers/fileUtils";
import { findPathCandidates, isLinkable, resolvePathCandidates, type PathCandidate, type PathLinkContext } from "./pathLinks";
import { cellAt } from "./terminalUrls";

export interface PathLinkHandlers {
  activate: (event: MouseEvent, entry: FileEntry, at: PathCandidate) => void;
  hover: (event: MouseEvent, entry: FileEntry, at: PathCandidate, text: string) => void;
  leave: () => void;
}

export function registerPathLinkProvider(
  term: Pick<Terminal, "registerLinkProvider" | "buffer" | "cols">,
  context: () => PathLinkContext,
  handlers: PathLinkHandlers,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(row, reply) {
      const ctx = context();
      const line = ctx.bases.length ? term.buffer.active.getLine(row - 1) : undefined;
      if (!line) return reply(undefined);
      const text = line.translateToString(true);
      const found = findPathCandidates(text);
      if (!found.length) return reply(undefined);
      void resolvePathCandidates(ctx.bases, found.map((c) => c.path)).then((entries) => {
        const links: ILink[] = [];
        for (const at of found) {
          const entry = entries.get(at.path);
          if (!entry || !isLinkable(entry, ctx.projectDir, ctx.disabled)) continue;
          const shown = text.slice(at.start, at.end);
          links.push({
            range: {
              start: { x: cellAt(line, term.cols, at.start) + 1, y: row },
              end: { x: cellAt(line, term.cols, at.end), y: row },
            },
            text: shown,
            activate: (event) => handlers.activate(event, entry, at),
            hover: (event) => handlers.hover(event, entry, at, shown),
            leave: handlers.leave,
          });
        }
        reply(links.length ? links : undefined);
      });
    },
  });
}
