# Dictation improvement plan

> **Status (screened against code 2026-11-22):** PARTIAL. Built: the desktop recovery contract (per-segment `FinalOutcome` in `src-tauri/src/services/voice/session.rs`, "Restore words" / "Dismiss" in `ReaderVoice.tsx` + `useLiveDictation.ts`; d0a449d71), caret / selection dictation (`DraftRange`, `replaceDictated`, `rebaseRange` in `src/lib/voice/provisionalDraft.ts`), and the phone hidden-page stop (`visibilitychange` in `mobile-web/src/voiceSession.ts`; 0908086be). Open: the section 2 latency baseline and the section 4 physical-device trials; the measurement table is empty and no pacing change has been made. Not live-tested.


Prioritize the last sentence. Desktop Chat can show words while someone speaks and then clear them if final transcription fails. Fix that loss first. Measure latency and recognition quality on the current build in parallel. Use those measurements to decide whether performance tuning or mid-draft editing comes next. Phone interruption testing can proceed independently.

This is a source-based plan. Desktop uses a local transcription worker. Phone Focus uses browser recognition with its own restart and utterance handling. Both already display provisional text. Live results are still open in the voice section of `todo/group-s-agents.md`.

## 1. Preserve unfinished desktop dictation

**Reproduce the failure.** In the session worker tests, inject a short drain deadline using the existing fake audio source and transcriber. Hold a final until the test releases it. Queue two segments, return the first final, then stop with the second pending. Today the 30-second production deadline can expire and the worker can emit ordinary stopped state. A failed final follows another path that emits an error and an empty final. An intentionally filtered segment also ends empty. Capture all three sequences before changing the renderer. [Session worker and tests](../src-tauri/src/services/voice/session.rs)

**Extend the existing final event.** Track outstanding segment IDs in submission order in place of the pending count. Remove each ID when its decoder result arrives. Add an optional outcome field to the existing final payload. Keep the existing session, segment and text fields. Deliver one terminal outcome per submitted segment according to this contract.

| Worker result | Renderer behavior |
| --- | --- |
| Transcribed words | Commit once through the existing final handler. |
| Silence, phantom or echo | Remove the provisional span. Finish quietly. |
| Final decoder error or failed job submission | Identify the failed segment. Prepare its eligible visible words for recovery and show the existing error detail once. |
| Stop deadline or disconnected worker with outstanding finals | Mark each outstanding segment incomplete before emitting stopped. Keep the finals already delivered. |
| Explicit discard or session replacement | Invalidate the old attempt. Ignore late callbacks and clear any recovery offer belonging to it. |

**Route the result to the right draft.** Extend the TypeScript event type and callbacks in the desktop adapter. Keep its early-event buffering and session filter. A missing outcome from an older backend follows the current text/empty behavior. Handle stop-invocation rejection explicitly too. That path currently calls the same finish callback as ordinary completion. Route incomplete segments to a separate callback before end cleanup. Test that a stopped event arriving before the start invocation resolves leaves the reader idle and listeners detached. [Desktop adapter](../src/lib/voice/desktopVoice.ts) · [Adapter tests](../src/__tests__/terminal/DesktopVoice.test.ts)

**Recover only what the user saw.** Have the live draft return the current text and position of a segment still owned by dictation before removing its provisional span. Preserve manual edits when the user took over the span. Keep eligible snippets in speech order in local composer state. Held commands, dialog answers and filtered segments never enter this list. If no eligible text exists for a failed segment, tell the user which phrase needs repeating, using its position where several failed. Keep ordinary end-of-session cleanup separate from dismissing the offer. [Live draft](../src/components/terminal/useLiveDictation.ts) · [Reader lifecycle](../src/components/terminal/ReaderVoice.tsx)

