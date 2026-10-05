import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { useUse24h } from "../../lib/timeFormat";

/**
 * **The** clock-entry field — the one control in the app an hour is typed into,
 * drawn by Tabtivity rather than by the engine.
 *
 * It exists because `<input type="time">` cannot be told which clock to show.
 * The segments it renders come from a locale: WebKitGTK takes that from the
 * **process** locale and ignores the element's `lang` outright, and Chromium
 * follows the browser's UI locale, which app code cannot reach either. So
 * `Settings.time_format_24h` moved every clock Tabtivity prints and left the field
 * behind — a card due at 17:00 read `17:00` on the board and `5:30 PM` the
 * moment it was opened for editing, which is the exact disagreement that
 * setting exists to end.
 *
 * What it is **not** is a text box: a free-text field takes "soonish" as
 * happily as it takes an hour, and a deadline is not a place for a string
 * somebody has to be told is wrong afterwards. So this keeps the native
 * widget's shape — two numeric segments plus, on a 12-hour clock, an AM/PM
 * toggle — and its habits: digits only, two digits or an unambiguous first one
 * advances to the minute, ↑/↓ spin the focused segment (and flip AM/PM),
 * ←/→ walk between them, Backspace clears one. The value on the wire is still
 * `"HH:MM"` (or `""`), i.e. exactly what the native input handed its callers.
 *
 * Everything it accepts is a valid clock **by construction** — the segments
 * cannot hold anything else — so there is no parse to fail and nothing to snap
 * back from. A half-filled field is simply not committed: `""` (both segments
 * empty) is the only other value it ever reports, because a due date with no
 * hour is the ordinary case.
 */
interface Props {
  /** The stored clock, `"HH:MM"`, or `""` for none. */
  value: string;
  /** Called with a new `"HH:MM"`, or `""` when the field is cleared. */
  onChange: (hhmm: string) => void;
  /** The caller's box class — this renders as one field, so it wears it. */
  className?: string;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  /** The host's own key handling — every dialog here stops its own Escape. */
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}

/** The three parts as they are *shown*: the stored 24-hour clock is derived. */
interface Segments {
  hour: string;
  minute: string;
  pm: boolean;
}

const EMPTY: Segments = { hour: "", minute: "", pm: false };

/** `"17:30"` → the segments a 12- or 24-hour face shows for it. */
function toSegments(value: string, use24h: boolean): Segments {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return EMPTY;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return EMPTY;
  return {
    hour: use24h ? String(h).padStart(2, "0") : String(h % 12 === 0 ? 12 : h % 12),
    minute: m[2],
    pm: h >= 12,
  };
}

/**
 * The segments back to the stored clock — `""` while the field is empty, and
 * `null` while it is half-filled, which is what "do not commit yet" looks like.
 */
