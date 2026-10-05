/**
 * Sign-in tabs (`lib/agents/signInLaunch`): which login command each CLI's
 * tab runs, its other way in, and that the tab is never one restore could
 * relaunch into a second sign-in.
 */
import { describe, expect, it } from "vitest";
import { loginIdForCmd, signInLaunch } from "../../lib/agents/signInLaunch";
import { AGENT_ITEMS, buildSignInTabSpec } from "../../components/tabs/newTabItems";
import { isRestorableTab } from "../../stores/tabs";
import { envName } from "../../lib/brand";

const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;
const item = (cmd: string) => AGENT_ITEMS.find((entry) => entry.cmd === cmd)!;

describe("sign-in launches", () => {
  it("run each CLI's own login command in the flow a phone can finish", () => {
    expect(signInLaunch("claude")).toMatchObject({ args: ["auth", "login", "--claudeai"], exits: true });
    expect(signInLaunch("codex")).toMatchObject({ args: ["login", "--device-auth"], exits: true });
    expect(signInLaunch("copilot")).toMatchObject({ args: ["login", "--device-code"], exits: true });
    expect(signInLaunch("cursor-agent")).toMatchObject({ args: ["login"], env: { NO_OPEN_BROWSER: "1" }, exits: true });
    expect(signInLaunch("gemini")).toMatchObject({ args: [], env: { NO_BROWSER: "true" }, exits: false });
  });

  it("take the other way in where a CLI has one, and the default where not", () => {
    expect(signInLaunch("claude", true)).toEqual({ args: ["auth", "login", "--console"], exits: true });
    expect(signInLaunch("codex", true)).toEqual({ args: ["login"], exits: true });
    expect(signInLaunch("copilot", true)).toMatchObject({ args: ["login", "--device-code"] });
    expect(signInLaunch("claude").alternate?.kind).toBe("console");
    expect(signInLaunch("codex").alternate?.kind).toBe("browser");
  });

  it("are a plain launch for a CLI that signs in as it starts", () => {
    expect(signInLaunch("agy")).toEqual({ args: [], exits: false });
    expect(signInLaunch("droid")).toEqual({ args: [], exits: false });
    expect(signInLaunch("toString")).toEqual({ args: [], exits: false });
  });

  it("name the login store the way agent_auth does", () => {
    expect(loginIdForCmd("agy")).toBe("antigravity");
    expect(loginIdForCmd("kiro-cli")).toBe("kiro");
    expect(loginIdForCmd("claude")).toBe("claude");
    expect(loginIdForCmd("toString")).toBe("toString");
  });

  it("build a tab with no session id, labelled as a sign-in only when it ends with the login", () => {
    const spec = buildSignInTabSpec(item("claude"), signInLaunch("claude"), "/p", t);
    expect(spec).toMatchObject({ label: "newTabMenu.signInTabLabel(Claude)", cmd: "claude", args: ["auth", "login", "--claudeai"], cwd: "/p", kind: "agent" });
    expect(spec.sessionId).toBeUndefined();
    expect(spec.env).not.toHaveProperty(envName("TAB_UID"));
    expect(isRestorableTab(spec)).toBe(false);
    expect(spec.signIn).toBe(true);
    const gemini = buildSignInTabSpec(item("gemini"), signInLaunch("gemini"), "/p", t);
    expect(gemini).toMatchObject({ args: [], env: { NO_BROWSER: "true" } });
    expect(gemini.label).not.toContain("signInTabLabel");
  });
});
