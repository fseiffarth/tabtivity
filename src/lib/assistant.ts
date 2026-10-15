/**
 * The chat assistant's shared frontend constants (`docs/assistant_plan.md`).
 * The user-facing name is `BRAND.assistant` / the `{assistant}` placeholder
 * (`lib/brand.ts`); code identifiers say `assistant`, never the name.
 */

/** The scope id of the assistant's tabs: `storage::ASSISTANT_SCOPE` in the
 *  backend, `tabsByScope[ASSISTANT_SCOPE]` here. Not a project and not root
 *  (`ROOT_SCOPE`), so anything that reads "a scope that is not root" as a
 *  project must meet this one first. */
export const ASSISTANT_SCOPE = "assistant";

/**
 * Skeleton placeholder, deleted by the step that builds each surface.
 *
 * The untested register (`lib/untested`) fails on a row no source file uses,
 * and the skeleton step registers the ids before their surfaces exist. These
 * entries are the rows' call sites until then: the step that adds the real
 * `UntestedTag` call site (S4b: `assistant.overlay`, `assistant.newChat`,
 * `assistant.search`; S5b: `mobile.assistant`) deletes its entry here, and
 * this constant with the last one.
 */
export const ASSISTANT_PENDING_PILLS = [
  { untested: "assistant.overlay" },
  { untested: "assistant.newChat" },
  { untested: "assistant.search" },
  { untested: "mobile.assistant" },
] as const;
