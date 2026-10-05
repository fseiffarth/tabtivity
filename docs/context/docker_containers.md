# Docker project containers

Referenced from `AGENTS.md`.

**A project can run in a container** (#38, `services::sandbox`): with the pill's "Run this project in a
container" toggle on, every shell/agent tab `docker exec`s into ONE
session-lived, capability-dropped container (`tabtivity-<id>`); `local_agent`
tabs stay on the host. The project dir stays on the host, bind-mounted at its
**identical absolute path** — file tree/git/viewers/usage watcher keep reading
host bytes, and agent resume keeps working — which is what makes it a toggle,
not a data move. Container lifetime = project session (created on
activation/first spawn; removed on deactivate *unless tabs are still live in
it*, at exit, and swept at startup). The toggle is spec-preserving (knobs in
the pill's "Container settings…" survive off/on), the first enable
auto-adopts an in-repo `Dockerfile`/devcontainer image, and a missing image
becomes a one-click build tab. Flipping the toggle respawns every live tab —
the pill confirms when a non-resumable agent conversation would be lost.
Local projects only. On Windows (Docker Desktop) every host path crossing into
the Linux container is spelled `C:\x` → `/c/x` by `sandbox::container_path` at
the argv layer only, so the mount planners keep reasoning in host paths;
`--user` is omitted (Docker Desktop maps bind-mounted files to the Windows
user anyway), and the staged Claude/Codex configs point at a POSIX twin of the
PowerShell SessionStart hook so in-container resume records still land.

**What it applies to is a second choice** (`SandboxSpec.scope`, the pill's
"What runs in the container"), because the container's job is to keep *the
agent* away from the rest of the machine and a project's other tabs are the
user's own hands. `All` is the strict reading and the default — an older spec
with no `scope` key deserializes to it, so no project loses containment on
upgrade. `Agents` contains agent tabs only and leaves shells, scripts and the
viewer's Run/Debug on the host.

That option exists because of a failure that reads as a broken Run button. A
venv is **not self-contained**: `bin/python` is a symlink to the base
interpreter recorded in `pyvenv.cfg`, and identical-path mounting brings the
`.venv` directory in while leaving that interpreter on the host. So the venv is
right there, fully readable, and headless — and the reference image (`node:22`)
carried no Python at all, so the fallback did not exist either. Three answers,
and they are deliberately separate: the image now ships `python3` (an agent that
cannot run Python in a Python project fails at its first attempt to check its
own work — that one is independent of scope); `commands::python` probes **inside
the container** for a `scope: All` project, using the *same* script the remote
branch runs, so a venv whose base interpreter is missing is skipped rather than
handed over as a dangling symlink; and `Agents` is the way to keep the host
toolchain — venv, conda, pyenv — without turning the container off.

Classification is by **the command that actually executes** (`is_agent_cmd`,
reading `commands::agents::AGENTS` so the classifier and the + menu are one
list), not by a tab `kind` the renderer sends: `kind` is a label, `cmd` is the
argv. The scope **narrows and never grants** — it is read only after the toggle
has already said yes — and it lives in the state-dir mirror like the rest of the
spec, so it is not a spec the renderer can write. `CenterPanel` keeps a copy of
the rule for the one thing the backend cannot do: the flag is a spawn
dependency, so changing the scope respawns exactly the tabs whose side changed
(without it, a shell would go on running inside the container after the switch).

What `Agents` costs, stated in the dialog rather than buried: the agent still
writes into the project folder, so a script it wrote is one ▶ click from the
whole machine. It cannot take that step by itself — no in-project file is read
back as executable intent since session state moved to the state dir
(`docs/sandbox_hardening_plan.md` Phase 1) — but it is a human-in-the-loop
boundary, not a mechanical one. For code expected to be *hostile* rather than
merely unreviewed, the container is the wrong tier and
`docs/vm_projects_plan.md` is the right one: it shares no filesystem at all.

**It is also asked at creation** (`ProjectDialog`), because that is the one
moment it is free: flipping it later restarts every tab. The row defaults **on
for an import** (a folder, a clone, a fork — code the user hasn't read, whose
build scripts and agent-facing docs are about to run) and **off for a new
project** (nothing to contain yet, and the image/toolchain cost would be paid
for a folder holding a README). An explicit choice sticks; the same
`set_project_sandbox` + preflight the pill's toggle uses runs before the
project reaches the store, so activation already warms the right container.

**Claude transcripts are the one cross-project mount**, and the rule is *read
every project, write only our own*. `~/.claude/projects` is keyed by encoded
cwd, not by Tabtivity project, so it is mounted **per entry, explicitly**: this
project's transcript dirs rw, **every other project's `:ro`**. Reading another
project's history is allowed; rewriting one is not — the rewritten log is what
an *uncontained* future session reads back as its own history. Membership comes
from the `cwd` recorded **inside** a transcript, never from decoding the dir
name (that encoding maps both `/` and `.` to `-`, so `…-proj-panel` is either a
subdir of `proj` or the sibling project `proj-panel`). A cwd with no host dir at
create time has nothing to mount, so the mount *parent* is a per-project stage
dir: the new transcript lands there and teardown harvests it into the real
`~/.claude/projects`. The transcript set is deliberately **excluded from the
spec fingerprint** — it changes whenever any project gains a dir, and a
fingerprint mismatch means recreate, i.e. an unrelated project's agent could
otherwise kill every live tab of this one.
