/**
 * Meta Muse Code's frame, for a tab whose label names it.
 *
 * Under its `❯` box Muse draws one row, in two shapes (1.3.0 and 1.4.15,
 * offline echo and stub providers; the rows are the readable screen's, after
 * the box's rules are gone):
 *
 *   `  stub · high · ~/work · Auto-review`   model · reasoning effort · working
 *                                            directory · permission profile
 *   `  echo · ~/work`                        the effort and the profile are
 *                                            left out when the session has none
 *
 * and, while the session has a notice to show, the notice takes the place of
 * the directory and the profile, after the model (1.4.15):
 *
 *   `  stub The Linux sandbox uses Bubblewrap and needs … · system SSH …`
 *
 * 1.3.0 drew the notice at the right end of the normal row instead, after a
 * gap. Either way the notice is not a status fact: its words (`system SSH
 * configuration project…`) carry paths and branches of their own in other
 * sessions, so a notice row yields at most the model it opens with, and a
 * segment cut short by the pane's edge (`…`) yields nothing — half a path is
 * not a path. The row has no branch, no mode key the phone could press and no
 * context figure on any captured frame, so none of those is read.
 *
 * Why not the generic reader: it took the slash menu's `/model  Choose model`
 * row (drawn between the box and the footer) for the working directory, read
 * the notice row as nothing, and had no word for the permission profile.
 */

import type { SessionStatus } from "./statusLine";

interface MuseLineLike { text: string }

const AGENT = /\bmuse\b/iu;

export function isMuseTab(agentLabel?: string): boolean {
  return agentLabel !== undefined && AGENT.test(agentLabel);
}

/** The reasoning tiers Muse's binary names (`reasoning_effort`). */
const EFFORT = /^(?:minimal|low|medium|high|xhigh|max)$/iu;

/** The four permission profiles the binary lists (`:read-only`, `:ask-me`,
 * `:auto-review`, `:unrestricted`), as the footer prints their labels. */
const PROFILES: Record<string, string> = {
  "read only": "read only",
  "ask me": "ask me",
  "auto-review": "auto-review",
  unrestricted: "unrestricted",
};

/** A segment that is nothing but a working directory. */
const PATH = /^(~(?:\/\S*)?|\/\S+|[A-Za-z]:\\\S+)$/u;

/** A model name opening a notice row: one lowercase-led token and a single
 * space, with the notice's own capital after it. */
const MODEL_THEN_NOTICE = /^([a-z0-9][\w.:/-]*) (?=[A-Z])/u;

/** How Muse opens an answer, a thinking row and the detail under it. */
const OUTPUT_ROW = /^\s*[◆◇└]/u;

/** The facts the footer row `text` draws, or `null` when the row is not one
 * (empty). An empty object is a footer with nothing readable in it. */
export function museFooter(text: string): SessionStatus | null {
  const row = text.trim();
  if (!row) return null;
  // 1.3.0's notice sits at the right end of the row, after a gap.
  const segments = row.split(/\s{2,}/u)[0].split(" · ").map((segment) => segment.trim());
  const status: SessionStatus = {};
  const [first, ...rest] = segments;
  if (/^\S+$/u.test(first)) {
    status.model = first;
  } else {
    const notice = MODEL_THEN_NOTICE.exec(first);
    if (notice) status.model = notice[1];
    return status;
  }
  for (const segment of rest) {
    if (!segment || segment.endsWith("…")) continue;
    if (!status.effort && EFFORT.test(segment)) status.effort = segment.toLowerCase();
    else if (!status.mode && PROFILES[segment.toLowerCase()]) status.mode = PROFILES[segment.toLowerCase()];
    else if (!status.path && PATH.test(segment)) status.path = segment;
  }
  return status;
}

/** The status of the Muse frame at the bottom of `lines`: the footer is the
 * last row, and it is one only under an input line (`❯`) a few rows up — the
 * box, or the slash menu's rows between it and the footer. `null` otherwise,
 * which leaves the generic reader to the screen. */
export function museStatus(lines: readonly MuseLineLike[], reach: number): SessionStatus | null {
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].text.trim()) index -= 1;
  if (index < 1) return null;
  const footer = museFooter(lines[index].text);
  if (!footer) return null;
  let seen = 0;
  for (let row = index - 1; row >= 0 && seen < reach; row -= 1) {
    if (!lines[row].text.trim()) continue;
    seen += 1;
    if (/^\s*❯(\s|$)/u.test(lines[row].text)) return footer;
    // Output between the last prompt and a final row is a screen without a
    // box (`EXITED 0` under a `◆` answer), not a footer.
    if (OUTPUT_ROW.test(lines[row].text)) return null;
  }
  return null;
}
