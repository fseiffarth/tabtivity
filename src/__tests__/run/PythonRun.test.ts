import { describe, it, expect } from "vitest";
import {
  buildDebugCommand,
  buildRunCommand,
  fileSideLocation,
  pyTabLabel,
  pythonRunPlan,
  runCwd,
  shellQuote,
  systemInterpreter,
} from "../../lib/terminal/pythonRun";
import { BRAND } from "../../lib/brand";

describe("shellQuote", () => {
  it("single-quotes on unix and escapes an embedded quote", () => {
    expect(shellQuote("/a/b c.py", "unix")).toBe("'/a/b c.py'");
    expect(shellQuote("it's.py", "unix")).toBe(`'it'\\''s.py'`);
  });

  it("double-quotes on windows (cmd.exe has no single-quote syntax)", () => {
    expect(shellQuote("C:\\a b\\x.py", "windows")).toBe('"C:\\a b\\x.py"');
    expect(shellQuote('a"b', "windows")).toBe('"a""b"');
  });
});

describe("systemInterpreter", () => {
  // Interpreter *selection* (venv/poetry/conda/pyenv precedence) lives in the
  // backend (`commands::python`) and is tested there — one ranking, one place.
  // What the frontend still owns is the last-resort fallback when the backend
  // can't be reached at all, so Run degrades instead of refusing.
  it("is the platform's system python", () => {
    expect(systemInterpreter("unix")).toBe("python3");
    expect(systemInterpreter("windows")).toBe("python");
  });
});

describe("buildRunCommand", () => {
  it("quotes both the interpreter and the file", () => {
    expect(buildRunCommand(".venv/bin/python", "/proj/a b/main.py", "unix")).toBe(
      "'.venv/bin/python' '/proj/a b/main.py'",
    );
  });

  it("appends the user's arguments verbatim after the file", () => {
    // The args are a raw shell string the host shell parses, not one quoted
    // token — so `--epochs 5 "out dir"` reaches the program as three arguments.
    expect(
      buildRunCommand("python3", "/proj/main.py", "unix", '--epochs 5 "out dir"'),
    ).toBe(`'python3' '/proj/main.py' --epochs 5 "out dir"`);
  });

  it("adds nothing for empty or whitespace-only args", () => {
    expect(buildRunCommand("python3", "/proj/main.py", "unix", "")).toBe(
      "'python3' '/proj/main.py'",
    );
    expect(buildRunCommand("python3", "/proj/main.py", "unix", "   ")).toBe(
      "'python3' '/proj/main.py'",
    );
  });
});

describe("buildDebugCommand", () => {
  const FILE = "/proj/main.py";

  it("pre-loads the breakpoints and runs straight to the first one", () => {
    expect(buildDebugCommand("python3", FILE, [12, 4], "unix")).toBe(
      "'python3' -m pdb -c 'b /proj/main.py:4' -c 'b /proj/main.py:12' -c 'continue' '/proj/main.py'",
    );
  });

  it("omits `continue` with no breakpoints, so pdb stops at the first line", () => {
    // With a trailing `continue` and nothing to break on, pdb would run the
    // program to completion — "debug" would be indistinguishable from "run".
    expect(buildDebugCommand("python3", FILE, [], "unix")).toBe(
      "'python3' -m pdb '/proj/main.py'",
    );
  });

  it("sorts and deduplicates the breakpoint lines", () => {
    const cmd = buildDebugCommand("python3", FILE, [9, 3, 9], "unix");
    expect(cmd.match(/-c 'b [^']+'/g)).toEqual([
      "-c 'b /proj/main.py:3'",
      "-c 'b /proj/main.py:9'",
    ]);
  });

  it("quotes a windows path (whose drive colon must survive pdb's file:line split)", () => {
    expect(buildDebugCommand("python", "C:\\p\\main.py", [7], "windows")).toBe(
      '"python" -m pdb -c "b C:\\p\\main.py:7" -c "continue" "C:\\p\\main.py"',
    );
  });

  it("passes the script's arguments after the file, as pdb expects", () => {
    expect(buildDebugCommand("python3", FILE, [12], "unix", "--verbose in.txt")).toBe(
      "'python3' -m pdb -c 'b /proj/main.py:12' -c 'continue' '/proj/main.py' --verbose in.txt",
    );
  });
});

describe("pyTabLabel", () => {
  it("names the tab after the file, marked by mode", () => {
    expect(pyTabLabel("run", "/proj/pkg/main.py")).toBe("main.py");
    expect(pyTabLabel("debug", "/proj/pkg/main.py")).toBe("main.py (debug)");
  });
});

describe("runCwd", () => {
  it("runs from the project root when there is one", () => {
    expect(runCwd("/proj", "/proj/pkg/main.py")).toBe("/proj");
  });
  it("falls back to the file's own directory outside a project", () => {
    expect(runCwd(null, "/tmp/scratch/main.py")).toBe("/tmp/scratch");
    expect(runCwd("", "/tmp/scratch/main.py")).toBe("/tmp/scratch");
  });
});

