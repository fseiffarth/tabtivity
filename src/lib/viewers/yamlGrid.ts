/**
 * The YAML/JSON **card view** model (#yaml-grid) — the pure half of the third view
 * on the text the tree and Source share (the RENDER lives in
 * `components/embed/YamlGrid`).
 *
 * The view is a **drill navigation**: one card is the "main" one, and the view
 * shows the path down to it as a stack of levels — each level a grid of sibling
 * cards with the one on the path highlighted, the last level the main card's own
 * children. A card is a mapping or sequence; its scalars are the fields ON it,
 * its nested collections the next level. This file answers the structural
 * questions that drill asks: is there anything to card at all ({@link docHasCards}),
 * what are the top cards, which levels lead to the focus ({@link buildLevels}),
 * and what names a record ({@link recordName}).
 *
 * Like the tree, the cards are a VIEW ON THE TEXT, not a model of it: every EDIT
 * is delegated to `lib/viewers/yaml`'s splice ops (`setValue`, `addChild`,
 * `deleteNode`, `moveNodeTo`), so a card edit keeps comments, quoting and
 * untouched bytes exactly as the tree's does. Two views, one text.
 *
 * Pure: no React, no Tauri, no fs, no display strings. Unit-tested in
 * `src/__tests__/viewers/YamlGrid.test.ts`.
 */

import type { YamlDoc, YamlNode } from "./yaml";

/** True when `node` is a mapping or sequence — i.e. it renders as a card, not a
 *  scalar field. */
export function isContainer(node: YamlNode): boolean {
  return node.kind === "map" || node.kind === "seq";
}

/** Whether the card view has anything worth showing over the plain tree: at least
 *  one collection nested inside another (a map/seq as a child of the root or deeper).
 *  A wholly flat file (a map of scalars, or a list of scalars) has no subcards, so
 *  the Cards toggle stays hidden and the tree/Source carry it. Takes the PARSED
 *  document, so the host asks this of the same parse the views render. */
export function docHasCards(doc: YamlDoc): boolean {
  if (doc.error) return false;
  const nests = (node: YamlNode): boolean =>
    node.children.some((c) => isContainer(c) || nests(c));
  return doc.docs.some(nests);
}

/** The document's top-level cards: a root map is one `document` card; a root list
 *  is a card per item; multiple documents flatten into one top row. */
export function topCards(doc: YamlDoc): YamlNode[] {
  return doc.docs.flatMap((root) => (root.kind === "seq" ? root.children : [root]));
}

/** A card's children that are themselves cards — its nested collections. Scalars
 *  are fields shown ON the card, not cards in the next level. */
export function subcardsOf(node: YamlNode): YamlNode[] {
  return node.children.filter(isContainer);
}

/** id → {node, parent} for a whole document, so a card's ancestors and siblings
 *  are a lookup away without threading parents through the render. */
export type NodeIndex = Map<string, { node: YamlNode; parent: YamlNode | null }>;

export function buildIndex(doc: YamlDoc): NodeIndex {
  const m: NodeIndex = new Map();
  const walk = (node: YamlNode, parent: YamlNode | null) => {
    m.set(node.id, { node, parent });
    for (const c of node.children) walk(c, node);
  };
  for (const r of doc.docs) walk(r, null);
  return m;
}

/** Whether `ancestorId` is a (strict) ancestor of `targetId` in the doc tree. */
function isAncestorOf(ancestorId: string, targetId: string, index: NodeIndex): boolean {
  let cur = index.get(targetId)?.parent ?? null;
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = index.get(cur.id)?.parent ?? null;
  }
  return false;
}

/** One rendered level: the cards shown, their common parent (whose child list a
 *  reorder addresses; `null` = not reorderable, e.g. a lone root map), and which
 *  card is on the path to the focus (highlighted as the "main" card). */
export interface Level {
  cards: YamlNode[];
  parent: YamlNode | null;
  selected: YamlNode | null;
}

/** Walk the drill from the top row down to the focused card, one level per step:
 *  each level highlights the card on the path, and the next level is that card's
 *  children — ending with the focused card's own children (nothing highlighted).
 *  A `focusId` the document no longer holds yields the top overview alone. */
export function buildLevels(doc: YamlDoc, focusId: string | null, index: NodeIndex): Level[] {
  const levels: Level[] = [];
  let cards = topCards(doc);
  // The single root seq is the top level's parent (so its cards reorder); a single
  // root map has no reorderable siblings at the top (its ONE card is `document`).
  let parent = doc.docs.length === 1 && doc.docs[0].kind === "seq" ? doc.docs[0] : null;
  // Guard against a pathological cycle (ids are unique, but be safe).
  for (let guard = 0; guard < 64; guard++) {
    const selected = focusId
      ? cards.find((c) => c.id === focusId || isAncestorOf(c.id, focusId, index)) ?? null
      : null;
    levels.push({ cards, parent, selected });
    if (!selected) break;
    const kids = subcardsOf(selected);
    if (selected.id === focusId) {
      if (kids.length) levels.push({ cards: kids, parent: selected, selected: null });
      break;
    }
    if (!kids.length) break;
    cards = kids;
    parent = selected;
  }
  return levels;
}

/** Keys that name a record, tried in order to title a list item's card. */
const TITLE_KEYS = ["name", "id", "title", "label", "key", "host", "type", "kind"];

/** What a record calls itself: a mapping's first non-empty name-ish field, or
 *  `null` when it has none (the view then falls back to its position). */
export function recordName(node: YamlNode): string | null {
  if (node.kind !== "map") return null;
  for (const k of TITLE_KEYS) {
    const field = node.children.find(
      (c) => c.key === k && c.kind === "scalar" && c.value.trim() !== "",
    );
    if (field) return field.value;
  }
  return null;
}
