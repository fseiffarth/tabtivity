import { describe, it, expect } from "vitest";
import {
  parseYaml,
  setValue as setValueRaw,
  renameKey as renameKeyRaw,
  deleteNode,
  addChild,
  addRootEntry,
  duplicateNode,
  moveNode,
  moveNodeTo,
  setComment,
  commentOf,
  canComment,
  canAddChild,
  canPasteAfter,
  copyNode,
  pasteAfter,
  isEmptyPlaceholder,
  isFlow,
  literalFor,
  scalarType,
  isYamlPath,
  isJsonPath,
  isTreePath,
  type YamlNode,
} from "../../lib/viewers/yaml";
import { BRAND } from "../../lib/brand";

// The edits take the parsed doc (it carries the dialect and the indent step); in
// the tests the doc is always the one the node came from, so bind it here.
const setValue = (text: string, node: YamlNode, next: string, strict = false) =>
  setValueRaw(text, parseYaml(text, { strict }), node, next);
const renameKey = (text: string, node: YamlNode, next: string, strict = false) =>
  renameKeyRaw(text, parseYaml(text, { strict }), node, next);

/** The node at `path` (keys and indices), from the first document. */
function at(text: string, path: (string | number)[], strict = false): YamlNode {
  const doc = parseYaml(text, { strict });
  expect(doc.error).toBeNull();
  let node = doc.docs[0];
  for (const step of path) {
    const next =
      typeof step === "number"
        ? node.children[step]
        : node.children.find((c) => c.key === step);
    if (!next) throw new Error(`no node at ${path.join("/")} (missing ${String(step)})`);
    node = next;
  }
  return node;
}

const CONFIG = `# Server configuration
server:
  host: 0.0.0.0   # bind address
  port: 8080
  tags:
    - web
    - prod
debug: false
`;

// A sequence whose items are themselves sequences, written on the dash line.
const MATRIX = `matrix:
  - - 1
    - 2
  - - 3
`;

