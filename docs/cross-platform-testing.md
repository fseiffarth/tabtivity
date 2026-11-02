# Tabtivity cross-platform test checklist

Use a separate copy for each OS/build. Start with sections 1–4: they cover the
CLI download/install buttons, Ollama installation/upgrades, and local model pulls.
An unchecked box means **not tested**. Check a box only when its expected result
passes; record failures, blocked tests and N/A cases in the results table below.

## Test run

- Date / tester:
- App version / build or commit:
- OS version / architecture:
- Linux session: X11 / Wayland:
- CPU / RAM / GPU / driver:
- Install type: fresh / upgrade:
- Shell / package manager:

Repeat on Windows and macOS; keep Linux X11 and Wayland results separate. Record
Apple Silicon and Intel Macs separately if both are tested. Use a disposable test
project and test downloads. For clean-install cases, use a fresh OS account or VM
instead of removing working tools or models from your normal account. Restarts in
this checklist are steps for the tester to perform when ready.

Main entry points: **Models & agents** (brain button; click for the full overlay,
hover for its menu), **Settings → Agents → Manage CLIs**, **Settings → Ollama**,
and the first-run setup pages. Repeat shared actions through each entry point
where that action is offered.

## 1. App installation and first run

- [ ] Install the package for this OS/architecture; launch from the OS launcher without a terminal. No missing-library error, blank window or immediate crash.
- [ ] First-run pages render correctly; Next, Back, Skip and external links work. Skipping agent/model setup still allows opening a project.
- [ ] Upgrade an existing test installation. Projects, tabs, settings and saved connections survive; the displayed app version changes.
- [ ] Settings → Updates can check for a release. If one is available, download/install and the explicit restart flow work; otherwise record the install part as not tested.

## 2. Agent CLI download/install buttons — repeat for every listed CLI

Do not infer that all CLI buttons work because one does. Run the checks below
for every row in Manage CLIs, recording the CLI name and version in the results.

- [ ] Detection distinguishes installed and missing CLIs, including tools installed in a user-local directory. The displayed version matches the executable actually launched.
- [ ] Each Install button opens a visible root-console terminal and **runs** the installer once. It selects the correct shell for the OS; passwords, licence prompts and errors are visible and answerable.
- [ ] Each Download / documentation link opens the correct page in the default browser. If automatic installation is unavailable on this OS, the fallback is usable and the UI does not claim success.
- [ ] On a clean account missing Node/npm or another required runtime, the prerequisite flow works; afterward the CLI installer succeeds. A missing dependency produces useful guidance.
- [ ] After installation, refresh/recheck detects the CLI and enables it in the new-tab menu. Also check a fresh app launch so detection does not depend on the install terminal's temporary PATH.
- [ ] A new CLI tab opens in the correct project. Browser/device-code sign-in completes; a short prompt gets an answer. Cancelled sign-in leaves a usable retry path.
- [ ] An offered CLI update action succeeds and detection shows the new version. If no update is available, record that the upgrade itself was not tested.
- [ ] Close the root-console overlay during an install, then reopen it: the install tab and its output remain accessible. A failed or cancelled install can be retried without a false Installed state.
- [ ] Resume/reopen an agent conversation after a tester-controlled app restart. The intended conversation and project return.

## 3. Ollama installation, start and upgrade

- [ ] With Ollama absent, both first-run setup and Settings show it as missing. Install opens a terminal, runs the OS-appropriate installer, and exposes any elevation prompt; the Download link also works.
- [ ] After installation, the app detects Ollama. Distinguish **installed but stopped** from **not installed**; Start brings the server online and reveals the model list.
- [ ] With Ollama already running, opening the panel or clicking Start does not create a second server or an endless startup spinner.
- [ ] Check for updates from the header menu, Models & agents and Settings → Ollama. Installed/latest versions and the update verdict agree across these views.
- [ ] With an older Ollama on a test machine, click Upgrade. A visible terminal runs the upgrade; afterward the detected **running server** version changes, existing models remain available, and a model can still answer.
- [ ] Cancel or fail an install/upgrade, then retry. The error is visible and the app never reports an upgrade that did not finish.
- [ ] With the internet unavailable, update checks finish with an error rather than “up to date”; already installed local models remain usable while the local server is running.

## 4. Local model search, pulling and storage

- [ ] Browse/search the model registry; filters, sort, variant/tag selection and loading more results work. The chosen tag's size/capabilities are displayed without stale results from a previous search.
- [ ] Pull a small local model from first-run setup and from the Ollama/model UI. Progress updates through download, verification and completion; the exact selected model/tag appears in the installed list.
- [ ] While pulling, switch between Settings, the overlay and the header menu. The same download/progress appears; closing a panel does not cancel it or start it again.
- [ ] Pause a pull, then Resume. Progress stops while paused and resumes using the partial download. Repeated clicks do not create duplicate jobs.
- [ ] Interrupt a test pull by quitting the test app, then reopen it. The interrupted download is offered for continuation and finishes successfully.
- [ ] Delete a paused partial download using its delete action. It disappears and can be downloaded again; unrelated installed models remain intact.
- [ ] Try a nonexistent model/tag and a disconnected network. The error is visible, progress settles, and retry succeeds once the problem is corrected.
- [ ] In a disposable VM, test insufficient disk space or an unwritable model location. Failure is reported without a completed model entry; recovery/retry works after restoring space/access.
- [ ] Choose a custom models directory, including a path with spaces/non-ASCII characters. Follow any offered service-apply step, then pull and load a test model; verify the running server actually uses that directory. Existing models are not silently moved or deleted.
- [ ] Check for model updates and update a model when one is available. The update uses the normal pull/progress flow; the updated model still loads. If none is available, mark the update itself not tested.
- [ ] Delete an installed test model, first cancelling any confirmation and then accepting it. Cancel preserves it; accepting removes only that model from disk and all model lists.
- [ ] Cloud-tagged models are labelled as cloud and never presented as downloaded, resident local models.