**Expose two explicit actions.** In the existing voice status strip, offer “Restore words” and “Dismiss” using i18n keys. Restoring writes plain text via the composer's edit and undo path exactly once. It bypasses spoken edits, send detection, dialog picks and the hands-free send guard. Cancel any pending send on failure and keep automatic sending disarmed while recovery is outstanding. Rebase insertion positions across unrelated edits with the existing span logic. If a location becomes ambiguous, show the words and offer an explicitly labeled append action. Dismiss on send, new session, tab replacement or unmount. [Composer](../src/components/terminal/TerminalReaderView.tsx) · [Span reconciliation](../src/lib/voice/provisionalDraft.ts)

**Acceptance tests.** Exercise successful stop, filtered empty final, timeout after one successful final, decoder failure before any preview, typed-over preview, duplicate or late final, abort after send and switching tabs. Include a preview containing command-like words. Assert exact draft contents, one undo step per restore, no sends or picks, and no recovery UI in the next session. Cover event mapping in DesktopVoice, visible recovery in ReaderVoice, and the send guard in ReaderHandsFree.

## 2. Establish a baseline and pick one latency change

1. Use desktop Chat and phone Focus with hands-free off for text trials. Record build, OS or browser, microphone, language, selected model and actual CPU/GPU or browser recognition mode. Run cold trials after a fresh model load and warm trials while it is resident. Record a mode as unknown if the device cannot report it.
2. Use the same fixed scripts before and after a change. Include “Open the settings and show the current model”, “Öffne die Einstellungen und zeige das aktuelle Modell”, and a two-clause sentence with a one-second hesitation. Include a repository identifier such as `voice_listen_stop` and score its spelling separately. For the command trial use “was ist los” and an intentional terminal “los” with a disposable Chat draft. Include one minute of room noise with hands-free enabled.
3. Capture mic activation to ready, first audible word to first visible draft text, and last audible word to settled text. A local screen recording of the scripted trial with microphone audio provides one clock for both signals. Use temporary test-only timestamps if settlement is visually indistinguishable from the last partial. Store only timing and error counts in the results. Record missing or doubled words, manual corrections and unexpected sends.
4. Run each speech case five times per configuration. Report median and worst observation and keep cold and warm samples separate. For desktop compare CPU and GPU on the same machine and model where available. For phone report browser and device separately. Five trials are a diagnostic baseline, so repeat close comparisons before adopting a change.
5. Follow the measured delay. For slow activation, time model preparation and microphone startup separately. For late first words, inspect VAD opening, partial scheduling and decode time. For slow settlement, separate end-of-speech detection from queued final decoding. Change one parameter or code path, then rerun the same trials. Keep a change only when the target timing improves reproducibly, corrections and duplicates do not increase, and unintended sends remain zero. If the delay is browser-owned, document that result before changing desktop pacing. [Worker](../src-tauri/src/services/voice/session.rs) · [VAD](../src-tauri/src/services/voice/vad.rs) · [Phone session](../mobile-web/src/voiceSession.ts)

## 3. Dictate at the desktop caret and replace selected text

1. **Capture insertion intent.** In ReaderComposer, remember the textarea selection while the composer owns focus. Capture it before a pointer press on the mic moves focus. For keyboard activation, retain the selection when focus moves directly from composer to mic. Starting from elsewhere appends. Snapshot the range against the current draft and rebase it across edits while the mic prepares.
2. **Give each segment a stable range.** Extend ProvisionalDraft to accept a range for the first preview or a final arriving without a preview. A partial replaces the same span on every revision. Store the displaced original text so the settled draft and persisted draft still represent the user's committed content. Use existing spacing helpers at both boundaries and preserve surrounding newlines. Subsequent segments follow the previous insertion unless the user explicitly moves the caret before the next segment.
3. **Define edit ownership.** Moving the caret during an open segment affects the next segment. Typing outside the preview shifts its range. Typing inside it transfers ownership to the user as today. An empty or held result, pause, or cancellation restores the displaced text for an untouched preview. A manual takeover keeps the edited text. Spoken commands run against the settled draft after restoring the selection contents.
4. **Commit one replacement.** Extend the composer's current insertion bookkeeping to describe both removed and inserted text. Build the undo snapshot from the settled draft before replacement. One undo restores the selected text, one redo reapplies the final. Preserve caret and selection through partial rewrites without taking focus away from the user's current control. Apply the same range semantics when restoring unfinished words from step 1.
5. **Verify at two levels.** Add span-level cases for insertion at start/middle/end, reversed selection, punctuation, multiline selection, edits on either side and two segments awaiting finals. Add composer-level cases for pointer and keyboard mic activation, final without partial, manual takeover, command-only final, undo/redo and restoration after timeout. Use a concrete fixture such as selecting “red” in “use red paint”, dictating “dark blue”, then undoing to “use red paint”. Check on a phone with its software keyboard open before scheduling equivalent phone selection behavior. [Span tests](../src/__tests__/terminal/ProvisionalDraft.test.ts) · [Reader tests](../src/__tests__/terminal/ReaderVoice.test.tsx)