describe("parseYaml", () => {
  it("reads mappings, sequences and scalar types", () => {
    const doc = parseYaml(CONFIG);
    expect(doc.error).toBeNull();
    expect(doc.docs).toHaveLength(1);

    const root = doc.docs[0];
    expect(root.kind).toBe("map");
    expect(root.children.map((c) => c.key)).toEqual(["server", "debug"]);

    const server = at(CONFIG, ["server"]);
    expect(server.kind).toBe("map");
    expect(server.children.map((c) => c.key)).toEqual(["host", "port", "tags"]);

    expect(at(CONFIG, ["server", "port"]).value).toBe("8080");
    expect(scalarType(at(CONFIG, ["server", "port"]))).toBe("number");
    expect(scalarType(at(CONFIG, ["debug"]))).toBe("boolean");

    const tags = at(CONFIG, ["server", "tags"]);
    expect(tags.kind).toBe("seq");
    expect(tags.children.map((c) => c.value)).toEqual(["web", "prod"]);
    expect(tags.children[0].key).toBeNull();
  });

  it("keeps a trailing comment out of the value", () => {
    expect(at(CONFIG, ["server", "host"]).value).toBe("0.0.0.0");
  });

  it("decodes quoted scalars and remembers their style", () => {
    const text = `a: "hi \\"there\\""\nb: 'it''s fine'\n`;
    expect(at(text, ["a"]).value).toBe('hi "there"');
    expect(at(text, ["a"]).style).toBe("double");
    expect(at(text, ["b"]).value).toBe("it's fine");
    expect(at(text, ["b"]).style).toBe("single");
  });

  it("reads a block scalar's body", () => {
    const text = `script: |\n  echo one\n  echo two\nafter: 1\n`;
    const script = at(text, ["script"]);
    expect(script.style).toBe("block");
    expect(script.value).toBe("echo one\necho two");
    expect(script.endLine).toBe(2);
    expect(at(text, ["after"]).value).toBe("1");
  });

  it("reads a sequence of mappings written on the dash line", () => {
    const text = `services:\n  - name: api\n    port: 80\n  - name: web\n    port: 443\n`;
    const services = at(text, ["services"]);
    expect(services.children).toHaveLength(2);
    const first = services.children[0];
    expect(first.kind).toBe("map");
    expect(first.children.map((c) => c.key)).toEqual(["name", "port"]);
    expect(first.children[0].value).toBe("api");
    // The `name` key shares the dash's line — flagged, so every whole-line edit
    // splices around the dash instead of taking the line.
    expect(first.children[0].onDash).toBe(true);
    expect(first.children[0].deletable).toBe(true);
    expect(first.children[1].onDash).toBeUndefined();
  });

  it("reads a sequence nested inline on the dash line", () => {
    const matrix = at(MATRIX, ["matrix"]);
    expect(matrix.children).toHaveLength(2);

    const row = matrix.children[0];
    expect(row.kind).toBe("seq");
    expect(row.children.map((c) => c.value)).toEqual(["1", "2"]);
    // The first entry shares the outer dash's line — flagged, so every
    // whole-line edit splices around the dash instead of taking the line.
    expect(row.children[0].onDash).toBe(true);
    expect(row.children[0].deletable).toBe(true);
    expect(row.children[1].onDash).toBeUndefined();

    expect(at(MATRIX, ["matrix", 1]).children.map((c) => c.value)).toEqual(["3"]);
  });

  it("nests inline sequences to any depth, and mixes them with mappings", () => {
    const deep = at("- - - x\n", [0, 0]);
    expect(deep.kind).toBe("seq");
    expect(deep.children[0].value).toBe("x");

    const mapped = at("- - name: api\n    port: 80\n", [0, 0]);
    expect(mapped.kind).toBe("map");
    expect(mapped.children.map((c) => c.key)).toEqual(["name", "port"]);
  });

  it("reads a block sequence written at its key's own column", () => {
    // Valid YAML: a sequence needn't indent past its key. The items sit at the
    // SAME column as `values:`, and the mapping continues (`cutoff:`) after them.
    const text = `props:\n  values:\n  - 1\n  - 2\n  - 3\n  cutoff: 1\n`;
    const doc = parseYaml(text);
    expect(doc.error).toBeNull();
    const values = at(text, ["props", "values"]);
    expect(values.kind).toBe("seq");
    expect(values.children.map((c) => c.value)).toEqual(["1", "2", "3"]);
    // The mapping resumes after the same-indent sequence.
    expect(at(text, ["props", "cutoff"]).value).toBe("1");
  });

  it("reads a same-column sequence of scalars followed by more keys (the ZINC shape)", () => {
    const text = `labels:\n  label_type:\n  - induced_cycles\n  - primary\n  min_cycle_length: 6\n`;
    const lt = at(text, ["labels", "label_type"]);
    expect(lt.kind).toBe("seq");
    expect(lt.children.map((c) => c.value)).toEqual(["induced_cycles", "primary"]);
    expect(at(text, ["labels", "min_cycle_length"]).value).toBe("6");
  });

  it("keeps a top-level same-column list as the key's value, not a second document", () => {
    // `models:` then a nested list at column 0 is ONE document (a map whose
    // `models` is a list of lists), not a map plus an orphaned sequence.
    const text = `models:\n- - a: 1\n  - b: 2\n`;
    const doc = parseYaml(text);
    expect(doc.error).toBeNull();
    expect(doc.docs).toHaveLength(1);
    const models = at(text, ["models"]);
    expect(models.kind).toBe("seq");
    expect(models.children).toHaveLength(1);
    expect(models.children[0].kind).toBe("seq");
    expect(models.children[0].children).toHaveLength(2);
  });

  it("adds an item to a same-column sequence at that same column", () => {
    const text = `props:\n  values:\n  - 1\n  - 2\n  cutoff: 1\n`;
    const doc = parseYaml(text);
    const values = at(text, ["props", "values"]);
    const next = addChild(text, doc, values, "item", "", "3");
    expect(next).toBe(`props:\n  values:\n  - 1\n  - 2\n  - 3\n  cutoff: 1\n`);
  });

  it("splits multiple documents", () => {
    const doc = parseYaml(`a: 1\n---\nb: 2\n`);
    expect(doc.docs).toHaveLength(2);
    expect(doc.docs[0].children[0].key).toBe("a");
    expect(doc.docs[1].children[0].key).toBe("b");
  });

  it("renders anchors and merge keys but refuses to rewrite them", () => {
    const text = `base: &base\n  a: 1\nchild:\n  <<: *base\n  b: 2\n`;
    const doc = parseYaml(text);
    expect(doc.error).toBeNull();
    const merge = at(text, ["child"]).children[0];
    expect(merge.key).toBe("<<");
    expect(merge.editable).toBe(false);
    // The anchored mapping still parses into real children.
    expect(at(text, ["base"]).children.map((c) => c.key)).toEqual(["a"]);
  });

  it("refuses a construct it cannot classify instead of guessing", () => {
    expect(parseYaml("\tkey: 1\n").error?.messageKey).toBe("yamlParse.tabs");
    expect(parseYaml("? complex\n: value\n").error).not.toBeNull();
  });

  it("infers the file's own indent step", () => {
    expect(parseYaml(CONFIG).indentStep).toBe(2);
    expect(parseYaml("a:\n    b: 1\n").indentStep).toBe(4);
  });
});

