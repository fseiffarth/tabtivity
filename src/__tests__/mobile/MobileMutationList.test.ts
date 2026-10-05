/**
 * Which desktop requests are mutations is written down twice: the window
 * queues them per domain (`mutationDomain` in `MobileBridgeHost.tsx`), and the
 * Rust side reports an over-large answer to one as "applied" instead of as a
 * failed write (`DesktopRequest::is_mutation` in `protocol.rs`). A request on
 * one list and not the other is a write the phone is invited to send twice.
 * This reads the Rust source and holds the two lists to each other.
 */
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { mutationDomain } from "../../components/mobile/MobileBridgeHost";

// vitest runs from the repo root, as the other source-reading tests assume.
const RUST: string = readFileSync("src-tauri/src/services/mobile_control/protocol.rs", "utf8");

const snake = (variant: string) => variant.replace(/(?!^)([A-Z])/g, "_$1").toLowerCase();

/** The two arms of `is_mutation`'s match, as wire `type` tags. */
function rustLists(): { mutations: string[]; reads: string[] } {
  const body = /pub fn is_mutation\(&self\) -> bool \{([\s\S]*?)\n {4}\}/.exec(RUST)?.[1];
  if (!body) throw new Error("protocol.rs no longer defines is_mutation");
  const [yes, no, ...rest] = body.split(/=> (?:true|false),/);
  if (rest.join("").trim() !== "}") throw new Error("is_mutation is no longer two arms");
  const tags = (arm: string) => [...arm.matchAll(/Self::(\w+)/g)].map((m) => snake(m[1]));
  return { mutations: tags(yes), reads: tags(no) };
}

describe("desktop mutation list mirror", () => {
  const { mutations, reads } = rustLists();
  type RequestType = Parameters<typeof mutationDomain>[0];

  it("reads both arms of the Rust match", () => {
    expect(mutations).toContain("todo_mutate");
    expect(mutations).toContain("create");
    expect(reads).toContain("todo");
    expect(reads).toContain("agent_transcript");
  });

  it("queues exactly the requests Rust calls mutations", () => {
    for (const type of mutations) expect([type, mutationDomain(type as RequestType) !== null]).toEqual([type, true]);
    for (const type of reads) expect([type, mutationDomain(type as RequestType)]).toEqual([type, null]);
  });

  it("covers every request the enum has", () => {
    const enumBody = /pub enum DesktopRequest \{([\s\S]*?)\n\}/.exec(RUST)?.[1] ?? "";
    const variants = [...enumBody.matchAll(/^ {4}(\w+) \{/gm)].map((m) => snake(m[1]));
    expect(variants.length).toBeGreaterThan(30);
    expect([...mutations, ...reads].sort()).toEqual([...variants].sort());
  });
});
