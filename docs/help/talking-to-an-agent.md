---
id: talking-to-an-agent
title: Talking to an agent (dictation, read-aloud, hands-free)
keywords: [voice, dictate, dictation, microphone, mic, speech, speech model, whisper, read aloud, read-aloud, speak, voice language, hands-free, handsfree, headset, stop word, go on, los, chime, barge-in, talk]
related: [agent-clis, mobile, keyboard, settings-and-appearance]
---

The agent pane's **Chat** view can be talked to: dictate a prompt, hear the
answer read aloud, and — as an experiment — go back and forth hands-free.
The phone's Focus view can do the same with the phone's own speech.

## Dictating in the Chat

The mic button beside **Send** (or **Ctrl+Shift+D**) starts dictation on this
computer's own speech engine: nothing you say leaves the machine. The first
time, it offers to install a speech model (Settings → Voice picks which one:
base, small or large) in a tab, one click. While you speak, **Heard:** shows
what it understood; each finished sentence lands in the text box, where
Ctrl+Z takes it back. End with **"go on"** (German **"los"**) to send without
those words, or press Send.

Only one tab listens at a time: starting the mic in another tab stops it in
the first, and the red mic in the header shows which tab has it — a click
there stops it. A hidden tab's mic pauses until the tab is shown again.

Settings → Voice also sets the language you dictate in (the app's language
unless you pick another).

## Read-aloud

The **Read aloud** chip under the conversation says when the agent starts
working ("Opus is working") and speaks each new answer with the system voice
once the agent's turn has ended. A turn that wrote more than three messages
is read by its last one. Code blocks are announced, not spelled out. It never
speaks over your dictation, and a tab you are not
looking at waits until you show it. The stop key (**Ctrl+Shift+Q**, Settings
→ Shortcuts) or any send stops the voice — never the agent. Settings → Voice
sets how fast it reads.

On Linux the system voice is speech-dispatcher; if none answers, read-aloud
says it is unavailable.

## Hands-free (experimental)

Turn on **Hands-free voice in the Chat** in Settings → Experimental, then the
**Hands-free** chip in the Chat. Start the mic once; from then on:

1. Talk. When you pause (Settings → Voice: the hands-free pause), a chime
   plays and **Sending…** shows for about a second and a half.
2. Say **"stop"** (or "stopp"), press the stop key or click the line in that
   moment, and the prompt stays in the box unsent. Otherwise it is sent.
   "go on" still sends at once.
3. While the agent works, the mic rests. Once its turn is over and the answer
   has been read aloud (with read-aloud on), the mic listens again.
4. When the agent asks a question, it is read out with its numbered choices;
   say **"two"**, **"option two"** or **"die Zweite"** to pick one.

Without a headset the mic is muted while the voice speaks, so it never hears
itself; the stop key interrupts. With **Headset mode** on (Settings → Voice)
you are heard while it reads, and talking over the voice stops it.

Keyboard steering hides the Chat's box and its chips, but hands-free goes on
listening: a small mic on the steering badge says so.

## On the phone

The Focus view's mic dictates with the phone's speech (on the device where it
can). Its menu holds **Read answers aloud**, the voice language and
**Hands-free**: the same pause, chime and "stop" window, then the answer is
read and the mic opens again. Keep the screen on and the page open — a web
page cannot hold the microphone from a pocket. A tap on the line stops the
voice or cancels a send.