describe("setValue", () => {
  it("rewrites a scalar in place, keeping its comment and the rest of the file", () => {
    const node = at(CONFIG, ["server", "host"]);
    const next = setValue(CONFIG, node, "127.0.0.1");
    expect(next).toContain("  host: 127.0.0.1   # bind address");
    expect(next).toContain("# Server configuration");
    expect(next).toContain("    - prod");
  });

  it("keeps the author's quoting style", () => {
    const text = `a: "x"\nb: 'y'\nc: z\n`;
    expect(setValue(text, at(text, ["a"]), "q")).toBe(`a: "q"\nb: 'y'\nc: z\n`);
    expect(setValue(text, at(text, ["b"]), "q")).toBe(`a: "x"\nb: 'q'\nc: z\n`);
    expect(setValue(text, at(text, ["c"]), "q")).toBe(`a: "x"\nb: 'y'\nc: q\n`);
  });

  it("quotes a plain value that would otherwise change the structure", () => {
    const text = `a: z\n`;
    expect(setValue(text, at(text, ["a"]), "key: val")).toBe(`a: "key: val"\n`);
    expect(setValue(text, at(text, ["a"]), "")).toBe(`a: ""\n`);
    expect(setValue(text, at(text, ["a"]), "# not a comment")).toBe(`a: "# not a comment"\n`);
  });

  it("writes a first value into an empty key", () => {
    const text = `a:\nb: 2\n`;
    expect(setValue(text, at(text, ["a"]), "1")).toBe(`a: 1\nb: 2\n`);
  });

  it("rewrites a block scalar's body at its own indent", () => {
    const text = `script: |\n  echo one\n  echo two\nafter: 1\n`;
    const next = setValue(text, at(text, ["script"]), "echo three\necho four");
    expect(next).toBe(`script: |\n  echo three\n  echo four\nafter: 1\n`);
  });

  it("edits a sequence item", () => {
    const next = setValue(CONFIG, at(CONFIG, ["server", "tags", 0]), "api");
    expect(next).toContain("    - api\n    - prod");
  });

  it("does nothing to a node it cannot rewrite", () => {
    const text = `child:\n  <<: *base\n`;
    const merge = at(text, ["child"]).children[0];
    expect(setValue(text, merge, "nope")).toBe(text);
  });

  it("edits an item of an inline nested sequence, dash line included", () => {
    expect(setValue(MATRIX, at(MATRIX, ["matrix", 0, 0]), "9")).toBe(
      "matrix:\n  - - 9\n    - 2\n  - - 3\n",
    );
    expect(setValue(MATRIX, at(MATRIX, ["matrix", 0, 1]), "9")).toBe(
      "matrix:\n  - - 1\n    - 9\n  - - 3\n",
    );
  });
});

describe("renameKey", () => {
  it("renames in place and leaves the value alone", () => {
    const next = renameKey(CONFIG, at(CONFIG, ["server", "port"]), "listen_port");
    expect(next).toContain("  listen_port: 8080");
    expect(next).toContain("  host: 0.0.0.0   # bind address");
  });

  it("quotes a key that needs it", () => {
    const text = `a: 1\n`;
    expect(renameKey(text, at(text, ["a"]), "we: ird")).toBe(`"we: ird": 1\n`);
  });
});

describe("deleteNode", () => {
  it("removes a key with its whole nested block, and the comment describing it", () => {
    // The comment above `server` is `server`'s. Left behind, it would come to sit
    // above `debug` and describe that instead.
    const next = deleteNode(CONFIG, at(CONFIG, ["server"]));
    expect(next).toBe("debug: false\n");
  });

  it("removes one list item", () => {
    const next = deleteNode(CONFIG, at(CONFIG, ["server", "tags", 0]));
    expect(next).toContain("  tags:\n    - prod\n");
  });

  it("deletes a key that shares its list item's line, pulling the next key up", () => {
    const text = `services:\n  - name: api\n    port: 80\n`;
    const name = at(text, ["services", 0]).children[0];
    // The dash is the item's, not the entry's: `port` climbs onto it.
    expect(deleteNode(text, name)).toBe("services:\n  - port: 80\n");
    // The item itself deletes fine, block and all.
    expect(deleteNode(text, at(text, ["services", 0]))).toBe("services:\n");
  });

  it("leaves a bare dash when the deleted dash-line entry has nothing to pull up", () => {
    // The only entry: the item stays, empty.
    expect(deleteNode("- name: a\n", at("- name: a\n", [0]).children[0])).toBe("-\n");
    // A comment-led sibling keeps its lead run above its own line — pulling the
    // line up would drag the comment onto the dash.
    const led = `- name: a\n  # docs\n  port: 1\n`;
    expect(deleteNode(led, at(led, [0]).children[0])).toBe("-\n  # docs\n  port: 1\n");
  });

  it("deletes the entry that shares its nested list's dash line", () => {
    expect(deleteNode(MATRIX, at(MATRIX, ["matrix", 0, 0]))).toBe(
      "matrix:\n  - - 2\n  - - 3\n",
    );
    // Its sibling goes on its own, and the whole row goes with the dash line.
    expect(deleteNode(MATRIX, at(MATRIX, ["matrix", 0, 1]))).toBe(
      "matrix:\n  - - 1\n  - - 3\n",
    );
    expect(deleteNode(MATRIX, at(MATRIX, ["matrix", 0]))).toBe("matrix:\n  - - 3\n");
  });
});

