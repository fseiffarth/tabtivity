import { describe, expect, it } from "vitest";
import { shellRunCommand, shellScriptRunPlan } from "../../lib/terminal/shellScriptRun";
import type { ProjectEntry } from "../../types";

const remoteProject: ProjectEntry = {
  id: "demoproj",
  name: "demoproj",
  status: "active",
  position: 0,
  local_file: "/state/demoproj/project.json",
  directory: "/state/demoproj",
  remote: {
    user: "alice",
    host: "gpu",
    remote_path: "/home/alice/demoproj",
  },
};

describe("shell script run planning", () => {
  it("runs a remote-source script relative to the host project root", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj",
      syncSource: "remote",
      scriptPath: "/home/alice/demoproj/install.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({
      cwd: "/home/alice/demoproj",
      scriptRel: "install.sh",
      initialInput: "bash 'install.sh'",
      location: "remote",
    });
  });

  it("runs a local-source script relative to the mirror and pins local locality", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/state/demoproj/mirror/install.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({
      cwd: "/state/demoproj/mirror",
      scriptRel: "install.sh",
      initialInput: "bash 'install.sh'",
      location: "local",
    });
  });

  it("runs on the chosen worker machine when a run-host preference is set", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj",
      syncSource: "remote",
      scriptPath: "/home/alice/demoproj/train.sh",
      interp: "bash",
      runHostPref: "host:worker1",
    });

    // For a HOST-side script the preference picks which remote machine; the script
    // path stays project-relative so it resolves against that host's own project
    // root (the backend re-cds into the worker's remote_path).
    expect(plan).toMatchObject({
      cwd: "/home/alice/demoproj",
      scriptRel: "train.sh",
      initialInput: "bash 'train.sh'",
      location: "host:worker1",
    });
  });

  it("keeps a mirror-browsed script LOCAL even with a worker chosen", () => {
    // The browsed side is dominant (`lib/terminal/pythonRun`'s `pythonRunPlan` carries the
    // reasoning): the preference is persisted per project, so it is normally set
    // from some earlier session on the host side, and it must not reach back and
    // redirect a Run of a file the user is looking at on the local mirror.
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/state/demoproj/mirror/train.sh",
      interp: "bash",
      runHostPref: "host:worker1",
    });

    expect(plan).toMatchObject({
      cwd: "/state/demoproj/mirror",
      scriptRel: "train.sh",
      location: "local",
    });
  });

  it("keeps a mirror path local even if syncSource never arrives", () => {
    // The prop has to be threaded correctly through five components to be true;
    // the path is a fact. A mirror-side script is local whatever `syncSource` says
    // (here: absent, which used to read as "browsing the host" and put an `ssh`
    // tab on screen for a file sitting on this machine).
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      scriptPath: "/state/demoproj/mirror/train.sh",
      interp: "bash",
      runHostPref: "remote",
    });

    expect(plan).toMatchObject({
      cwd: "/state/demoproj/mirror",
      scriptRel: "train.sh",
      location: "local",
    });
  });

  it("keeps a host path remote even if syncSource says local", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj/mirror",
      syncSource: "local",
      scriptPath: "/home/alice/demoproj/train.sh",
      interp: "bash",
    });

    expect(plan).toMatchObject({ cwd: "/home/alice/demoproj", location: "remote" });
  });

  it("refuses to build bash with an empty script path", () => {
    expect(
      shellScriptRunPlan({
        project: remoteProject,
        treeRoot: "/state/demoproj",
        syncSource: "remote",
        scriptPath: "/tmp/install.sh",
        interp: "bash",
      }),
    ).toBeNull();
  });

  it("appends the run arguments verbatim after the quoted script", () => {
    const plan = shellScriptRunPlan({
      project: remoteProject,
      treeRoot: "/state/demoproj",
      syncSource: "remote",
      scriptPath: "/home/alice/demoproj/train.sh",
      interp: "bash",
      args: '  --epochs 5 "out dir"  ',
    });

    expect(plan?.initialInput).toBe(`bash 'train.sh' --epochs 5 "out dir"`);
  });

  it("leaves the command bare when the arguments are blank", () => {
    expect(shellRunCommand("bash", "a.sh", "   ")).toBe("bash 'a.sh'");
    expect(shellRunCommand("powershell", "b.ps1", "-Name x")).toBe('powershell -File "b.ps1" -Name x');
    expect(shellRunCommand("cmd", "c.bat", "one")).toBe('cmd /c "c.bat" one');
  });

  it("quotes for the Windows interpreters the way their shells read it", () => {
    // PowerShell and cmd only ever run on Windows (`shellRunnerFor`), where the
    // tab's shell is cmd or PowerShell: neither strips `'…'`, both read `"…"`
    // with `""` doubling. The POSIX shells keep `'…'`.
    expect(shellRunCommand("cmd", "C:\\p\\run.bat")).toBe('cmd /c "C:\\p\\run.bat"');
    expect(shellRunCommand("powershell", 'tools\\say "hi".ps1')).toBe('powershell -File "tools\\say ""hi"".ps1"');
    expect(shellRunCommand("bash", "it's.sh")).toBe("bash 'it'\\''s.sh'");
  });

  it("relativizes a native Windows script path against a Windows root", () => {
    const winProject: ProjectEntry = {
      id: "winproj",
      name: "winproj",
      status: "active",
      position: 0,
      local_file: "C:\\state\\winproj\\project.json",
      directory: "C:\\state\\winproj",
    };
    const plan = shellScriptRunPlan({
      project: winProject,
      treeRoot: "C:\\state\\winproj",
      scriptPath: "C:\\state\\winproj\\scripts\\run.bat",
      interp: "cmd",
    });
    // The script path stays project-relative (the backend's `/` convention) so
    // the tab's cwd resolves it; only the quoting is Windows'.
    expect(plan).toMatchObject({
      cwd: "C:\\state\\winproj",
      scriptRel: "scripts/run.bat",
      initialInput: 'cmd /c "scripts/run.bat"',
    });
    expect(plan?.location).toBeUndefined();
  });
});
