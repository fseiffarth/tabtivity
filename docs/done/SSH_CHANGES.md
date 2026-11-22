> **Status (screened against code 2026-11-22):** SUPERSEDED, ARCHIVE/delete candidate. An early two-bullet note from the first SSH-project design (local-by-default agents, green "synced" rows). Remote projects are now documented in `context/remote_projects.md`, `help/remote-projects.md` and `remote_sync_guide.md`; agents default to the mirror for Remote and to the host for Remote-only projects.

## SSH remote Project automatically has a local connected project
- right panel file viewer is remote select folders files that should be synced to local project, snyced get light green background, while sync add animation (use rsync for sync?, something better os independent?)
- opening file in right file viewer automatically syncs to local
## Tabs
There are different types of tabs (different locations (local vs. remote)
### Agents
- agent tabs are local by default, but also remote agents (if agents can be installed on remote also remote is possible)
- thus agents act on the local project
### Terminals
- there are local and remote shell tabs, remote e.g., for running remote scripts
### Local Models
- same as agents for the moment
### File Viewer
- there is a local and remote file viewer, right panel add switch between local and remote (green are synced)