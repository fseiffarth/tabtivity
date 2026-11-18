# Voice

Dictation, read-aloud and hands-free in the agent pane's Chat, and the same
on the phone's Focus view. Plan and history: `docs/desktop_voice_plan.md`.

## Why the engine sits in the backend

The phone runs on Chrome's Web Speech API. The desktop webview cannot:
WebKitGTK has no `SpeechRecognition`, macOS WKWebView's is unreliable inside
an app, and only Windows WebView2 has one (online). So `services::voice`
captures the mic natively (`cpal`), segments it (`vad.rs`) and transcribes
with whisper.cpp (`stt.rs`), on the machine. The backend owns the audio; the
renderer owns the words: what is heard goes into the composer's draft, and
the composer's own `send()` is the only way out — slash commands,
subagent routing, the AI switch and the "sending" state behave as for a
typed prompt. The backend never sends a prompt.

A `voice:partial` is written into the draft at once as the segment's
*provisional* text (`lib/voice/provisionalDraft.ts`, glued to the composer by
`useLiveDictation`): one span per segment, at the end of the draft, replaced by
each newer partial (so a whole-segment or a tail transcript never doubles
text) and removed when the segment's final arrives, which is inserted where the
span stood. Partials bypass the composer's undo history, so Ctrl+Z and
"Tabby scratch that" only see settled finals, and `hasDraft` (the send guard)
counts only settled text. The renderer holds a partial back (it shows on the
"Heard:" line instead) while it may be a spoken edit (`mayEditDraft`), a spoken
send's words, or, in hands-free, a stop word or the answer to an open dialog.
A span tracks by offset and its own text: typing before it shifts it, after it
leaves it, inside it makes the words the user's own (the final is then not
typed again). A pause (the backend drops the open segment, no final comes), a
send and the session's end remove the spans still open.

## Why there is no `claude -p`

An earlier idea piped each utterance into `claude -p --continue` and spoke
the reply. The Chat already drives the live interactive session
(`sendSteeringPrompt`) and reads its stored transcript, so voice plugs into
that: it works the same for every CLI the Reader shows, keeps the session's
tools, permission mode and history, and launches nothing per utterance.

## Which device whisper runs on

Plain `voice` is the CPU. `voice-vulkan` (Linux, Windows) and `voice-metal`
(macOS) build a GPU backend in; they are not in `default`, because Vulkan needs
`glslc` at build time and links the loader. Bundles and the dev build turn them
on (`scripts/lib/voice_gpu.sh`). Both sit on `whisper-rs-sys`, not `whisper-rs`,
whose `vulkan` feature fails to compile where bindgen falls back to the bundled
bindings. Measurements and open risks: `docs/voice_gpu_plan.md`.

On Windows, `voice-vulkan` needs a target dir of about 22 characters or fewer.
whisper.cpp's shader generator is a nested cmake project, and MSBuild's file
tracker cannot write a log path of 260 characters: `FTK1011`, which cmake reports
as a broken C compiler. CI builds in `D:/a/t`; elsewhere set `CARGO_TARGET_DIR`.

Whisper never tells its caller where a load landed and carries on without a
GPU by itself, so `gpu.rs` reads the answer from its load log. The renderer
shows that `VoiceDevice`, never the `voice_gpu` setting. A state, made per
session, is what picks the backend, so a cached model still reports afresh.
`flash_attn` is on for the GPU only: whisper-rs defaults it off, and the
measured speed is with it.

Whisper runs in the app's process, so a driver crash ends the window. Before
each load and each session's first run a marker is written, and removed after;
one found that this run did not write means the step never came back, and
whisper stays on the CPU until the user picks **Try the GPU again**
(`voice_gpu_retry`). A clean quit clears only this run's own marker, or the
guard would be gone by the launch after the crash. The first crash still
happens, and the switch cannot stop ggml creating its Vulkan instance, which it
does on any use of whisper. That is also why Windows ships `vulkan-1.dll`
rather than delay-loading it: staying on the CPU would not avoid the call.

## Live preview (`voice:partial`)

