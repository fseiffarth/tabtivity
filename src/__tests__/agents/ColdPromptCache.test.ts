/**
 * Locks when the Reader's "cache cold" chip shows (`coldPromptCache`): only
 * once the prompt cache the session's newest answer left has outlived its
 * lifetime, counted from that answer, and never on figures the transcript
 * did not give.
 */
import { describe, expect, it } from "vitest";
import { coldPromptCache } from "../../stores/agents/agentResumeCost";

const at = Date.UTC(2026, 10, 19, 10, 0, 0);
const cache = { lastAtMs: at, ttlSecs: 3600, contextTokens: 120_000 };

describe("coldPromptCache", () => {
  it("is null while the cache still lives, and at the very end of it", () => {
    expect(coldPromptCache(cache, at + 59 * 60_000)).toBeNull();
    expect(coldPromptCache(cache, at + 3600_000)).toBeNull();
  });

  it("names the idle time, the lifetime and the tokens once it has run out", () => {
    expect(coldPromptCache(cache, at + 3601_000)).toEqual({ secondsIdle: 3601, ttlSecs: 3600, contextTokens: 120_000 });
    expect(coldPromptCache({ ...cache, ttlSecs: 300 }, at + 6 * 60_000)?.secondsIdle).toBe(360);
  });

  it("is null without figures, or with ones that cannot be right", () => {
    expect(coldPromptCache(undefined, at + 86_400_000)).toBeNull();
    expect(coldPromptCache({ ...cache, ttlSecs: 0 }, at + 86_400_000)).toBeNull();
    expect(coldPromptCache({ ...cache, contextTokens: 0 }, at + 86_400_000)).toBeNull();
    // A clock behind the transcript's stamp is not idle time.
    expect(coldPromptCache(cache, at - 10_000_000)).toBeNull();
  });
});