describe("fileSideLocation", () => {
  const HOST = "/scratch/me/proj";

  it("has no answer for a local project — there is no machine axis", () => {
    expect(fileSideLocation("/proj/main.py", null)).toBeUndefined();
    expect(fileSideLocation("/proj/main.py", "  ")).toBeUndefined();
  });

  it("reads a path under the host root as the host's", () => {
    expect(fileSideLocation(`${HOST}/pkg/main.py`, HOST)).toBe("remote");
  });

  it("reads everything else as local — the safe direction", () => {
    // Only a path we can PROVE is the host's may be sent to a shell on the host:
    // otherwise it either fails there or names a different file that happens to
    // exist at the same path.
    expect(fileSideLocation(`/state/${BRAND.slug}/p/mirror/main.py`, HOST)).toBe("local");
    expect(fileSideLocation("/tmp/elsewhere/main.py", HOST)).toBe("local");
    // A sibling directory sharing the root's prefix is NOT inside it.
    expect(fileSideLocation("/scratch/me/proj2/main.py", HOST)).toBe("local");
  });
});

describe("pythonRunPlan", () => {
  const HOST = "/scratch/me/proj";
  const DIR = `/state/${BRAND.slug}/p`;
  const MIRROR = `/state/${BRAND.slug}/p/mirror`;
  const remote = { projectDir: DIR, remotePath: HOST, localRoot: MIRROR };

  it("leaves a local project's runs alone (no machine axis)", () => {
    const plan = pythonRunPlan({ projectDir: "/proj", file: "/proj/pkg/main.py" });
    expect(plan.location).toBeUndefined();
    expect(plan.cwd).toBe("/proj");
    expect(plan.runPath).toBe("/proj/pkg/main.py");
    expect(plan.probeDir).toBe("/proj");
  });

  it("runs a mirror file LOCALLY when no machine was chosen", () => {
    // The reported bug: browsing the Local side of a remote project and clicking ▶
    // opened a tab with no explicit locality, and a shell tab defaults to the host.
    const plan = pythonRunPlan({ ...remote, file: `${MIRROR}/pkg/main.py` });
    expect(plan.location).toBe("local");
    expect(plan.cwd).toBe(MIRROR);
    expect(plan.runPath).toBe(`${MIRROR}/pkg/main.py`);
    // Probed locally too: a host venv is not on the mirror. The backend's
    // remoteness oracle is the directory, and the mirror matches no project entry.
    expect(plan.probeDir).toBe(MIRROR);
  });

  it("runs a mirror file locally even when a remote machine IS chosen", () => {
    // The dominance rule, and the whole second half of the bug: the preference is
    // persisted per project, so it is normally set from some earlier session on the
    // host side. It must not reach back and redirect a Run of a LOCAL file.
    for (const pref of ["remote", "host:w1"] as const) {
      const plan = pythonRunPlan({ ...remote, file: `${MIRROR}/pkg/main.py`, runHostPref: pref });
      expect(plan.location).toBe("local");
      expect(plan.cwd).toBe(MIRROR);
      expect(plan.runPath).toBe(`${MIRROR}/pkg/main.py`);
      expect(plan.probeDir).toBe(MIRROR);
    }
  });

  it("runs a host file on the host when no machine was chosen", () => {
    const plan = pythonRunPlan({ ...remote, file: `${HOST}/pkg/main.py` });
    expect(plan.location).toBe("remote");
    expect(plan.cwd).toBe(HOST);
    expect(plan.runPath).toBe(`${HOST}/pkg/main.py`);
    expect(plan.probeDir).toBe(DIR);
  });

  it("sends a HOST file to the chosen worker (the preference's one job)", () => {
    const plan = pythonRunPlan({
      ...remote,
      file: `${HOST}/pkg/main.py`,
      runHostPref: "host:w1",
    });
    expect(plan.location).toBe("host:w1");
    expect(plan.cwd).toBe(HOST);
    // Same side (host→host), so the browsed absolute path is valid there.
    expect(plan.runPath).toBe(`${HOST}/pkg/main.py`);
  });

  it("still honours an explicit ⌂ Local for a host file — the one crossing left", () => {
    const plan = pythonRunPlan({
      ...remote,
      file: `${HOST}/pkg/main.py`,
      runHostPref: "local",
    });
    expect(plan.location).toBe("local");
    expect(plan.cwd).toBe(MIRROR);
    expect(plan.runPath).toBe("pkg/main.py");
    expect(plan.probeDir).toBe(MIRROR);
  });

  it("passes a path under neither root through untouched, and runs it locally", () => {
    // Not provably the host's ⇒ local (the safe direction), and there is nothing
    // sensible to relativize against — let the shell report the truth rather than
    // invent a path.
    const plan = pythonRunPlan({ ...remote, file: "/tmp/x/main.py", runHostPref: "remote" });
    expect(plan.location).toBe("local");
    expect(plan.runPath).toBe("/tmp/x/main.py");
  });

  it("falls back to the project dir when a remote project has no mirror root", () => {
    const plan = pythonRunPlan({ projectDir: DIR, remotePath: HOST, file: `${DIR}/main.py` });
    expect(plan.location).toBe("local");
    expect(plan.cwd).toBe(DIR);
  });
});