Each partial is the transcript of the **whole** open segment, never a tail:
the renderer writes it straight into the input field and the final replaces it.
A short segment is re-run in full; past `Pacing::commit_tail` (6 s) the text
before the latest seam (a 400 ms pause the detector heard inside the segment,
`Vad::pause_marks`) is transcribed once, kept, and later partials run only on
what follows (`committed + tail`). The first partial is due as soon as the
segment opens; the next one a gap after the previous finished (half its run
time, 300–700 ms), so a GPU is asked about every 0.4 s and a slow CPU is not
swamped. The final stays one run over the whole segment (a seam is not a
sentence end). Plain dictate keeps its 700 ms closing pause: shorter would
split sentences at thinking pauses, and the field already shows the words.

## One listener per machine

The mic belongs to one Chat tab at a time (`voice::ACTIVE`); a new start
stops the old session, whose last final still arrives under its own id and
is ignored by the renderer. The header indicator shows the owner and stops
it. A hidden tab pauses its session (`voice_listen_pause`), keeping it.

## Half-duplex with the OS voice

Read-aloud speaks through the OS voice (SSIP to speech-dispatcher on Linux,
the `tts` crate elsewhere), which never shows Tabtivity the samples it plays,
so there is nothing to feed an echo canceller. While it speaks, plus a
300 ms tail, captured audio is thrown away (`session::GATE`): the speakers
can never dictate into the draft. **Headset mode** (a setting, off by
default) opens the gate for the session that asked for it — the voice is in
the user's ears — and speech that starts while the voice speaks stops it
(`SessionConfig::barge_in`). Only that session can close the gate again
(`set_headset` compares the session id), so an old session ending late
cannot undo a new one's mode. Barge-in through speakers needs a voice whose
samples Tabtivity sees (Piper, plan step 7).

## Natural voices (Piper)

The user found espeak on Ubuntu too poor (2026-11-05), so plan step 7's
Piper voices exist: `services::voice::piper`. The frozen MIT
`rhasspy/piper` 2023.11.14-2 binary (user's pick over piper1-gpl's Python
package and sherpa-onnx) runs as a **child process, never linked** — its
espeak-ng is GPL. One medium voice per app language, program and voices
fetched by an install tab from pinned URLs with embedded hashes into
`<state_dir>/voice/{piper,voices}/`. Not on macOS: the release's macOS
build is broken and macOS's own voices are good. One Piper process per
read (not per chunk: one model load), chunks one per stdin line, raw PCM
read from stdout and played through a `cpal` output stream that Tabtivity
owns — the samples an echo canceller would need. The mute gate still
applies (half-duplex), and echo cancellation is still open. `tts::ReadAloud`
picks per read: a natural voice when the `voice_natural` setting allows it
and one is installed for the language, else the OS voice, built lazily; a
Piper that will not start falls back to the OS voice for that read.

## The hands-free send guard

`shared/handsFree.ts`, one state machine for both the desktop and the phone:
a hands-free send is never immediate. After the pause a chime plays and a
~1.5 s window opens; "stop" (German "stopp"), the stop key or a click on the
line cancels it and keeps the draft. A spoken "stop" takes longer to settle
than the window lasts, so speech that starts inside the window *holds* it
and its settled text decides: a stop word cancels, other words join the
draft and the pause starts again. A stop word segment never reaches the
draft. "go on" is deliberate and skips the window. On the phone it also
leaves the mic open (`useComposer` `submitSpokenRef`); hands-free then holds
the turn's answers and closes the mic for them only while nothing is being
dictated (`useHandsFree`), so the voice is never dictated back.

## Spoken edits of the draft

"Tabby scratch that", "Tabby replace X by Y", "Tabby correction …", "Tabby
clear all", "Tabby plan" / "Tabby goal" edit the composer's draft on both
hosts (`lib/voice/draftEdit.ts`, matched by `voiceCommands.ts`
`matchDraftEdit`). The assistant's name in front is required, because "replace
the loop with a map" is an ordinary prompt; the name is matched loosely (one
letter off, first letter fixed: "Tabbi", "Tavi"). The rest must be one phrase
**whole**, never the nearest one, so "Tabby, plan the refactor" stays dictation.
Undo and restate work off voice's own history of the draft before and after
each piece. That history only holds while the draft is still what voice left
it: after typing it is dropped, rather than taking back text the user wrote.
In hands-free an edit restarts the pause, and an emptied draft sends nothing.