describe("addChild", () => {
  const add = (text: string, node: YamlNode, kind: "key" | "item", key: string, lit: string) =>
    addChild(text, parseYaml(text), node, kind, key, lit);

  it("appends a key at the siblings' own indent", () => {
    const next = add(CONFIG, at(CONFIG, ["server"]), "key", "workers", "4");
    expect(next).toContain("  tags:\n    - web\n    - prod\n  workers: 4\ndebug: false");
  });

  it("appends a list item", () => {
    const next = add(CONFIG, at(CONFIG, ["server", "tags"]), "item", "", '"eu-west"');
    expect(next).toContain("    - prod\n    - \"eu-west\"\ndebug: false");
  });

  it("appends to an inline nested sequence at its own items' column", () => {
    const next = add(MATRIX, at(MATRIX, ["matrix", 0]), "item", "", "3");
    expect(next).toBe("matrix:\n  - - 1\n    - 2\n    - 3\n  - - 3\n");
  });

  it("grows the first child of an empty key, replacing the placeholder", () => {
    const text = `server:\ndebug: false\n`;
    expect(add(text, at(text, ["server"]), "key", "port", "80"))
      .toBe("server:\n  port: 80\ndebug: false\n");

    const nullish = `server: null\n`;
    expect(add(nullish, at(nullish, ["server"]), "key", "port", "80"))
      .toBe("server:\n  port: 80\n");

    // An empty `[]`/`{}` is a real (flow) collection, not a placeholder: it grows
    // children in the style it is written in, rather than being rewritten to block.
    const emptyList = `tags: []\n`;
    expect(add(emptyList, at(emptyList, ["tags"]), "item", "", "web"))
      .toBe("tags: [web]\n");

    const emptyMap = `server: {}\n`;
    expect(add(emptyMap, at(emptyMap, ["server"]), "key", "host", "local"))
      .toBe("server: {host: local}\n");
  });

  it("matches the file's indent step", () => {
    const text = `a:\n    b:\n`;
    const next = add(text, at(text, ["a", "b"]), "key", "c", "2");
    expect(next).toBe("a:\n    b:\n        c: 2\n");
  });

  it("refuses to hang a child off a key that already holds a value", () => {
    const text = `a: 1\n`;
    expect(add(text, at(text, ["a"]), "key", "b", "2")).toBe(text);
  });

  it("only offers the children a node can actually take", () => {
    expect(canAddChild(at(CONFIG, ["server"]), "key")).toBe(true);
    expect(canAddChild(at(CONFIG, ["server"]), "item")).toBe(false);
    expect(canAddChild(at(CONFIG, ["server", "tags"]), "item")).toBe(true);
    // A key that already holds a value is not a place to hang children.
    expect(canAddChild(at(CONFIG, ["server", "port"]), "key")).toBe(false);
    expect(isEmptyPlaceholder(at("a:\n", ["a"]))).toBe(true);
    expect(isEmptyPlaceholder(at("a: 1\n", ["a"]))).toBe(false);
  });

  it("grows a placeholder inside flow into a flow collection, in place", () => {
    // The bug this guards: a flow node has no column (`indent` is -1), so growing it
    // as a block spliced a line at column -1 into the middle of the brackets and tore
    // the collection open. Every `null` in a JSON file is one of these.
    const flowNull = `service: {name: null}\n`;
    expect(add(flowNull, at(flowNull, ["service", "name"]), "item", "", "x"))
      .toBe("service: {name: [x]}\n");
    expect(add(flowNull, at(flowNull, ["service", "name"]), "key", "first", "api"))
      .toBe("service: {name: {first: api}}\n");

    // An empty value has no token to replace — the collection splices in after the `:`.
    const flowEmpty = `service: {name: , port: 1}\n`;
    expect(add(flowEmpty, at(flowEmpty, ["service", "name"]), "item", "", "x"))
      .toBe("service: {name: [x], port: 1}\n");

    const flowSeq = `hosts: [a, null]\n`;
    expect(add(flowSeq, at(flowSeq, ["hosts", 1]), "item", "", "x")).toBe("hosts: [a, [x]]\n");
  });

  it("adds a mapping ITEM when a list is given a key", () => {
    // A list of mappings is grown by adding a key to the list — not by adding an
    // empty container and then filling it.
    const text = `services:\n  - name: api\n    port: 80\n`;
    expect(add(text, at(text, ["services"]), "key", "name", "web"))
      .toBe("services:\n  - name: api\n    port: 80\n  - name: web\n");
    expect(canAddChild(at(text, ["services"]), "key")).toBe(true);

    // In flow, the same thing in the collection's own style.
    const flow = `services: [{name: api}]\n`;
    expect(add(flow, at(flow, ["services"]), "key", "name", "web"))
      .toBe("services: [{name: api}, {name: web}]\n");
  });

  it("seeds an empty file", () => {
    expect(addRootEntry("", "key", "name", `"${BRAND.slug}"`)).toBe(`name: "${BRAND.slug}"\n`);
    expect(addRootEntry("# just a comment\n", "item", "", "first")).toBe(
      "# just a comment\n- first\n",
    );
  });
});

describe("literalFor", () => {
  it("writes the type the user picked", () => {
    expect(literalFor("text", "hello")).toBe("hello");
    // A string that would read back as a number/bool/null gets quoted — that is
    // what makes "no" the string "no".
    expect(literalFor("text", "no")).toBe('"no"');
    expect(literalFor("text", "8080")).toBe('"8080"');
    expect(literalFor("number", "8080")).toBe("8080");
    expect(literalFor("boolean", "true")).toBe("true");
    expect(literalFor("null", "")).toBe("null");
    expect(literalFor("map", "")).toBe("{}");
    expect(literalFor("seq", "")).toBe("[]");
  });
});

