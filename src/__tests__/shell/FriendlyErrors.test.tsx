import { describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { friendlyError } from "../../lib/errors";
import { translate, type TranslationKey } from "../../lib/i18n";
import { ErrorNote } from "../../components/common/ErrorNote";
import { BRAND } from "../../lib/brand";

const t = (key: TranslationKey) => translate("en", key);
const summaryKey = (raw: string) => {
  const hit = friendlyError(raw, (k) => k);
  return hit?.summary ?? null;
};

describe("friendlyError", () => {
  it.each([
    ["ssh: user@host: Permission denied (publickey,password).", "errors.sshAuth"],
    ["Host key verification failed.", "errors.sshHostKey"],
    ["ssh: Could not resolve hostname nope: Name or service not known", "errors.dns"],
    ["Connection refused (os error 111)", "errors.refused"],
    ["ssh: connect to host h port 22: Connection timed out", "errors.timeout"],
    ["No route to host (os error 113)", "errors.unreachable"],
    ["Permission denied (os error 13)", "errors.permission"],
    ["No such file or directory (os error 2)", "errors.notFound"],
    ["File exists (os error 17)", "errors.exists"],
    ["No space left on device (os error 28)", "errors.diskFull"],
    ["fatal: not a git repository (or any of the parent directories): .git", "errors.notGitRepo"],
    [" ! [rejected]        develop -> develop (fetch first)", "errors.pushRejected"],
    ["error: Your local changes to the following files would be overwritten by merge:", "errors.localChanges"],
    ["CONFLICT (content): Merge conflict in a.txt", "errors.mergeConflict"],
    ["fatal: Authentication failed for 'https://example.invalid/r.git/'", "errors.authFailed"],
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock.", "errors.dockerDown"],
    ["command git_search_history not found", "errors.backendOutdated"],
    ["bash: rsync: command not found", "errors.programMissing"],
  ])("%s → %s", (raw, key) => {
    expect(summaryKey(raw)).toBe(key);
  });

  it("words a remote-only refusal wherever it surfaces, even one that also names a file error", () => {
    const raw = `${BRAND.upper}_REMOTE_ONLY: moving the mirror: this project keeps no local copy (os error 2)`;
    expect(summaryKey(raw)).toBe("tabs.remoteOnlyRefused");
    expect(summaryKey("REMOTE_ONLY: something")).toBeNull();
  });

  it("keeps the raw text as the detail", () => {
    const raw = "Permission denied (os error 13)";
    expect(friendlyError(raw, t)).toEqual({ summary: t("errors.permission"), detail: raw });
  });

  it("does not claim errors distinguished only by a longer errno", () => {
    // os error 1 is EPERM; 10, 12, 21 … are other causes and must not match it.
    expect(summaryKey("Cannot allocate memory (os error 12)")).toBeNull();
    expect(summaryKey("Is a directory (os error 21)")).toBeNull();
  });

  it("leaves unknown and already-friendly text alone", () => {
    expect(summaryKey("The project name is empty.")).toBeNull();
    expect(summaryKey("Der Projektname ist leer.")).toBeNull();
  });

  it("has a real English string for every rule", () => {
    for (const raw of ["Permission denied (os error 13)", "Host key verification failed."]) {
      expect(friendlyError(raw, t)?.summary.startsWith("errors.")).toBe(false);
    }
  });
});

describe("ErrorNote", () => {
  it("renders an unknown error verbatim in the caller's element", () => {
    const { container } = render(<ErrorNote className="x-error" as="p" error="Name is taken" />);
    const el = container.querySelector("p.x-error");
    expect(el?.textContent).toBe("Name is taken");
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the summary and reveals the raw text on Details", () => {
    const raw = "No such file or directory (os error 2)";
    const { container, getByRole } = render(<ErrorNote className="x-error" role="alert" error={raw} />);
    const el = container.querySelector("div.x-error[role=alert]");
    expect(el?.textContent).toContain(t("errors.notFound"));
    expect(el?.textContent).not.toContain(raw);
    const toggle = getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(container.querySelector(".error-note-raw")?.textContent).toBe(raw);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
