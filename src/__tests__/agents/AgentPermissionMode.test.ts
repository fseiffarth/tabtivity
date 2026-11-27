import { beforeEach, describe, expect, it } from "vitest";
import { useAgentPermissionModeStore } from "../../stores/agents/agentPermissionMode";

describe("agentPermissionMode store", () => {
  beforeEach(() => useAgentPermissionModeStore.setState({ modes: {}, dismissed: {} }));

  it("records each tab's mode by PTY id", () => {
    const store = useAgentPermissionModeStore.getState();
    store.note("p:a", "auto");
    store.note("p:b", "default");
    expect(useAgentPermissionModeStore.getState().modes).toEqual({ "p:a": "auto", "p:b": "default" });
  });

  it("keeps a dismissal while the tab stays in auto, and forgets it once the tab leaves auto", () => {
    const store = useAgentPermissionModeStore.getState();
    store.note("p:a", "auto");
    store.dismiss("p:a");
    store.note("p:a", "auto");
    expect(useAgentPermissionModeStore.getState().dismissed["p:a"]).toBe(true);
    store.note("p:a", "acceptEdits");
    expect(useAgentPermissionModeStore.getState().dismissed["p:a"]).toBeUndefined();
    store.note("p:a", "auto");
    expect(useAgentPermissionModeStore.getState().dismissed["p:a"]).toBeUndefined();
  });
});
