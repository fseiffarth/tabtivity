import { useEffect, useMemo, useState } from "react";

import { LEGACY_NAMES, NAMES } from "../../../src/lib/brand";
import { describeInbox, type OutboxFile } from "../api";

/**
 * The files the phone sent into a tab's project inbox, read back out of the
 * `@` references that carry them (`@.tabtivity/inbox/<leaf>`, which the
 * desktop handed the phone when the file landed — the phone never composes
 * one). A message shows them as pictures rather than as references: the
 * composer as thumbnails beside the draft, the chat inside the prompt's
 * bubble. An older build's reference under the app's former folder name
 * reads the same — the project folder moved and kept its leaves.
 *
 * A reference stands as a whole word: an `@` at the start or after a space,
 * the inbox folder, a leaf of the inbox's own alphabet (`inbox::safe_name`).
 * A dot closing a sentence after it is not part of the leaf.
 */

const PREFIXES = [...new Set([NAMES.inboxDir, LEGACY_NAMES.inboxDir])].map((dir) => dir.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"));
const REFERENCE = new RegExp(`(^|\\s)@(?:${PREFIXES.join("|")})/([\\p{L}\\p{N}._-]+)`, "gu");

/** The leaf a matched reference names, without a sentence's closing dots. */
function leafOf(raw: string): string {
  return raw.replace(/\.+$/u, "");
}

/** The inbox leaves `text` refers to, first mention first, each once. */
export function inboxLeaves(text: string): string[] {
  const leaves = new Set<string>();
  for (const match of text.matchAll(REFERENCE)) {
    const leaf = leafOf(match[2]);
    if (leaf) leaves.add(leaf);
  }
  return [...leaves];
}

/** `text` with every inbox reference taken out and the gaps they leave
 * closed — what a message reads as once its files show as pictures. A
 * reference inside a sentence ("Page 2: @…") leaves the sentence. */
export function withoutInboxReferences(text: string): string {
  return text
    .replace(REFERENCE, (_match, lead: string, raw: string) => `${lead}${raw.slice(leafOf(raw).length)}`)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** What the desktop said about one leaf: the file, or `null` — asked, and the
 * inbox does not hold it (deleted, or never a file the phone may read). */
type Described = OutboxFile | null;
/** Per tab and leaf, for every screen at once: a leaf is asked about once. */
const described = new Map<string, Described>();
const keyOf = (tabId: string, leaf: string) => `${tabId}\u0000${leaf}`;
/** A chat's worth per request (the desktop's `inbox::MAX_DESCRIBED`). */
const BATCH = 64;

/** What is known about `leaves` of `tabId`'s inbox so far: a leaf not yet
 * answered for is absent. */
function knownFor(tabId: string, leaves: readonly string[]): Map<string, Described> {
  const known = new Map<string, Described>();
  for (const leaf of leaves) {
    const entry = described.get(keyOf(tabId, leaf));
    if (entry !== undefined) known.set(leaf, entry);
  }
  return known;
}

/** The files `leaves` name in `tabId`'s project inbox, as the desktop typed
 * them; asks for the leaves not known yet, once, and answers again when they
 * arrive. A failed ask is asked again when the leaves change. */
export function useInboxFiles(tabId: string, leaves: readonly string[]): ReadonlyMap<string, Described> {
  const wanted = leaves.join("\n");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const missing = wanted ? wanted.split("\n").filter((leaf) => !described.has(keyOf(tabId, leaf))) : [];
    if (missing.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      for (let start = 0; start < missing.length; start += BATCH) {
        const batch = missing.slice(start, start + BATCH);
        let files: OutboxFile[];
        try {
          files = await describeInbox(tabId, batch, controller.signal);
        } catch {
          return;
        }
        const found = new Map(files.map((file) => [file.name, file]));
        for (const leaf of batch) described.set(keyOf(tabId, leaf), found.get(leaf) ?? null);
        if (!controller.signal.aborted) setVersion((version) => version + 1);
      }
    })();
    return () => controller.abort();
  }, [tabId, wanted]);
  // `version` moves when this hook's own ask lands; a leaf another screen
  // already asked about is in the cache by the time this one first reads.
  return useMemo(() => {
    void version; // The cache is outside React: a landed ask is what re-reads it.
    return knownFor(tabId, wanted ? wanted.split("\n") : []);
  }, [tabId, wanted, version]);
}

/** Test seam: forget what was described. */
export function resetInboxFiles() {
  described.clear();
}
