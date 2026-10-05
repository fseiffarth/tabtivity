/**
 * `mobile-web/src/terminal/protocol.ts` mirrors constants that live in the Rust
 * sidecar (`services/mobile_control/protocol.rs`). A resize outside the
 * desktop's accepted geometry is answered with a close that never retries, so
 * the two copies drifting apart is a phone that cannot attach. This reads the
 * Rust source and holds the TypeScript side to it.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMINAL_PROTOCOL, TERMINAL_SIZE } from "../../../mobile-web/src/terminal/protocol";
import { readRustBrand } from "../helpers/rustBrand";
import { BRAND } from "../../lib/brand";

// vitest runs from the repo root, as the other source-reading tests assume.
const RUST = readFileSync("src-tauri/src/services/mobile_control/protocol.rs", "utf8");

function rustConst(name: string): string {
  const m = new RegExp(`pub const ${name}: [^=]+= ([^;]+);`).exec(RUST);
  if (!m) throw new Error(`protocol.rs no longer defines ${name}`);
  return m[1].trim();
}

const TS = readFileSync("mobile-web/src/terminal/protocol.ts", "utf8");

/** The wire `type` of every variant of a Rust enum (`rename_all = "snake_case"`). */
function rustVariants(name: string): string[] {
  const body = new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(RUST);
  if (!body) throw new Error(`protocol.rs no longer defines ${name}`);
  return [...body[1].matchAll(/^ {4}([A-Z][A-Za-z]*)/gm)]
    .map((m) => m[1].replace(/(?!^)([A-Z])/g, "_$1").toLowerCase())
    .sort();
}

/** The `type` of every member of a TypeScript union in `protocol.ts`. */
function tsVariants(name: string): string[] {
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);\\n\\n`).exec(TS);
  if (!body) throw new Error(`protocol.ts no longer defines ${name}`);
  return [...body[1].matchAll(/\{ type: "([a-z_]+)"/g)].map((m) => m[1]).sort();
}

describe(`${BRAND.display} Mobile terminal protocol mirror`, () => {
  // A control the sidecar does not name closes the socket for good, and an
  // event the phone does not name is silently dropped: the two lists are one.
  it("names the same controls and events as the sidecar", () => {
    expect(tsVariants("TerminalControl")).toEqual(rustVariants("TerminalControl"));
    expect(tsVariants("TerminalEvent")).toEqual(rustVariants("TerminalEvent"));
    expect(rustVariants("TerminalControl")).toContain("visibility");
    expect(rustVariants("TerminalEvent")).toContain("features");
  });

  it("names the same subprotocol as the sidecar", () => {
    // The sidecar takes the name from its brand module; resolve it there.
    expect(rustConst("TERMINAL_PROTOCOL")).toBe("crate::brand::TERMINAL_PROTOCOL");
    expect(readRustBrand().current.TERMINAL_PROTOCOL).toBe(TERMINAL_PROTOCOL);
  });

  it("accepts exactly the geometry the sidecar accepts", () => {
    expect(Number(rustConst("MIN_COLS"))).toBe(TERMINAL_SIZE.minCols);
    expect(Number(rustConst("MAX_COLS"))).toBe(TERMINAL_SIZE.maxCols);
    expect(Number(rustConst("MIN_ROWS"))).toBe(TERMINAL_SIZE.minRows);
    expect(Number(rustConst("MAX_ROWS"))).toBe(TERMINAL_SIZE.maxRows);
  });

  it("describes a usable range", () => {
    expect(TERMINAL_SIZE.minCols).toBeLessThan(TERMINAL_SIZE.maxCols);
    expect(TERMINAL_SIZE.minRows).toBeLessThan(TERMINAL_SIZE.maxRows);
    // An 80×24 terminal — the size every TUI assumes — must be inside it.
    expect(TERMINAL_SIZE.minCols).toBeLessThanOrEqual(80);
    expect(TERMINAL_SIZE.maxCols).toBeGreaterThanOrEqual(80);
    expect(TERMINAL_SIZE.minRows).toBeLessThanOrEqual(24);
    expect(TERMINAL_SIZE.maxRows).toBeGreaterThanOrEqual(24);
  });
});