The desktop's voice detector already waits the pause before it closes a
segment (the backend's `handsFree` mode), so its guard opens the window as
soon as the segment settles; the phone's recognizer does not, so its guard
counts the pause itself.

## When a turn is over

Read-aloud speaks at the end of a turn, and hands-free opens the mic again
then — not at the first answer entry, since an agent that says something and
then runs a tool is still working. On the desktop (`lib/voice/agentTurn.ts`)
the agent's hook verdict decides (`done` or `decision`); only a tab with no
hook record falls back to its busy lamp going idle, which reads terminal
output and so can mistake a long quiet tool call for the end. **Popout
windows get no hook verdicts** (`noteAgentTurn` returns early there), so a
Chat in a popout runs on that fallback. A prompt typed while the agent works
waits in the CLI's queue, so the `done` of the turn already running is not
its turn's: the end must be of a turn begun after the send, or follow a new
answer.

The start of a turn is said too (the working row's words, once a turn). Only
a hook record names a turn (`agentTurnStartedAt`, which tool calls and
answered approvals do not move), so a tab with no hook record, a popout
included, stays quiet here: its lamp dims between tool calls and would repeat
it. One turn can write many answers, a record each; past three, only the last
is read.

The phone reads the busy row off the live screen (`agentWork`) rather than
polling the desktop's agent status, whose report may run the CLI for its
usage panel: the turn is over once the busy row was seen and is gone for
`TURN_SETTLE_MS`, or the agent waits on a question, or a new answer arrived
while it looks idle.

## The phone's limits

The phone's mic stays closed while it speaks: Chrome's recognizer is not
echo-cancelled against `speechSynthesis`, so there is no barge-in; a tap on
the line interrupts. The screen must stay on and the page open — Android
takes the mic from a hidden page — so working from a pocket would need a
native app.

## Spoken navigation on the phone (docs/voice_nav_mode_plan.md)

Inside the Focus mic, hands-free only. The dictation hook reads **utterances**,
not deltas (`voiceInput.ts` `stepUtterances`: Android finalizes one utterance
several times as it grows), so "starts with Tabby" and "Tabby navigate" are
judged on a settled utterance; `useVoiceInput`'s `dispatch` is the one ordered
route a held utterance takes (navigation mode → "Tabby navigate" → [spoken
draft edits] → the Tabby gate → hands-free's guard and `pick` → dictation).
`useVoiceNav` is the mode: it sets `utterances.capture` (nothing heard is
typed, the send guard is kept out), matches each utterance with
`match(..., { requireCommandWord: false })` against lists built from rows the
phone already holds (`voiceNav.ts`: `GET /projects`, `/projects/{id}`,
`/activity`; opaque ids only), says its answers always (read-aloud on or off),
half-duplex (mic closed while it speaks, reopened 300 ms after the voice falls
quiet), and closes after 10 s of quiet that does not count speaking time. The
three queues are Needs you's asking / finished groups (`needsYouGroups.ts`,
shared with the screen) and the working tabs in the Agents view's order; "again"
is a module cursor, a landing marks a done tab seen. A jump replaces the screen
(App keys `Terminal` by tab), so it leaves a one-shot note (`leaveLanding`,
30 s) that the new screen takes on mount (`useVoiceLanding`): once connected and
the stored session is in it says the last prompt, reads the answers after it
through the reading cursor (`readTurn(tab, sinceKey)`), then starts the mic with
the gate on. Hands-free's reopen of the mic defers to the open mode (`navOpen`).
The start word is exact (phonetic spelling plus `voice.assistantAliases`): a
fuzzy score let "taxi" and "toby" in.

## Where this goes: hands-free navigation

The goal is to use Tabtivity entirely by voice (plan step 9). Its rules, for
anything built before it:

- **One action set:** voice drives the keyboard-steering `SteeringAction`s
  through the same handler, never a parallel command system.
- **Phrases are i18n**, with a few argument forms ("project <name>").
- **Commands and dictation never mix silently**: in navigation mode an
  utterance is matched against phrases first; in a Chat composer it is
  dictation unless it starts with the command word; an unmatched utterance
  is said back, never typed.
- **Voice never types into a shell.**
- **Destructive actions need a spoken "confirm".**
- **It answers aloud** where you landed.
- **The mic follows focus, still with one owner** (`Owner::Window`).
