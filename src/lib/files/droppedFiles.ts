import { basename, dirname, fromFileUri, resolvePath } from "../paths";

/**
 * Reading an OS file drop — which paths it carries. Shared by the file views' import
 * (`components/files/importDrop`) and the terminal's drop (`lib/terminal/terminalDrop`).
 */

/** Heuristic: is this drag an external OS file drag (vs. an internal pill/text
 *  drag)? `dragDropEnabled` stays false so HTML5 DnD keeps working for the
 *  app's pointer/HTML drags; an OS file drag advertises Files/uri-list/html
 *  (WebKitGTK uses text/html here). During dragover WebKit may hide the type
 *  list, so an empty list is treated as a file drag too. */
export function isExternalFileDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types ?? []);
  if (types.length === 0) return true;
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html")
  );
}

/** Extract absolute local paths from an OS HTML5 file drop. WebKitGTK withholds
 *  `Files`/`text/uri-list` data here but leaks the `file://` URL inside
 *  `text/html`, so scan every text payload for `file://` URIs and dedupe.
 *  Of a multi-file drop it leaks only the first file: `parseDroppedFiles`
 *  infers the rest. */
export function parseDroppedFilePaths(dataTransfer: DataTransfer): string[] {
  const sources = [
    dataTransfer.getData("text/uri-list"),
    dataTransfer.getData("text/plain"),
    dataTransfer.getData("text/html"),
  ];
  const FILE_URI = /file:\/\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of sources) {
    if (!raw) continue;
    for (const match of raw.match(FILE_URI) ?? []) {
      const p = fromFileUri(match);
      if (p && !seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

/** One file of an OS drop: its path, and — when the path was inferred rather
 *  than read off the drag — the size of the dropped `File`, for the backend to
 *  check the inferred path against before using it. */
export interface DroppedFile {
  path: string;
  size: number | null;
}

/** Every file of an OS drop. WebKitGTK leaks only the first file's path of a
 *  multi-file drop (`parseDroppedFilePaths`) but lists every file in
 *  `dataTransfer.files`, by name and size only; a file manager drags one
 *  folder's selection, so the rest are inferred as siblings of the first, in
 *  the order `files` lists them. A drop from several folders (search results)
 *  infers a wrong path for some, which the size check refuses. */
export function parseDroppedFiles(dataTransfer: DataTransfer): DroppedFile[] {
  const leaked = parseDroppedFilePaths(dataTransfer);
  const files = Array.from(dataTransfer.files ?? []);
  if (leaked.length === 0 || files.length <= leaked.length) return leaked.map((path) => ({ path, size: null }));
  const byName = new Map(leaked.map((path) => [basename(path), path]));
  const dir = dirname(leaked[0]);
  const seen = new Set<string>();
  const dropped: DroppedFile[] = [];
  for (const file of files) {
    const { name } = file;
    if (!name || name === "." || name === ".." || /[/\\]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const known = byName.get(name);
    dropped.push(known ? { path: known, size: null } : { path: resolvePath(dir, name), size: file.size });
  }
  for (const path of leaked) if (!seen.has(basename(path))) dropped.push({ path, size: null });
  return dropped;
}
