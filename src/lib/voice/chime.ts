// The hands-free send guard's chime (shared/handsFree.ts), on the desktop and
// the phone alike: a soft two-note blip, synthesized, so no audio file ships.
// Kept under 200 ms: the desktop's voice detector wants 250 ms of sound before
// it opens a segment, so the chime it hears can never dictate.

type AudioWindow = Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

let context: AudioContext | null = null;

/** Plays the chime; silently nothing where the page has no Web Audio. */
export function playChime(scope: Window = window): void {
  const audioWindow = scope as AudioWindow;
  const Context = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!Context) return;
  try {
    context ??= new Context();
    const ctx = context;
    void ctx.resume?.().catch(() => {});
    const start = ctx.currentTime + 0.01;
    for (const [offset, frequency] of [[0, 880], [0.08, 1320]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(0.12, start + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.07);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.08);
    }
  } catch {
    // No sound is no reason to stop the send guard.
  }
}