## 5. Using local models

- [ ] Load and unload an installed model. Running/idle status agrees across the header menu, overlay and Settings; unloading releases its allocation as reported by Ollama.
- [ ] On GPU hardware, test Auto and each offered CPU/GPU choice. The model answers and reported residency matches the actual device; unavailable GPU support is explained. Repeat on a CPU-only machine where available.
- [ ] Try loading a model too large for the test machine. The app remains responsive, reports failure, and allows loading a smaller model afterward.
- [ ] Assign models to Tabs, code autocomplete and prose autocomplete. Each applicable feature uses the selected model; assignments survive a tester-controlled restart. Test other role switches only where the UI says they are wired.
- [ ] Install the local-agent runtime through its button where offered. Open a Local model tab through +, send a prompt, and have it read/edit a harmless file in the disposable project. No cloud login is required for the local-model path.
- [ ] Test load-at-start, then Energy Saver behavior with and without its explicit autoload override. The chosen policy survives restart and is respected.
- [ ] Stop the test Ollama server while a model view is open. The app shows the loss of connection, stays usable, and recovers after Start/reconnection.
- [ ] CPU/RAM/GPU meters show plausible readings while a model answers. An unavailable sensor is omitted or identified as unavailable rather than shown as a real zero.

## 6. Terminal, keyboard and agent integration

- [ ] Open a shell tab; check its working directory and shell, run a harmless command, and resize/split/pop out the pane. No missing text, broken prompt or unusable input.
- [ ] Test Ctrl+C, arrows, Home/End, Tab, Unicode, selection, copy/paste, multiline paste and long wrapped output. Use the UI's documented shortcuts for the OS.
- [ ] An agent's browser login and clickable terminal URLs open the default browser. File links open the intended project file, including paths with spaces/non-ASCII characters.
- [ ] Terminal and Reader views show the same conversation; sending, stopping a response and switching views work for the CLIs being tested.
- [ ] Close/kill a test terminal running a harmless child process. Its whole child tree exits; unrelated terminals keep running.
- [ ] In a test agent tab, inspect HOME and create a harmless project file. HOME belongs to the app's scoped agent home, the project is writable, and other projects' private state is inaccessible. A missing/unusable fence gives an explicit failure rather than silently launching unfenced.
- [ ] Ask an agent to send a small test image/PDF using `tabtivity-send`. The file reaches the screen used for input and opens correctly.

## 7. Projects, files and desktop UI

- [ ] Create/open a project under a path with spaces/non-ASCII characters. Rename it, switch projects, close/reopen the app as tester, and verify tabs and settings restore to the right project.
- [ ] Create/edit/save/rename/delete disposable files; cancel a delete first. File picker, drag/drop, reveal in file manager and external-open actions target the correct path.
- [ ] Preview text, image and PDF files; edit a YAML/table fixture. Content saves correctly and existing comments, quoting and line endings survive.
- [ ] In a disposable git repository, view status/diff, commit, switch branches and use the configured test remote. Changes remain attached to the correct project.
- [ ] Test light/dark themes, menus, tooltips and portaled dialogs. Text stays readable, keyboard focus works, and Escape/click-away closes the intended layer.
- [ ] Test window resize, maximize/fullscreen, split panes, popouts, multiple monitors and display scaling. Dialogs remain reachable and controls remain usable after moving between screens.
- [ ] Suspend/resume the OS. Terminals, model status and connected panes recover without a frozen window or repeated error loop.

## 8. Remote and phone checks, if used

- [ ] Connect to a test SSH host; open its files and terminal. Saved credentials follow the selected remember policy; disconnect/reconnect recovers without freezing the app.
- [ ] Open a remote project and a local-model tab. The model runs on the local machine; it is not accidentally launched or installed on the remote host.
- [ ] Use a supported container/VM project. Project paths, terminals and local-model routing are correct; unsupported platform features are clearly unavailable.
- [ ] Pair the phone PWA; list projects, attach a terminal, send a prompt and receive a file. Changes appear on desktop and phone without duplicate messages.
- [ ] With phone model access enabled, list installed models, Load, Unload and Start Ollama. Desktop/phone status agrees. Disable that access and verify phone actions are refused; the phone offers no model download/delete controls.

## Results and intentional platform differences

Keep one row per failure/blocked test and one row per tested CLI. Use **PASS**,
**FAIL**, **BLOCKED**, **N/A** or **NOT TESTED**; include the failing button,
expected/actual result and a screenshot or terminal error when useful. A release
with no available update does not count as a passed upgrade-install test.

| OS / architecture / display session | Check / CLI + version | Result | Notes / evidence / issue |
| --- | --- | --- | --- |
| | | | |

The opening notes in [Group H](../todo/group-h-crossplatform.md) describe
intentional differences: external-window embedding and sticky windows are not
supported on Windows/macOS; macOS foreign-app parking is app-wide; Windows has
no SSH ControlMaster-based link monitor; both have an interfaces-only network
pane. Verify the stated fallback and mark the unsupported capability N/A. Do not
mark a broken install, model pull or agent launch N/A just because it fails on
one OS. This document records a test plan, not live verification.
