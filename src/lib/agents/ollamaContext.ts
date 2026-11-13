/** The smallest context window that leaves an agent room to work: OpenCode's
    system prompt and tools alone run to about 11 000 tokens. */
export const AGENT_MIN_CONTEXT = 16_384;

/**
 * The resident models too short on context for a coding agent. Ollama cuts an
 * oversized prompt with no error, so the agent just loses the user's message
 * and its tool results. A model that reports no context length is left out:
 * unknown is not short.
 */
export function shortOnContext<M extends { running: boolean; context_length?: number | null }>(
  models: readonly M[],
): M[] {
  return models.filter((m) => m.running && m.context_length != null && m.context_length < AGENT_MIN_CONTEXT);
}
