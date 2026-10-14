import { useEffect, useState } from "react";

/** About how long a full line takes to type, whatever its length. */
const TARGET_MS = 2400;
const MIN_STEP_MS = 16;
const MAX_STEP_MS = 45;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/**
 * A line of text that types itself out, with a blinking caret — the app
 * "speaking", the way an agent's reply streams in. Used for the first-run
 * greeting (HowToStart) and the daily welcome-back line (StatsRecap).
 *
 * Never in the way: the whole line takes ~2.4 s, a click or any key shows it at
 * once, `prefers-reduced-motion` (or `animate={false}`) shows it complete, and
 * screen readers get the full text in one piece — the typed copy is
 * `aria-hidden`. If `text` changes after it finished (a late dictionary), the
 * new text shows complete rather than typing again.
 */
export function Typewriter({
  text,
  animate = true,
  className,
}: {
  text: string;
  animate?: boolean;
  className?: string;
}) {
  const chars = Array.from(text);
  const [count, setCount] = useState(() => (animate && !prefersReducedMotion() ? 0 : Infinity));
  const done = count >= chars.length;
  const length = chars.length;
  const finish = () => setCount(Infinity);

  useEffect(() => {
    if (done) return;
    const step = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, TARGET_MS / Math.max(1, length)));
    const timer = window.setInterval(() => {
      setCount((c) => (c + 1 >= length ? Infinity : c + 1));
    }, step);
    const onKey = () => setCount(Infinity);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [done, length]);

  return (
    <p className={`typewriter${done ? " done" : ""}${className ? ` ${className}` : ""}`} onClick={finish}>
      <span className="typewriter-sr">{text}</span>
      <span aria-hidden="true">
        {done ? text : chars.slice(0, count).join("")}
        <span className="typewriter-caret" />
      </span>
    </p>
  );
}
