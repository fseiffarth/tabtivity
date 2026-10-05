/**
 * The composer's Commit chip: a commit from the phone without typing one out.
 * Each choice is a prompt the agent gets like any other — it reads the tree,
 * writes the message and runs the repo's own hooks — so the phone needs no git
 * of its own, and a project's commit rules (its AGENTS.md) still apply.
 *
 * The words go to the agent, not to the reader, so they are not translated:
 * every CLI is prompted in the same English.
 */
export type CommitChoice = "own" | "state" | "split";

export const COMMIT_CHOICES: readonly CommitChoice[] = ["own", "state", "split"];

export const COMMIT_PROMPTS: Record<CommitChoice, string> = {
  own: "Commit only the changes you made in this conversation, with a concise message that says what changed. Leave every other change uncommitted. Do not push.",
  state: "Commit the current state: stage all uncommitted changes and make one commit with a concise message that says what changed. Do not push.",
  split: "Split the uncommitted changes into focused commits: group related changes, one logical change per commit, each with a concise message. Do not push.",
};