function toValue(seg: Segments, use24h: boolean): string | null {
  if (!seg.hour && !seg.minute) return "";
  if (!seg.hour || !seg.minute) return null;
  let h = Number(seg.hour);
  const min = Number(seg.minute);
  if (!use24h) h = (h % 12) + (seg.pm ? 12 : 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The hour a face can show: 0–23 on a 24-hour clock, 1–12 on a 12-hour one. */
function hourRange(use24h: boolean): [number, number] {
  return use24h ? [0, 23] : [1, 12];
}

function wrap(n: number, lo: number, hi: number): number {
  const span = hi - lo + 1;
  return lo + (((n - lo) % span) + span) % span;
}

export function TimeField({
  value,
  onChange,
  className,
  disabled,
  title,
  "aria-label": ariaLabel,
  onKeyDown,
}: Props) {
  const use24h = useUse24h();
  const [seg, setSeg] = useState<Segments>(() => toSegments(value, use24h));
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // The stored value is the truth whenever the user is not mid-edit. Re-reading
  // it while a segment has focus would rewrite "1" to "01" between the two
  // keystrokes of "17", which is the one thing a segmented field must not do.
  useEffect(() => {
    if (boxRef.current?.contains(document.activeElement)) return;
    setSeg(toSegments(value, use24h));
  }, [value, use24h]);

  const apply = (next: Segments) => {
    setSeg(next);
    const v = toValue(next, use24h);
    if (v !== null && v !== value) onChange(v);
  };

  const [hourLo, hourHi] = hourRange(use24h);

  const typeDigits = (part: "hour" | "minute", raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(-2);
    if (!digits) {
      apply({ ...seg, [part]: "" });
      return;
    }
    const n = Number(digits);
    const hi = part === "hour" ? hourHi : 59;
    // A second digit that would overshoot is read as a fresh first one, the way
    // the native widget does: 1 then 9 on a 12-hour face is 9, not 19.
    const kept = n > hi ? digits.slice(-1) : digits;
    const next = { ...seg, [part]: kept };
    apply(next);
    // Advance once the hour cannot take another digit — two digits, or a first
    // one too large to be the start of a two-digit hour. `focus()`, never
    // `select()`: selecting text does NOT move focus (the spec says so and both
    // engines agree), so the minute's digits went on landing in the hour, where
    // "1730" reads as 17, then 73 → 3, then 30 → 0. The segment is selected by
    // the focus handler once focus is actually there.
    if (part === "hour" && (kept.length === 2 || Number(kept) * 10 > hourHi)) {
      minuteRef.current?.focus();
    }
  };

  const step = (part: "hour" | "minute", delta: number) => {
    if (part === "hour") {
      const base = seg.hour === "" ? hourLo : Number(seg.hour);
      const h = wrap(base + delta, hourLo, hourHi);
      apply({ ...seg, hour: use24h ? String(h).padStart(2, "0") : String(h) });
    } else {
      const base = seg.minute === "" ? 0 : Number(seg.minute);
      const m = wrap(base + delta, 0, 59);
      apply({ ...seg, minute: String(m).padStart(2, "0") });
    }
  };

  const segKeyDown = (part: "hour" | "minute") => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      step(part, e.key === "ArrowUp" ? 1 : -1);
    } else if (e.key === "ArrowRight" && part === "hour") {
      e.preventDefault();
      minuteRef.current?.focus();
    } else if (e.key === "ArrowLeft" && part === "minute") {
      e.preventDefault();
      hourRef.current?.focus();
    } else if ((e.key === ":" || e.key === ".") && part === "hour") {
      e.preventDefault();
      minuteRef.current?.focus();
    } else if (e.key === "Backspace" && part === "minute" && seg.minute === "") {
      // Backspacing past the start of the minute walks back into the hour,
      // rather than sitting in a segment there is nothing left to delete from.
      e.preventDefault();
      hourRef.current?.focus();
    } else if (!use24h && (e.key === "a" || e.key === "p")) {
      e.preventDefault();
      apply({ ...seg, pm: e.key === "p" });
    }
    onKeyDown?.(e);
  };

  // Leaving the field is where a lone segment is settled: an hour typed with no
  // minute means the top of that hour, which is what the native widget's own
  // blur does, and it is the reading anybody typing "17" and tabbing away meant.
  const onBlurBox = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (seg.hour && !seg.minute) apply({ ...seg, minute: "00" });
    else if (!seg.hour && seg.minute) apply({ ...seg, hour: use24h ? "00" : "12" });
    else setSeg(toSegments(toValue(seg, use24h) ?? value, use24h));
  };

  const segProps = {
    type: "text" as const,
    inputMode: "numeric" as const,
    autoComplete: "off",
    spellCheck: false,
    disabled,
    className: "time-field-seg",
    // What the native widget showed for an unset time. An empty box with a
    // colon beside it does not read as a clock waiting to be filled in.
    placeholder: "--",
    // Click-to-select, so typing replaces the segment the way the native one does.
    onFocus: (e: FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
  };

  return (
    <div
      ref={boxRef}
      className={`time-field${className ? ` ${className}` : ""}${disabled ? " is-disabled" : ""}`}
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      title={title}
      onBlur={onBlurBox}
      // The box is one field: clicking its padding lands on the hour, not nowhere.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !disabled) {
          e.preventDefault();
          hourRef.current?.focus();
        }
      }}
    >
      <input
        {...segProps}
        ref={hourRef}
        value={seg.hour}
        aria-label={ariaLabel ? `${ariaLabel} (h)` : "hour"}
        onChange={(e) => typeDigits("hour", e.target.value)}
        onKeyDown={segKeyDown("hour")}
      />
      <span className="time-field-sep">:</span>
      <input
        {...segProps}
        ref={minuteRef}
        value={seg.minute}
        aria-label={ariaLabel ? `${ariaLabel} (min)` : "minute"}
        onChange={(e) => typeDigits("minute", e.target.value)}
        onKeyDown={segKeyDown("minute")}
      />
      {!use24h ? (
        <button
          type="button"
          className="time-field-mer"
          disabled={disabled}
          onClick={() => apply({ ...seg, pm: !seg.pm })}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              apply({ ...seg, pm: !seg.pm });
            } else if (e.key === "a" || e.key === "p") {
              e.preventDefault();
              apply({ ...seg, pm: e.key === "p" });
            }
            onKeyDown?.(e);
          }}
        >
          {seg.pm ? "PM" : "AM"}
        </button>
      ) : null}
    </div>
  );
}