describe("moveNode", () => {
  it("reorders list items, block and all", () => {
    const text = `services:\n  - name: api\n    port: 80\n  - name: web\n    port: 443\n`;
    const services = at(text, ["services"]);
    const next = moveNode(text, services.children, services.children[1], -1);
    expect(next).toBe(
      "services:\n  - name: web\n    port: 443\n  - name: api\n    port: 80\n",
    );
  });

  it("reorders mapping keys, and a comment travels with the key it describes", () => {
    // `# about b` sits directly above `b`, so it is b's — reordering must carry it,
    // or the two keys would swap descriptions behind the author's back.
    const text = `# about a\na: 1\n# about b\nb: 2\n`;
    const root = parseYaml(text).docs[0];
    expect(moveNode(text, root.children, root.children[0], 1)).toBe(
      "# about b\nb: 2\n# about a\na: 1\n",
    );
  });

  it("moves a node straight to a distant sibling, in one edit", () => {
    const text = `a: 1\nb: 2\nc: 3\nd: 4\n`;
    const root = parseYaml(text).docs[0];
    expect(moveNodeTo(text, root.children, root.children[3], 0)).toBe("d: 4\na: 1\nb: 2\nc: 3\n");
    expect(moveNodeTo(text, root.children, root.children[0], 2)).toBe("b: 2\nc: 3\na: 1\nd: 4\n");
    // Dropping a node on itself is not an edit.
    expect(moveNodeTo(text, root.children, root.children[1], 1)).toBe(text);
  });

  it("does nothing at the ends", () => {
    const root = parseYaml(CONFIG).docs[0];
    expect(moveNode(CONFIG, root.children, root.children[0], -1)).toBe(CONFIG);
    expect(moveNode(CONFIG, root.children, root.children[1], 1)).toBe(CONFIG);
  });

  it("hands the dash over when first place changes hands", () => {
    // In `- name: a`, `name` shares the item's dash line; a reorder into or out
    // of first place moves the entry and re-homes the `- ` prefix.
    const text = `- name: a\n  port: 1\n  host: x\n`;
    const item = at(text, [0]);
    // `host` (index 2) dropped onto `name` (index 0): host takes the dash.
    expect(moveNodeTo(text, item.children, item.children[2], 0)).toBe(
      `- host: x\n  name: a\n  port: 1\n`,
    );
    // `name` moved off the dash line: `port` takes the dash.
    expect(moveNodeTo(text, item.children, item.children[0], 1)).toBe(
      `- port: 1\n  name: a\n  host: x\n`,
    );
    // Dropping onto `port` (index 1) leaves the dash line alone.
    expect(moveNodeTo(text, item.children, item.children[2], 1)).toBe(
      `- name: a\n  host: x\n  port: 1\n`,
    );
  });

  it("keeps a trailing comment with the dash-line entry it moves, and a lead above the dash", () => {
    // The moved entry's own `#` travels with it off the dash line…
    const noted = `- name: a  # who\n  port: 1\n`;
    expect(moveNodeTo(noted, at(noted, [0]).children, at(noted, [0]).children[0], 1)).toBe(
      `- port: 1\n  name: a  # who\n`,
    );
    // …and an entry moved ONTO the dash line keeps its lead run above it — the
    // placement an item's prose already uses.
    const led = `- name: a\n  # p docs\n  port: 1\n`;
    expect(moveNodeTo(led, at(led, [0]).children, at(led, [0]).children[1], 0)).toBe(
      `  # p docs\n- port: 1\n  name: a\n`,
    );
  });

  it("hands the outer dash over inside a nested sequence", () => {
    expect(
      moveNodeTo(MATRIX, at(MATRIX, ["matrix", 0]).children, at(MATRIX, ["matrix", 0, 1]), 0),
    ).toBe("matrix:\n  - - 2\n    - 1\n  - - 3\n");
  });
});

describe("duplicateNode", () => {
  it("appends a verbatim copy of a block list item", () => {
    const text = `tags:\n  - web\n  - prod\n`;
    const last = at(text, ["tags", 1]);
    expect(duplicateNode(text, last)).toBe(`tags:\n  - web\n  - prod\n  - prod\n`);
  });

  it("copies a whole mapping item, nested block and all", () => {
    const text = `items:\n  - name: a\n    port: 1\n  - name: b\n    port: 2\n`;
    const last = at(text, ["items", 1]);
    expect(duplicateNode(text, last)).toBe(
      `items:\n  - name: a\n    port: 1\n  - name: b\n    port: 2\n  - name: b\n    port: 2\n`,
    );
  });

  it("duplicates a dash-line entry below it, without the dash", () => {
    // The `- ` prefix is the item's, not the entry's — the copy gets spaces.
    expect(duplicateNode("- - a\n", at("- - a\n", [0, 0]))).toBe("- - a\n  - a\n");
  });
});

