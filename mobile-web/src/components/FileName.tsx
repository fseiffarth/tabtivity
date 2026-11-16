import { Fragment } from "react";

/**
 * A file's name drawn to be read whole on a tile, not cut to one line: it
 * wraps where a reader would break it (a case change, after `_`, `-`, `.` or a
 * space), the extension dimmed after the stem. A name too long for the room
 * (`max` characters) loses the middle of its stem, never the extension or the
 * stem's last few characters — `report_v3.pdf` and `report_v4.pdf` stay apart.
 * The tile's CSS clamps the line count as well, so an unlucky narrow tile
 * still ends cleanly.
 */
export function FileName({ name, max, className }: { name: string; max: number; className?: string }) {
  const { stem, ext } = splitFileName(fitFileName(name, max));
  return <strong className={className ? `file-name ${className}` : "file-name"}>
    {nameBreaks(stem).map((part, index) => <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>)}
    {ext && <span className="file-name-ext">{ext}</span>}
  </strong>;
}

/**
 * The cover a file without a picture gets: its name, large enough to read,
 * filling the square a preview would take, and a chip with its type
 * (`TSX`, `MD`) — the one glyph the tile used to show told nothing apart.
 * `nameClass` goes on the name, so a tile's own name hook still finds it.
 */
export function FileNameCover({ name, className, nameClass }: { name: string; className?: string; nameClass?: string }) {
  const chip = fileTypeChip(name);
  return <span className={className ? `file-name-cover ${className}` : "file-name-cover"}>
    <FileName name={name} max={COVER_CHARS} className={nameClass} />
    {chip && <span className="file-name-chip" aria-hidden="true">{chip}</span>}
  </span>;
}

/** About five lines of a tile's cover at its narrowest. */
export const COVER_CHARS = 54;
/** About two lines under a picture or a PDF's cover. */
export const CAPTION_CHARS = 30;

/** `name` cut to `max` characters by taking out the middle of its stem: the
 * start, an ellipsis, the stem's last characters (a version or a number lives
 * there) and the whole extension. */
export function fitFileName(name: string, max: number): string {
  if (name.length <= max) return name;
  const { stem, ext } = splitFileName(name);
  const room = max - ext.length - 1;
  if (room < 4) return `${name.slice(0, Math.max(1, max - 1))}…`;
  const tail = Math.min(6, Math.floor(room / 3));
  return `${stem.slice(0, room - tail)}…${stem.slice(stem.length - tail)}${ext}`;
}

/** A name's stem and its last extension (with its dot). A dotfile
 * (`.gitignore`) or a name ending in a dot has no extension; neither has an
 * "extension" with a space in it or longer than 8 characters, which is more
 * likely a sentence than a type. */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: "" };
  const ext = name.slice(dot);
  if (ext.length > 9 || /\s/.test(ext)) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext };
}

/** The chip on a cover: the extension in capitals, short enough to sit in a
 * corner; none for a name without one. */
export function fileTypeChip(name: string): string {
  const { ext } = splitFileName(name);
  return ext.length >= 2 && ext.length <= 6 ? ext.slice(1).toUpperCase() : "";
}

/** `text` split where a line may break: before an upper-case letter that
 * follows a lower-case letter or a digit, and after `_`, `-`, `.`, `/` or a
 * space. Joined, the parts are `text` again. */
export function nameBreaks(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 1; index < text.length; index += 1) {
    const before = text[index - 1];
    const here = text[index];
    const caseBreak = /[A-Z]/.test(here) && /[a-z0-9]/.test(before);
    const afterMark = /[_\-./\s]/.test(before) && !/[_\-./\s]/.test(here);
    if (caseBreak || afterMark) {
      parts.push(text.slice(start, index));
      start = index;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