## 4. Close demonstrated phone interruption gaps

Start with the existing lifecycle and composer tests. The session already retries transient recognizer ends and stops after repeated short sessions. The input hook separately settles utterances and resets recognition bookkeeping on restart. Test both layers together before changing either one. [Session](../mobile-web/src/voiceSession.ts) · [Input hook](../mobile-web/src/screens/terminal/useVoiceInput.ts) · [Lifecycle tests](../src/__tests__/mobile/MobileVoiceSession.test.ts) · [Composer tests](../src/__tests__/mobile/MobileTerminalVoice.test.tsx)

| Trial | Required observation | Implementation if the trial fails |
| --- | --- | --- |
| Lock screen or switch apps during a sentence, then return | Settled words survive. On return the mic state is accurate and the user can resume. | Handle visibility and end ordering in the session. Release capture resources once and surface a localized resume action. |
| Deny permission, then retry after enabling it | The first attempt ends with actionable feedback. A fresh attempt starts normally. | Map the fatal error in the session and clear stale problem state when a new attempt starts. |
| Recognizer ends between words or repeats a growing final | No duplicated or missing settled words across restart. | Reproduce the browser result sequence in the input-hook tests. Settle the old utterance before resetting recognizer-local indices. |
| Tap Stop during restart backoff, or navigate away before a callback | No reopened mic, stale meter or text in another tab. | Cancel the scheduled restart and detach the old callbacks during cleanup. Exercise fake timers and late results. |

Record device, OS, browser, recognition availability and observed event order with each manual result. Run each fix against the reproduced sequence and then the same device. Leave unsupported or unavailable configurations explicitly unverified.

## Delivery and verification

Land the desktop outcome contract and recovery UI together so failed words can be acted on. The measurement work and phone lifecycle trials can start immediately. Land any justified pacing change separately from caret editing so a regression can be attributed to one change. Update the existing manual verification rows with actual platform results and register new user-visible behavior with UntestedTag until confirmed.

For each implementation change, run the affected gates through `scripts/gates-job.sh start` and check the saved result with `scripts/gates-job.sh status <directory>`. After Rust changes run `npm run backend:stale`. Rebuild the baked phone PWA with `npm run mobile:bundle` for phone changes. For live verification, have the tester open Chat or Focus on a build containing the relevant changes and run the scenarios above. Record automated results separately from microphone trials on Linux X11, Linux Wayland, Windows, macOS and the tested phones.

## Live measurement record

The desktop recovery and caret changes and the phone hidden-page fix have automated regression coverage. Microphone timings and physical-device trials are pending. Run the scripts in section 2 on a build containing the changes. Record one row per configuration, script and cold/warm condition. Use milliseconds for the three latency columns.

| Build, OS/browser, device and mic | Model, language and execution mode | Script and cold/warm condition | Tap to ready, median/worst | Speech to first words, median/worst | Speech end to settled, median/worst | Missing/doubled words, corrections, unintended sends |
| --- | --- | --- | --- | --- | --- | --- |

Use the interruption scenarios in section 4 on the same phone. Record the final draft and displayed mic state after returning to Focus. Leave pacing and model defaults at their current values until these trials identify a reproducible delay.
