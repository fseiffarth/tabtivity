# Voice

Dictation, read-aloud and hands-free in the agent pane's Chat, and the same
on the phone's Focus view. Plan and history: `docs/desktop_voice_plan.md`.

## Why the engine sits in the backend

The phone runs on Chrome's Web Speech API. The desktop webview cannot:
WebKitGTK has no `SpeechRecognition`, macOS WKWebView's is unreliable inside
an app, and only Windows WebView2 has one (online). So `services::voice`
captures the mic natively (`cpal`), segments it (`vad.rs`) and transcribes
with whisper.cpp (`stt.rs`), on the machine. The backend owns the audio; the
renderer owns the words: `voice:final` text goes into the composer's draft,
and the composer's own `send()` is the only way out — slash commands,
subagent routing, the AI switch and the "sending" state behave as for a
typed prompt. The backend never sends a prompt.

## Why there is no `claude -p`

An earlier idea piped each utterance into `claude -p --continue` and spoke
the reply. The Chat already drives the live interactive session
(`sendSteeringPrompt`) and reads its stored transcript, so voice plugs into
that: it works the same for every CLI the Reader shows, keeps the session's
tools, permission mode and history, and launches nothing per utterance.

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

## The hands-free send guard

`shared/handsFree.ts`, one state machine for both the desktop and the phone:
a hands-free send is never immediate. After the pause a chime plays and a
~1.5 s window opens; "stop" (German "stopp"), the stop key or a click on the
line cancels it and keeps the draft. A spoken "stop" takes longer to settle
than the window lasts, so speech that starts inside the window *holds* it
and its settled text decides: a stop word cancels, other words join the
draft and the pause starts again. A stop word segment never reaches the
draft. "go on" is deliberate and skips the window.

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
