/**
 * Tags on collected prompts, and the tag-aware text match the sent-prompt chart uses.
 *
 * A collected prompt is text kept to be sent again; with a few dozen of them
 * the list is a library, and a library is found by what a thing is FOR, not
 * only by its words. Tags are short lowercase tokens (`refactor`, `tests`,
 * `paper`) typed as one comma- or space-separated line; the same normalization
 * runs on both sides (`services::agent_prompts::normalize_tag`), so what the
 * editor shows is what the file stores.
 *
 * Pure: the view holds the filter state and this decides what it means.
 */

/** Mirrors the backend's caps: 16 tags per prompt, and a tag is a token. */
export const MAX_TAGS = 16;
export const MAX_TAG_LENGTH = 32;

/**
 * One tag as it is stored: trimmed, without a leading `#`, lowercase, inner
 * whitespace folded to `-` so a tag is always one token, cut at the length cap.
 * Empty means "no tag".
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * The tags typed into one field. Commas and newlines separate, as the field
 * says; a space inside a piece folds to a hyphen (`related work` is one tag,
 * `related-work`), except before a `#`, because `#refactor #tests` is how
 * people type tags too. Duplicates collapse, order is kept, and the list stops
 * at the cap.
 */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]+|\s+(?=#)/)) {
    const tag = normalizeTag(raw);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The editor's line for a stored list. */
export function formatTags(tags: string[] | undefined): string {
  return (tags ?? []).join(", ");
}

/** Every tag in use, most used first, then alphabetical — the chips a library
 *  offers to narrow by. */
export function tagCounts(items: { tags?: string[] }[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Whether an item carrying `tags` matches a needle, tag-only when it starts
 *  with `#`. Shared with the sent list's text facet. */
export function matchesTagsOrText(
  tags: string[] | undefined,
  haystack: string,
  needle: string,
): boolean {
  const lowered = needle.toLowerCase();
  if (lowered.startsWith("#")) {
    const tag = lowered.slice(1);
    return tag === "" || (tags ?? []).some((entry) => entry.includes(tag));
  }
  return haystack.toLowerCase().includes(lowered) || (tags ?? []).some((entry) => entry.includes(lowered));
}
