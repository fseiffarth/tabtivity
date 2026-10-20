/**
 * Undo/redo for the Reader composer's text (`ReaderComposer`). The browser's
 * own undo stack does not survive React setting the box's value — a recalled
 * prompt, a picked `/` command, a dropped file — so the composer keeps its
 * own: every change records the text it replaced, typing within
 * `TYPING_GROUP_MS` of the last keystroke folding into one step.
 */
export const TYPING_GROUP_MS = 1000;
const LIMIT = 200;

export class DraftUndo {
  private past: string[] = [];
  private future: string[] = [];
  private lastTyped = 0;

  /** `before` is being replaced; `typing` marks a keystroke the box made. */
  record(before: string, after: string, typing: boolean, now = Date.now()): void {
    if (before === after) return;
    if (!(typing && this.lastTyped > 0 && now - this.lastTyped < TYPING_GROUP_MS)) {
      this.past.push(before);
      if (this.past.length > LIMIT) this.past.shift();
    }
    this.lastTyped = typing ? now : 0;
    this.future = [];
  }

  /** The text to show instead of `current`, or null with nothing to undo. */
  undo(current: string): string | null {
    const text = this.past.pop();
    if (text === undefined) return null;
    this.future.push(current);
    this.lastTyped = 0;
    return text;
  }

  redo(current: string): string | null {
    const text = this.future.pop();
    if (text === undefined) return null;
    this.past.push(current);
    this.lastTyped = 0;
    return text;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  /** A sent prompt starts the box afresh. */
  clear(): void {
    this.past = [];
    this.future = [];
    this.lastTyped = 0;
  }
}

/** Where the caret goes once `from` became `to` by undo or redo: after the
 *  part that changed, as an editor puts it. */
export function caretAfterSwap(from: string, to: string): number {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (tail < from.length - head && tail < to.length - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;
  return to.length - tail;
}
