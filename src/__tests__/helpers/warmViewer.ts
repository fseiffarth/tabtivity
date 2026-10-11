/**
 * The file viewer pulls in pdf.js, KaTeX, Mermaid, CodeMirror and the sheet
 * reader. Tests that `vi.resetModules()` and import it fresh pay that graph's
 * first transform inside whichever test runs first — tens of seconds when every
 * worker of a full run transforms at once on a loaded or small machine, so the
 * file's first test (whichever that is) times out while the rest pass.
 * Warming it in `beforeAll`, under its own generous budget, moves that cost out
 * of every test's timeout.
 */
import { beforeAll } from "vitest";

export function warmFileViewer(): void {
  beforeAll(async () => {
    await import("../../components/embed/FileViewerPane");
  }, 120_000);
}
