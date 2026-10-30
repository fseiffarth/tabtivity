/**
 * VM tier (`docs/vm_projects_plan.md`) — the frontend half of the
 * no-local-fallback rule: a VM project's tab locality is PINNED to the VM
 * host. The agents-default-local rule (right for network remotes: WAN
 * latency, offline work, login nodes) is precisely the escape the VM tier
 * forbids — an agent "running local" is the untrusted code stepping outside
 * the boundary. The backend's spawn guard refuses the spawn as the hard
 * boundary; `effectiveTabLocation`'s `hostPinned` pin is what keeps the
 * frontend from ever building one.
 */
import { describe, it, expect } from "vitest";
import { effectiveTabLocation } from "../../stores/tabs";

describe("effectiveTabLocation VM pinning", () => {
  it("pins agent tabs (default-local elsewhere) to remote for a VM project", () => {
    expect(effectiveTabLocation({ kind: "agent" })).toBe("local");
    expect(effectiveTabLocation({ kind: "agent" }, { hostPinned: true })).toBe("remote");
  });

  it("overrides even an explicitly stored local location", () => {
    // A persisted layout is agent-writable state — a planted `location:
    // "local"` must not survive the pin.
    expect(
      effectiveTabLocation({ kind: "shell", location: "local" }, { hostPinned: true }),
    ).toBe("remote");
    expect(
      effectiveTabLocation({ kind: "agent", location: "local" }, { hostPinned: true }),
    ).toBe("remote");
  });

  it("leaves non-VM projects on the existing per-kind defaults", () => {
    expect(effectiveTabLocation({ kind: "shell" }, { hostPinned: false })).toBe("remote");
    expect(effectiveTabLocation({ kind: "agent" }, { hostPinned: false })).toBe("local");
    expect(effectiveTabLocation({ kind: "shell", location: "local" })).toBe("local");
  });

  it("keeps local_agent (Ollama driver) local — the backend refuses it with its own message", () => {
    // A local-model driver tab depends on the local VIBE_HOME; inside a VM it
    // cannot work either way, so the honest outcome is the spawn guard's
    // refusal, not a silent remote rewrite of a host-bound kind.
    expect(effectiveTabLocation({ kind: "local_agent" }, { hostPinned: true })).toBe("local");
  });
});