describe("comments", () => {
  const comment = (text: string, node: YamlNode, next: string, strict = false) =>
    setComment(text, parseYaml(text, { strict }), node, next);

  it("reads a comment written behind the value, and one written above the key", () => {
    expect(commentOf(at(CONFIG, ["server", "host"]))).toBe("bind address");
    expect(commentOf(at(CONFIG, ["server"]))).toBe("Server configuration");
    expect(commentOf(at(CONFIG, ["debug"]))).toBe("");
  });

  it("only claims the prose that is unambiguously about it", () => {
    // A blank line, or a comment at another indent, ends the run — so a key does not
    // adopt the section header two entries up.
    const text = `# section\n\na: 1\nb:\n  # about c\n  c: 2\n`;
    expect(commentOf(at(text, ["a"]))).toBe("");
    expect(commentOf(at(text, ["b", "c"]))).toBe("about c");
    // A multi-line run above a key is all of it.
    const run = `# one\n# two\na: 1\n`;
    expect(commentOf(at(run, ["a"]))).toBe("one\ntwo");
  });

  it("writes where the author already wrote, and behind the value when there is none", () => {
    // Behind stays behind.
    expect(comment(CONFIG, at(CONFIG, ["server", "host"]), "the address to bind"))
      .toContain("  host: 0.0.0.0   # the address to bind\n");
    // Above stays above, at the key's own indent.
    expect(comment(CONFIG, at(CONFIG, ["server"]), "How the server listens"))
      .toBe(CONFIG.replace("# Server configuration", "# How the server listens"));
    // A key with no comment gets one behind — it adds no line, so it disturbs nothing.
    expect(comment(CONFIG, at(CONFIG, ["debug"]), "verbose logs"))
      .toContain("debug: false  # verbose logs\n");
  });

  it("comments a container, a list item and a nested list", () => {
    expect(comment(CONFIG, at(CONFIG, ["server", "tags"]), "where it runs"))
      .toContain("  tags:  # where it runs\n");
    expect(comment(CONFIG, at(CONFIG, ["server", "tags", 0]), "public"))
      .toContain("    - web  # public\n");
    expect(comment(MATRIX, at(MATRIX, ["matrix", 0, 1]), "second"))
      .toBe("matrix:\n  - - 1\n    - 2  # second\n  - - 3\n");
  });

  it("comments a mapping list item above its dash line, not behind the first key", () => {
    // `- name: api` — a comment behind the dash line would belong to `name`, so
    // the whole item is documented on the line above it instead.
    const text = `services:\n  - name: api\n    port: 80\n  - name: web\n    port: 443\n`;
    const item = at(text, ["services", 0]);
    expect(canAddChild(item, "key")).toBe(true); // it's a mapping item
    const commented = comment(text, item, "the API service");
    expect(commented).toBe(
      `services:\n  # the API service\n  - name: api\n    port: 80\n  - name: web\n    port: 443\n`,
    );
    // It reads back as the item's own comment, and clears back to the original.
    const item2 = at(commented, ["services", 0]);
    expect(commentOf(item2)).toBe("the API service");
    expect(comment(commented, item2, "")).toBe(text);
  });

  it("comments a nested-sequence list item above its dash line", () => {
    // `- - 1` — the outer item is a sequence written on the dash line.
    const item = at(MATRIX, ["matrix", 0]);
    expect(comment(MATRIX, item, "first row")).toBe(
      "matrix:\n  # first row\n  - - 1\n    - 2\n  - - 3\n",
    );
  });

  it("clears a comment without leaving the whitespace behind it", () => {
    expect(comment(CONFIG, at(CONFIG, ["server", "host"]), "")).toContain("  host: 0.0.0.0\n");
    expect(comment(CONFIG, at(CONFIG, ["server"]), "")).toBe(
      CONFIG.replace("# Server configuration\n", ""),
    );
  });

  it("refuses where a comment cannot go: JSON, and inside a flow collection", () => {
    const json = `{"a": 1}\n`;
    const doc = parseYaml(json, { strict: true });
    expect(canComment(doc, at(json, ["a"], true))).toBe(false);
    expect(comment(json, at(json, ["a"], true), "nope", true)).toBe(json);

    // A `#` inside `{…}` would swallow the closing bracket and everything up to it.
    const flow = `service: { name: api }\n`;
    expect(canComment(parseYaml(flow), at(flow, ["service", "name"]))).toBe(false);
    expect(comment(flow, at(flow, ["service", "name"]), "nope")).toBe(flow);
    // The collection itself sits on a block line, so it can take one — behind the `}`.
    expect(comment(flow, at(flow, ["service"]), "the api")).toBe(
      "service: { name: api }  # the api\n",
    );
  });
});

describe("round-trip", () => {
  it("leaves everything it did not touch byte-identical", () => {
    const text = CONFIG;
    // An edit deep in the file must not reformat the comment, the blank-line
    // free layout, the quoting, or the trailing newline.
    const edited = setValue(text, at(text, ["debug"]), "true");
    expect(edited).toBe(text.replace("debug: false", "debug: true"));
  });

  it("preserves CRLF line endings", () => {
    const text = "a: 1\r\nb: 2\r\n";
    const next = addChild(text, parseYaml(text), parseYaml(text).docs[0], "key", "c", "3");
    expect(next).toBe("a: 1\r\nb: 2\r\nc: 3\r\n");
  });

  it("does not add a trailing newline the file did not have", () => {
    const text = "a: 1";
    expect(setValue(text, at(text, ["a"]), "2")).toBe("a: 2");
  });
});

describe("paths", () => {
  it("routes .yaml/.yml/.json to the tree, and nothing else", () => {
    expect(isYamlPath("/p/config.yaml")).toBe(true);
    expect(isYamlPath("/p/config.yml")).toBe(true);
    expect(isYamlPath("/p/config.json")).toBe(false);
    expect(isJsonPath("/p/config.json")).toBe(true);
    expect(isTreePath("/p/config.json")).toBe(true);
    expect(isTreePath("/p/config.yml")).toBe(true);
    expect(isTreePath("/p/main.rs")).toBe(false);
    expect(isTreePath("/p/yaml")).toBe(false);
  });
});

