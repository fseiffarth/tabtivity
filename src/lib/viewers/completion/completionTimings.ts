import { METRIC } from "../../usageMetrics";
import type { CompletionProviderId, CompletionStats } from "./completionProvider";

/** One completion request's milestones, in `performance.now()` milliseconds.
 * The dev perf monitor reads the ring; nothing is persisted. */
export type CompletionTiming = {
  /** Wall clock at the request, for display. */
  at: number;
  provider: CompletionProviderId;
  trigger: "auto" | "manual";
  /** The editor's last change before the request, when there was one. */
  keystroke?: number;
  request: number;
  /** Model lookup, references and reservation all in hand. */
  contextReady?: number;
  /** The first streamed text (or the cached/whole answer). */
  firstEvent?: number;
  done?: number;
  /** The model that answered, `none` when no model was chosen. */
  model?: string;
  cached?: boolean;
  outcome?: "ok" | "empty" | "error" | "cache" | "cancelled";
  /** The backend's `text-completion-stats-<id>` payload, when one arrived. */
  stats?: CompletionStats;
};

export const COMPLETION_TIMINGS_CAP = 200;
const ring: CompletionTiming[] = [];

/** Open a record for a request; the caller and the provider fill it in. */
export function startCompletionTiming(
  provider: CompletionProviderId, trigger: "auto" | "manual", keystroke?: number,
): CompletionTiming {
  const timing: CompletionTiming = { at: Date.now(), provider, trigger, keystroke, request: performance.now() };
  ring.push(timing);
  if (ring.length > COMPLETION_TIMINGS_CAP) ring.splice(0, ring.length - COMPLETION_TIMINGS_CAP);
  return timing;
}

/** The newest requests last. A live reference: read it, do not mutate it. */
export function completionTimings(): readonly CompletionTiming[] {
  return ring;
}

export function clearCompletionTimings() {
  ring.length = 0;
}

/** A ghost counts as shown once it was visible this long, or taken. */
export const SHOWN_MS = 750;
/** Typed characters of a ghost that count as taking it. */
const TYPED_CHARS = 3;
export type CompletionTake = "tab" | "word" | "line" | "typed";
const TAKE_METRIC: Record<CompletionTake, string> = {
  tab: METRIC.AUTOCOMPLETE_TAB,
  word: METRIC.AUTOCOMPLETE_WORD,
  line: METRIC.AUTOCOMPLETE_LINE,
  typed: METRIC.AUTOCOMPLETE_TYPED,
};

/** One editor's current offer — the candidate on screen — and what became of
 * it, counted as `autocomplete.<event>.<mode>.<provider>/<model>`: `shown`
 * once (visible `SHOWN_MS` or taken), each way of taking it at most once per
 * offer, and `rejected` when it ended after `SHOWN_MS` with nothing taken. A
 * stream's updates and a partly taken ghost stay the same offer. */
export class CompletionOffers {
  private offer: {
    id: string; suffix: string; since: number; shown: boolean; typed: number; taken: Set<CompletionTake>;
  } | null = null;

  constructor(private bump: (key: string) => void, private now: () => number = () => performance.now()) {}

  /** A candidate became visible. The same candidate again is a no-op. */
  start(id: string, mode: string, identity: string) {
    if (this.offer?.id === id) return;
    this.end();
    this.offer = { id, suffix: `${mode}.${identity}`, since: this.now(), shown: false, typed: 0, taken: new Set() };
  }

  /** Part or all of the ghost entered the document by a key. */
  take(kind: CompletionTake) {
    const offer = this.offer;
    if (!offer) return;
    this.markShown();
    if (offer.taken.has(kind)) return;
    offer.taken.add(kind);
    this.bump(`${TAKE_METRIC[kind]}.${offer.suffix}`);
  }

  /** The user typed `count` characters the ghost predicted. */
  typed(count: number) {
    const offer = this.offer;
    if (!offer) return;
    offer.typed += count;
    if (offer.typed >= TYPED_CHARS) this.take("typed");
  }

  /** The ghost is gone: dismissed, replaced, consumed or invalidated. */
  end() {
    const offer = this.offer;
    if (!offer) return;
    const visible = this.now() - offer.since >= SHOWN_MS;
    if (visible) this.markShown();
    if (visible && offer.taken.size === 0) this.bump(`${METRIC.AUTOCOMPLETE_REJECTED}.${offer.suffix}`);
    this.offer = null;
  }

  private markShown() {
    const offer = this.offer;
    if (!offer || offer.shown) return;
    offer.shown = true;
    this.bump(`${METRIC.AUTOCOMPLETE_SHOWN}.${offer.suffix}`);
  }
}
