import type { Terminal } from "@xterm/xterm";

/**
 * Run `fn` `ms` after `term` parses a write, at most once per `ms`: the first
 * parsed write arms the timer and the writes after it ride on it, so a
 * streaming program costs one call per tick. Only parsed output counts — a
 * hidden pane parses nothing and catches up when shown. `dispose` drops the
 * subscription and a pending call.
 */
export function onParsedSettled(term: Terminal, fn: () => void, ms: number): { dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = term.onWriteParsed(() => {
    timer ??= setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  });
  return {
    dispose() {
      sub.dispose();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
