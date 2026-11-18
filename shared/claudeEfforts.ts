/** The levels Claude Code's `/effort` takes (2.1.288); the session lowers one
 * its model does not support and says so. `auto` hands it back to the model.
 * Shared: the desktop Reader's effort chip and the phone's both send it. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
