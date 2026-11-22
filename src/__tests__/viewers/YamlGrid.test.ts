/**
 * The YAML card-view model (#yaml-grid) — the pure structure behind the drill.
 *
 * The load-bearing properties pinned here: cards are only offered for a file that
 * nests a collection (a flat config map has nothing to card); the drill's levels
 * follow the path to the focused card and fall back to the overview for a focus
 * the file no longer holds; and — because the cards are a view on the text like
 * the tree — every edit they delegate to `lib/viewers/yaml` leaves the file's
 * comments and untouched bytes intact.
 */
import { describe, it, expect } from "vitest";
import { parseYaml, setValue, addChild, deleteNode, childLiteral } from "../../lib/viewers/yaml";
import {
  buildIndex,
  buildLevels,
  docHasCards,
  isContainer,
  recordName,
  subcardsOf,
  topCards,
} from "../../lib/viewers/yamlGrid";

const LIST_OF_MAPS = `# services
- name: web
  port: 8080
  enabled: true
- name: db
  port: 5432
- name: cache
  port: 6379
  enabled: false
`;

const MAP_OF_MAPS = `hosts:
  alpha:
    ip: 10.0.0.1
    role: primary
  beta:
    ip: 10.0.0.2
    role: replica
`;

const FLAT_CONFIG = `name: my-app
version: 1.2.3
debug: false
port: 8080
`;

const hasCards = (text: string) => docHasCards(parseYaml(text));

describe("card view gate (docHasCards)", () => {
  it("shows cards when a collection nests another", () => {
    expect(hasCards(LIST_OF_MAPS)).toBe(true); // list of mappings
    expect(hasCards(MAP_OF_MAPS)).toBe(true); // map of mappings
    expect(hasCards("root:\n  child:\n    leaf: 1\n")).toBe(true); // deep nesting
  });

  it("hides cards for a wholly flat file", () => {
    expect(hasCards(FLAT_CONFIG)).toBe(false); // map of scalars
    expect(hasCards("- a\n- b\n- c\n")).toBe(false); // list of scalars
  });

  it("hides cards for an unparseable file", () => {
    expect(hasCards("\tbad: indent")).toBe(false);
  });

  it("isContainer distinguishes collections from scalars", () => {
    const doc = parseYaml(MAP_OF_MAPS);
    const hosts = doc.docs[0].children[0]; // hosts: {…}
    expect(isContainer(hosts)).toBe(true);
    const ip = hosts.children[0].children[0]; // alpha.ip
    expect(isContainer(ip)).toBe(false);
  });
});

describe("the drill", () => {
  it("tops a root list with a card per item, a root map with one card", () => {
    expect(topCards(parseYaml(LIST_OF_MAPS))).toHaveLength(3);
    const doc = parseYaml(MAP_OF_MAPS);
    expect(topCards(doc)).toEqual([doc.docs[0]]);
  });

  it("shows only the overview when nothing is focused", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const levels = buildLevels(doc, null, buildIndex(doc));
    expect(levels).toHaveLength(1);
    expect(levels[0].selected).toBeNull();
    // A lone root list is the top level's parent, so its cards reorder.
    expect(levels[0].parent).toBe(doc.docs[0]);
  });

  it("walks one level per step down to the focused card and shows its children", () => {
    const doc = parseYaml(MAP_OF_MAPS);
    const root = doc.docs[0];
    const hosts = root.children[0];
    const levels = buildLevels(doc, hosts.id, buildIndex(doc));
    // document → hosts → hosts' own children (alpha, beta), nothing highlighted.
    expect(levels.map((l) => l.selected?.id ?? null)).toEqual([root.id, hosts.id, null]);
    expect(levels[2].cards).toEqual(subcardsOf(hosts));
    expect(levels[2].parent).toBe(hosts);
    // A lone root map is not reorderable at the top.
    expect(levels[0].parent).toBeNull();
  });

  it("falls back to the overview for a focus the file no longer holds", () => {
    const doc = parseYaml(MAP_OF_MAPS);
    const levels = buildLevels(doc, "no-such-node", buildIndex(doc));
    expect(levels).toHaveLength(1);
    expect(levels[0].selected).toBeNull();
  });

  it("names a record by its first name-ish field", () => {
    const [web] = topCards(parseYaml(LIST_OF_MAPS));
    expect(recordName(web)).toBe("web");
    const anonymous = topCards(parseYaml("- port: 1\n  nested: {a: 1}\n"))[0];
    expect(recordName(anonymous)).toBeNull();
  });
});

describe("card edits are text splices (view on the text)", () => {
  it("edits a scalar field, keeping the file's comment and other bytes", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const port = topCards(doc)[0].children[1]; // web.port = 8080
    const next = setValue(LIST_OF_MAPS, doc, port, "9090");
    expect(next).toContain("port: 9090");
    expect(next).toContain("# services"); // the comment survives
    expect(next).toContain("name: db"); // untouched cards survive
    expect(next).not.toContain("port: 8080");
  });

  it("adds a field to one card's mapping only", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const db = topCards(doc)[1]; // no `enabled`
    const next = addChild(LIST_OF_MAPS, doc, db, "key", "enabled", childLiteral(doc, db, "text", "true"));
    const cards = topCards(parseYaml(next));
    expect(cards[1].children.map((c) => c.key)).toEqual(["name", "port", "enabled"]);
    // The picked type is the type the file gets: text `true` is written quoted.
    expect(cards[1].children[2].value).toBe("true");
    expect(next).toContain('enabled: "true"');
    // The other cards are unchanged.
    expect(cards[0].children).toHaveLength(3);
    expect(cards[2].children).toHaveLength(3);
  });

  it("deletes a whole card", () => {
    const doc = parseYaml(LIST_OF_MAPS);
    const next = deleteNode(LIST_OF_MAPS, topCards(doc)[1]); // drop `db`
    expect(topCards(parseYaml(next)).map(recordName)).toEqual(["web", "cache"]);
  });
});
