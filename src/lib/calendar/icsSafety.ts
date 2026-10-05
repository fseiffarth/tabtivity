/**
 * What is *in* an `.ics` file, asked before any of it is imported.
 *
 * Pure — it takes text and returns a report, touches nothing, and is the only
 * thing between "the user picked a file" and "the calendar changed".
 *
 * ## What this is, and what it is not
 *
 * It is **not** a malware scanner, and an `.ics` file cannot carry code that this
 * app would run: `lib/calendar/ics.ts` reads a fixed set of properties into plain data,
 * every text field goes through `stripFormatControls`, no calendar surface
 * renders HTML, and a link is only ever handed to the OS after `lib/calendar/conference.ts`
 * has refused everything that is not `http(s)`. Those defences are the reason a
 * hostile `.ics` is not an execution risk, and none of them is replaced here.
 *
 * What this *is* is the answer to a different question — **"what am I about to
 * put in my calendar?"** — which the defences above cannot answer because their
 * whole job is to be silent. A file that asks for a program to be run at an
 * alarm, that carries an attachment, that names a `zoommtg:` URL, or whose event
 * titles contain right-to-left overrides is a file worth looking at twice, and
 * every one of those is *dropped without a word* today. Reporting them is the
 * difference between "Tabtivity ignored it" and "you know it was there".
 *
 * ## The rule the findings follow
 *
 * Each finding says what is in the file and **what Tabtivity does about it**, and
 * the second half is the part that matters: a warning that does not say "this is
 * ignored" reads as "this will happen to you". The two categories are
 * deliberately distinguishable in the type — `ignored: true` is "present in the
 * file, discarded on import", `ignored: false` is "this reaches your calendar".
 */

import { parseLine, unfold } from "./ics";
import { hasFormatControls, stripFormatControls } from "../textSafety";

/** The things worth telling someone about before an import. */
export type IcsFindingKind =
  /** `ATTACH` — a file, or a URL to one, hanging off an event. */
  | "attachment"
  /** A `VALARM` whose `ACTION` is not `DISPLAY`: `PROCEDURE` (run a program),
   *  `EMAIL` (send mail), `AUDIO` (play a file, often a remote one). */
  | "active-alarm"
  /** A link whose scheme is not `http`/`https` anywhere a link is expected. */
  | "non-web-link"
  /** `METHOD:REQUEST`/`REPLY`/`CANCEL` — this is a meeting invitation, i.e. one
   *  side of a conversation, not a calendar to subscribe to. */
  | "invitation"
  /** Bidirectional or zero-width characters in a text field: the trick that
   *  makes one title read as another. */
  | "hidden-characters"
  /** A repeat rule with no end and a sub-daily frequency. */
  | "unbounded-repeat"
  /** Components this app does not import at all (`VJOURNAL`, `VFREEBUSY`, …). */
  | "unknown-component";

export interface IcsFinding {
  kind: IcsFindingKind;
  /** How many times it occurs. */
  count: number;
  /** One short, already-trimmed example, so the report can be specific without
   *  reprinting the file. Never longer than `SAMPLE_MAX`. */
  sample: string;
  /** Whether Tabtivity discards this on import. See the module note: a finding that
   *  does not say so reads as a threat rather than as a fact. */
  ignored: boolean;
}

export interface IcsReport {
  /** Components that would be imported. */
  events: number;
  tasks: number;
  /** Components the parser could not use — the same count `parseIcs` reports. */
  skipped: number;
  bytes: number;
  findings: IcsFinding[];
  /** Whether anything here is worth stopping for. Nothing = import quietly. */
  notable: boolean;
  /** The file does not look like iCalendar at all. Everything else is then
   *  meaningless, so this is checked first and reported on its own. */
  looksLikeIcs: boolean;
}

/** Longest example echoed back into the report. */
const SAMPLE_MAX = 80;

/**
 * Properties whose value is, or contains, a link.
 *
 * `ATTACH` is deliberately **not** here even though it is usually a URL: it has
 * its own finding, whose sample shows the value anyway, and listing it twice
 * would report one line as two problems. A report that inflates its own count is
 * a report that gets discounted.
 */
const LINK_PROPS = new Set(["URL", "CONFERENCE", "X-GOOGLE-CONFERENCE", "LOCATION"]);

/** Properties whose value is free text a person reads. */
const TEXT_PROPS = new Set(["SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT", "CATEGORIES"]);

/** Components this app knowingly does not import. */
const UNKNOWN_COMPONENTS = new Set(["VJOURNAL", "VFREEBUSY", "VAVAILABILITY"]);

function clip(value: string): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > SAMPLE_MAX ? `${one.slice(0, SAMPLE_MAX - 1)}…` : one;
}

