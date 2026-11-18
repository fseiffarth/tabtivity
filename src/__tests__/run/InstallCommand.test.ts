import { describe, expect, it } from "vitest";
import { containerBuildShell, customInstallShell, installShellCommand } from "../../lib/installCommand";

describe("containerBuildShell", () => {
  it("builds the container image through PowerShell on Windows, never cmd.exe", () => {
    expect(containerBuildShell(true)).toBe("powershell");
    expect(installShellCommand(containerBuildShell(true))).toBe("powershell.exe");
  });

  it("keeps bash elsewhere", () => {
    expect(containerBuildShell(false)).toBe("bash");
  });
});

describe("installShellCommand", () => {
  it("selects Bash explicitly for Bash installers", () => {
    expect(installShellCommand("bash")).toBe("/bin/bash");
  });

  it("selects PowerShell explicitly for PowerShell installers", () => {
    expect(installShellCommand("powershell")).toBe("powershell.exe");
  });

  it("leaves shell-neutral commands on the default shell", () => {
    expect(installShellCommand("default")).toBe("");
  });
});

describe("customInstallShell", () => {
  it("sends PowerShell syntax to PowerShell on Windows", () => {
    expect(customInstallShell("irm https://example.test/install.ps1 | iex", true)).toBe("powershell");
    expect(customInstallShell("$env:PATH += ';x'", true)).toBe("powershell");
  });

  it("keeps npm, pip and friends on the default shell", () => {
    expect(customInstallShell("npm install -g some-cli", true)).toBe("default");
  });

  it("never picks PowerShell off Windows", () => {
    expect(customInstallShell("irm https://example.test/install.ps1 | iex", false)).toBe("default");
  });
});