// ── Flow (JSON) syntax ──────────────────────────────────────────────────────
// The bug this whole layer exists for: a flow collection used to parse as one
// opaque scalar, so a JSON-formatted file showed a single row reading "{".

const FLOW = `# app
service: { name: api, port: 8080 }
hosts: [a, b]
`;

const SPREAD = `service: {
  name: api,
  port: 8080
}
`;

describe("flow collections", () => {
  it("parses an inline flow map and list as real trees", () => {
    const svc = at(FLOW, ["service"]);
    expect(svc.kind).toBe("map");
    expect(isFlow(svc)).toBe(true);
    expect(svc.children.map((c) => c.key)).toEqual(["name", "port"]);
    expect(svc.children[1].value).toBe("8080");
    expect(scalarType(svc.children[1])).toBe("number");

    const hosts = at(FLOW, ["hosts"]);
    expect(hosts.kind).toBe("seq");
    expect(hosts.children.map((c) => c.value)).toEqual(["a", "b"]);
  });

  it("parses a flow collection that spans lines", () => {
    const svc = at(SPREAD, ["service"]);
    expect(svc.children.map((c) => c.key)).toEqual(["name", "port"]);
    expect(svc.endLine).toBe(3);
  });

  it("parses nested flow, and flow inside a block list", () => {
    const text = `items:\n  - {id: 1, tags: [x, y]}\n  - {id: 2, tags: []}\n`;
    const first = at(text, ["items", 0]);
    expect(first.children.map((c) => c.key)).toEqual(["id", "tags"]);
    const tags = first.children[1];
    expect(tags.kind).toBe("seq");
    expect(tags.children.map((c) => c.value)).toEqual(["x", "y"]);
    expect(at(text, ["items", 1]).children[1].children).toHaveLength(0);
  });

  it("edits a value inside flow without disturbing the collection", () => {
    const next = setValue(FLOW, at(FLOW, ["service", "port"]), "9090");
    expect(next).toBe(FLOW.replace("port: 8080", "port: 9090"));
    expect(next).toContain("# app");
  });

  it("adds inline when the collection is inline, on its own line when it is not", () => {
    const inline = addChild(FLOW, parseYaml(FLOW), at(FLOW, ["hosts"]), "item", "", "c");
    expect(inline).toContain("hosts: [a, b, c]");

    const spread = addChild(SPREAD, parseYaml(SPREAD), at(SPREAD, ["service"]), "key", "tls", "true");
    expect(spread).toBe("service: {\n  name: api,\n  port: 8080,\n  tls: true\n}\n");
  });

  it("deletes a flow entry with its comma, not leaving a hole", () => {
    expect(deleteNode(FLOW, at(FLOW, ["hosts", 0]))).toContain("hosts: [b]");
    expect(deleteNode(FLOW, at(FLOW, ["hosts", 1]))).toContain("hosts: [a]");
    expect(deleteNode(FLOW, at(FLOW, ["service", "name"]))).toContain("service: { port: 8080 }");
  });

  it("deletes a whole flow value with its key, lines and all", () => {
    expect(deleteNode(SPREAD, at(SPREAD, ["service"]))).toBe("");
  });

  it("reorders flow entries by swapping their spans", () => {
    const hosts = at(FLOW, ["hosts"]);
    expect(moveNode(FLOW, hosts.children, hosts.children[1], -1)).toContain("hosts: [b, a]");
  });

  it("refuses an unclosed collection rather than showing half a tree", () => {
    expect(parseYaml("a: {b: 1\n").error?.messageKey).toBe("yamlParse.neverClosed");
  });
});

describe("JSON (strict) files", () => {
  const PKG = `{
  "name": "app",
  "version": "1.0.0",
  "scripts": {"build": "vite"},
  "keywords": []
}
`;

  it("parses a whole JSON document as the tree", () => {
    const doc = parseYaml(PKG, { strict: true });
    expect(doc.error).toBeNull();
    const root = doc.docs[0];
    expect(root.kind).toBe("map");
    expect(root.children.map((c) => c.key)).toEqual(["name", "version", "scripts", "keywords"]);
    expect(at(PKG, ["scripts", "build"], true).value).toBe("vite");
  });

  it("writes strings and keys quoted, and bare literals bare", () => {
    const version = at(PKG, ["version"], true);
    expect(setValue(PKG, version, "2.0.0", true)).toContain('"version": "2.0.0"');

    const doc = parseYaml(PKG, { strict: true });
    const next = addChild(PKG, doc, at(PKG, ["keywords"], true), "item", "", literalFor("text", "cli", true));
    expect(next).toContain('"keywords": ["cli"]');

    const withPort = addChild(PKG, doc, doc.docs[0], "key", "port", literalFor("number", "3000", true));
    expect(withPort).toContain('"keywords": [],\n  "port": 3000\n}');

    expect(renameKey(PKG, at(PKG, ["name"], true), "title", true)).toContain('"title": "app"');
  });

  it("seeds an empty JSON file with the collection itself", () => {
    expect(addRootEntry("", "key", "name", literalFor("text", "app", true), true)).toBe(
      '{"name": "app"}\n',
    );
  });
});