/**
 * The scheme of a value that looks like a URI, lowercased — or `""`.
 *
 * Deliberately a narrow syntactic read rather than `new URL()`: a `LOCATION` is
 * usually a room name, and running every one of them through a URL parser to
 * find out would classify `"Room 3: Building B"` as scheme `room 3`. A scheme is
 * letters, digits, `+`, `-`, `.`, then a colon, and must start with a letter.
 */
export function uriScheme(value: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim());
  return match ? match[1].toLowerCase() : "";
}

/** Whether a scheme is one a calendar link may safely have. */
function webScheme(scheme: string): boolean {
  return scheme === "http" || scheme === "https";
}

/**
 * Read a file the way the importer will, and report what is in it.
 *
 * The counts come from a second, cheap pass over the same unfolded lines rather
 * than from `parseIcs`, so this stays independent of the parser's own
 * bookkeeping: the point of the report is to describe the *file*, including the
 * parts the parser drops on the floor.
 */
export function inspectIcs(text: string): IcsReport {
  const bytes = new TextEncoder().encode(text).length;
  const looksLikeIcs = /BEGIN:VCALENDAR/i.test(text);

  let events = 0;
  let tasks = 0;
  let skipped = 0;

  // kind → running tally + first example seen.
  const tally = new Map<IcsFindingKind, { count: number; sample: string }>();
  const note = (kind: IcsFindingKind, sample: string) => {
    const slot = tally.get(kind);
    if (slot) slot.count += 1;
    else tally.set(kind, { count: 1, sample: clip(sample) });
  };

  /** The component stack — an ALARM inside an EVENT is not a top-level thing. */
  const stack: string[] = [];
  /** Set while inside a VALARM, cleared at its END, so an ACTION is attributed
   *  to the alarm it belongs to and not to whatever follows. */
  let alarmAction = "";

  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    const name = line.name.toUpperCase();
    const value = line.value;

    if (name === "BEGIN") {
      const comp = value.toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT") events += 1;
      else if (comp === "VTODO") tasks += 1;
      else if (comp === "VALARM") alarmAction = "";
      else if (UNKNOWN_COMPONENTS.has(comp)) {
        skipped += 1;
        note("unknown-component", comp);
      }
      continue;
    }

    if (name === "END") {
      const comp = value.toUpperCase();
      // `DISPLAY` is the only action this app implements, and the only one it
      // would ever implement: the other three are "run a program", "send mail"
      // and "play a file", which is a calendar file asking for side effects.
      if (comp === "VALARM" && alarmAction && alarmAction !== "DISPLAY") {
        note("active-alarm", alarmAction);
      }
      stack.pop();
      continue;
    }

    if (name === "ACTION" && stack[stack.length - 1] === "VALARM") {
      alarmAction = value.trim().toUpperCase();
      continue;
    }

    // `METHOD` is a calendar-level property, so it is read wherever it appears
    // rather than only at the top — some producers emit it after the first
    // component.
    if (name === "METHOD") {
      const method = value.trim().toUpperCase();
      if (method && method !== "PUBLISH") note("invitation", method);
      continue;
    }

    if (name === "ATTACH") {
      note("attachment", value);
      continue;
    }

    if (LINK_PROPS.has(name)) {
      const scheme = uriScheme(value);
      // A `LOCATION` with no scheme at all is a room name, which is the normal
      // case and not a finding. Only something *shaped* like a link with a
      // scheme this app will not open is worth naming.
      if (scheme && !webScheme(scheme)) note("non-web-link", value);
    }

    // Reported against the *raw* value, and sampled with the controls removed —
    // printing the disguise back at the reader would make the report itself lie
    // in exactly the way the finding is about. `lib/textSafety.ts` owns the
    // character list; there is deliberately no second copy of it here.
    if (TEXT_PROPS.has(name) && hasFormatControls(value)) {
      note("hidden-characters", stripFormatControls(value));
    }

    if (name === "RRULE") {
      const upper = value.toUpperCase();
      const bounded = upper.includes("UNTIL=") || upper.includes("COUNT=");
      const subDaily = /FREQ=(SECONDLY|MINUTELY|HOURLY)/.test(upper);
      if (!bounded && subDaily) note("unbounded-repeat", value);
    }
  }

  // Which findings describe something Tabtivity *does* rather than something it
  // drops. Only two of the seven reach the calendar at all.
  const REACHES_THE_CALENDAR = new Set<IcsFindingKind>(["non-web-link", "unbounded-repeat"]);

  const findings: IcsFinding[] = [...tally.entries()].map(([kind, { count, sample }]) => ({
    kind,
    count,
    sample,
    ignored: !REACHES_THE_CALENDAR.has(kind),
  }));

  return {
    events,
    tasks,
    skipped,
    bytes,
    findings,
    notable: findings.length > 0 || !looksLikeIcs,
    looksLikeIcs,
  };
}
