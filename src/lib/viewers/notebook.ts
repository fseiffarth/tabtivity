/**
 * Pure, dependency-free parsing for the built-in Jupyter `.ipynb` viewer
 * (TODO Group K #40, new viewers). It turns an nbformat v4 notebook (JSON string
 * or already-parsed object) into a small, render-ready shape — a list of
 * markdown/code cells, code cells carrying classified output blocks.
 *
 * Scope is deliberately a focused nbformat v4 subset: enough to render a
 * notebook readably, not to round-trip it. Anything we don't understand is
 * skipped rather than guessed at.
 *
 * SECURITY: this module produces only plain strings and base64 blobs — never
 * HTML. The viewer is responsible for escaping/sanitizing before rendering.
 * Critically, notebook `text/html` outputs are NEVER surfaced here (they would
 * be attacker-controlled HTML); only `text/plain`, `image/png`, stream text, and
 * error tracebacks are emitted. Stream/error text is ANSI-stripped here so the
 * viewer's escaping isn't fed raw escape sequences.
 */

export interface NbCell {
  type: "markdown" | "code";
  source: string;
  /** Present (possibly empty) for code cells; absent for markdown cells. */
  outputs?: NbOutput[];
}

export interface NbOutput {
  kind: "text" | "image";
  /** Set for `kind: "text"` — already ANSI-stripped, NOT yet HTML-escaped. */
  text?: string;
  /** Set for `kind: "image"` — a base64 PNG payload, as stored in the notebook. */
  pngBase64?: string;
}

export interface ParsedNotebook {
  language: string;
  cells: NbCell[];
}

/**
 * Strip ANSI SGR / CSI escape sequences from `s`. nbformat stream and error
 * outputs commonly embed colour codes (`\x1b[0;31m`); we render them as plain
 * text, so the codes are noise. Covers CSI sequences (`\x1b[ ... <final>`),
 * which subsumes the common `\x1b[0;31m` colour form.
 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Join an nbformat `source`/`text` value, which is either a string or an array
 *  of line strings (each usually keeping its trailing newline), into one string. */
function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.map((s) => (typeof s === "string" ? s : "")).join("");
  return typeof src === "string" ? src : "";
}

/** A parsed JSON object whose fields are still unchecked. */
type JsonObject = Record<string, unknown>;

/** `v` as a JSON object, or `undefined` when it isn't one. */
function asObject(v: unknown): JsonObject | undefined {
  return v && typeof v === "object" ? (v as JsonObject) : undefined;
}

/**
 * Classify a single nbformat output object into zero or more render blocks:
 *  - `stream`        → one text block from `out.text` (ANSI-stripped).
 *  - `execute_result`/`display_data` → an `image/png` block if present, else a
 *    `text/plain` block. `text/html` is intentionally SKIPPED (untrusted HTML).
 *  - `error`         → one text block from the joined `out.traceback`
 *    (ANSI-stripped — tracebacks carry colour codes).
 *  - anything else   → no blocks.
 */
export function outputToBlocks(output: unknown): NbOutput[] {
  const out = asObject(output);
  if (!out) return [];
  switch (out.output_type) {
    case "stream":
      return [{ kind: "text", text: stripAnsi(joinSource(out.text)) }];
    case "execute_result":
    case "display_data": {
      const data = asObject(out.data) ?? {};
      const png = data["image/png"];
      if (typeof png === "string" && png) {
        // nbformat stores image/png base64 either as one string or split lines.
        return [{ kind: "image", pngBase64: png }];
      }
      if (Array.isArray(png) && png.length) {
        return [{ kind: "image", pngBase64: png.join("") }];
      }
      const plain = data["text/plain"];
      if (plain != null) {
        return [{ kind: "text", text: stripAnsi(joinSource(plain)) }];
      }
      // text/html (and other rich types) deliberately skipped.
      return [];
    }
    case "error":
      return [{ kind: "text", text: stripAnsi(joinSource(out.traceback)) }];
    default:
      return [];
  }
}

/**
 * Parse a notebook (JSON string or already-parsed object) into a
 * `ParsedNotebook`. Tolerant of a missing/odd shape: a parse failure or a
 * non-object yields an empty notebook rather than throwing.
 *
 *  - Cell `source` arrays are joined into a single string.
 *  - Kernel language comes from `metadata.kernelspec.language`, else
 *    `metadata.language_info.name`, defaulting to `"python"`.
 *  - `markdown`/`code` cells are kept; `raw` cells are rendered as markdown-typed
 *    plain text (their source carried through verbatim) so their content is not
 *    silently lost; all other cell types are dropped.
 */
export function parseNotebook(json: string | object): ParsedNotebook {
  let parsed: unknown;
  if (typeof json === "string") {
    try {
      parsed = JSON.parse(json);
    } catch {
      return { language: "python", cells: [] };
    }
  } else {
    parsed = json;
  }
  const nb = asObject(parsed);
  if (!nb) return { language: "python", cells: [] };

  const meta = asObject(nb.metadata) ?? {};
  const kernelLang = asObject(meta.kernelspec)?.language;
  const infoName = asObject(meta.language_info)?.name;
  const language =
    (typeof kernelLang === "string" && kernelLang) ||
    (typeof infoName === "string" && infoName) ||
    "python";

  const rawCells: unknown[] = Array.isArray(nb.cells) ? nb.cells : [];
  const cells: NbCell[] = [];
  for (const rawCell of rawCells) {
    const cell = asObject(rawCell);
    if (!cell) continue;
    const source = joinSource(cell.source);
    if (cell.cell_type === "code") {
      const rawOutputs: unknown[] = Array.isArray(cell.outputs) ? cell.outputs : [];
      const outputs = rawOutputs.flatMap(outputToBlocks);
      cells.push({ type: "code", source, outputs });
    } else if (cell.cell_type === "markdown") {
      cells.push({ type: "markdown", source });
    } else if (cell.cell_type === "raw") {
      // Surface raw cells as plain markdown text rather than dropping them; their
      // source is escaped by the markdown renderer downstream.
      cells.push({ type: "markdown", source });
    }
    // unknown cell types: dropped.
  }

  return { language, cells };
}