describe("copy & paste (#yaml copy button + paste cursor)", () => {
  it("captures a map entry dedented, with its trailing comment", () => {
    const clip = copyNode(CONFIG, at(CONFIG, ["server", "host"]));
    expect(clip).not.toBeNull();
    expect(clip!.text).toBe("host: 0.0.0.0   # bind address");
    expect(clip!.isMapEntry).toBe(true);
    expect(clip!.inFlow).toBe(false);
  });

  it("captures a container with its whole block, dedented to column 0", () => {
    const clip = copyNode(CONFIG, at(CONFIG, ["server", "tags"]));
    expect(clip!.lines).toEqual(["tags:", "  - web", "  - prod"]);
    expect(clip!.text).toBe("tags:\n  - web\n  - prod");
  });

  it("captures a list item as an item, not a mapping entry", () => {
    const clip = copyNode(CONFIG, at(CONFIG, ["server", "tags", 0]));
    expect(clip!.text).toBe("- web");
    expect(clip!.isMapEntry).toBe(false);
  });

  it("captures the key that shares its item's dash line, without the dash", () => {
    const LIST = "list:\n  - name: a\n    port: 1\n";
    const clip = copyNode(LIST, at(LIST, ["list", 0, "name"]))!;
    // The `- ` prefix is the item's, not the entry's — the clip starts at the key.
    expect(clip.text).toBe("name: a");
    expect(clip.isMapEntry).toBe(true);
  });

  it("gates the paste to containers the entry fits", () => {
    const entry = copyNode(CONFIG, at(CONFIG, ["server", "port"]))!; // key: value
    const item = copyNode(CONFIG, at(CONFIG, ["server", "tags", 0]))!; // - web

    // A mapping entry goes after another mapping entry, never after a list item.
    expect(canPasteAfter(entry, at(CONFIG, ["debug"]), "map")).toBe(true);
    expect(canPasteAfter(entry, at(CONFIG, ["server", "tags", 1]), "seq")).toBe(false);
    // A list item goes after another list item, never into a mapping.
    expect(canPasteAfter(item, at(CONFIG, ["server", "tags", 1]), "seq")).toBe(true);
    expect(canPasteAfter(item, at(CONFIG, ["debug"]), "map")).toBe(false);

    // Block and flow never mix: a block entry has no place inside `{...}`.
    const FLOW = "obj: {a: 1, b: 2}\n";
    expect(canPasteAfter(entry, at(FLOW, ["obj", "b"]), "map")).toBe(false);
    const flowEntry = copyNode(FLOW, at(FLOW, ["obj", "a"]))!;
    expect(canPasteAfter(flowEntry, at(CONFIG, ["debug"]), "map")).toBe(false);
  });

  it("pastes a map entry after another key, re-indented to its column", () => {
    // From indent 2 (inside server) to indent 0 (top level): the copy lands at
    // the anchor's column, and every other line stays byte-identical.
    const clip = copyNode(CONFIG, at(CONFIG, ["server", "port"]))!;
    const next = pasteAfter(CONFIG, at(CONFIG, ["debug"]), clip);
    expect(next).toBe(CONFIG.replace("debug: false\n", "debug: false\nport: 8080\n"));
    expect(parseYaml(next).error).toBeNull();
  });

  it("pastes a whole container after a deeper key, indenting its block", () => {
    const clip = copyNode(CONFIG, at(CONFIG, ["server", "tags"]))!;
    const next = pasteAfter(CONFIG, at(CONFIG, ["server", "host"]), clip);
    expect(next).toContain(
      "  host: 0.0.0.0   # bind address\n  tags:\n    - web\n    - prod\n  port: 8080",
    );
    expect(parseYaml(next).error).toBeNull();
  });

  it("pastes a list item into another list, as the anchor's next sibling", () => {
    const TWO = "a:\n  - one\nb:\n  - two\n";
    const clip = copyNode(TWO, at(TWO, ["a", 0]))!;
    const next = pasteAfter(TWO, at(TWO, ["b", 0]), clip);
    expect(next).toBe("a:\n  - one\nb:\n  - two\n  - one\n");
  });

  it("pastes into an inline flow collection between commas", () => {
    const FLOW = "list: [1, 2]\n";
    const clip = copyNode(FLOW, at(FLOW, ["list", 0]))!;
    expect(pasteAfter(FLOW, at(FLOW, ["list", 1]), clip)).toBe("list: [1, 2, 1]\n");
  });

  it("pastes onto its own line in a spread flow (JSON) collection", () => {
    const PKG = '{\n  "a": 1,\n  "b": 2\n}\n';
    const clip = copyNode(PKG, at(PKG, ["a"], true))!;
    const next = pasteAfter(PKG, at(PKG, ["b"], true), clip);
    expect(next).toBe('{\n  "a": 1,\n  "b": 2,\n  "a": 1\n}\n');
    expect(parseYaml(next, { strict: true }).error).toBeNull();
  });

  it("refuses a cross-style paste outright", () => {
    const FLOW = "obj: {a: 1}\n";
    const blockClip = copyNode(CONFIG, at(CONFIG, ["server", "port"]))!;
    expect(pasteAfter(FLOW, at(FLOW, ["obj", "a"]), blockClip)).toBe(FLOW);
    const flowClip = copyNode(FLOW, at(FLOW, ["obj", "a"]))!;
    expect(pasteAfter(CONFIG, at(CONFIG, ["debug"]), flowClip)).toBe(CONFIG);
  });
});
