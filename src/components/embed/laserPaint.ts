/**
 * One frame of the presentation laser: a fading trail of recent pointer samples
 * and a glowing head. Shared by `PresentationOverlay` (over every viewer pane)
 * and the PDF present window, so the two lasers a room might see are the same
 * dot.
 */

/** How long a laser trail point lives, in ms. */
export const LASER_LIFETIME = 420;

export interface LaserPoint {
  x: number;
  y: number;
  /** `performance.now()` at the sample. */
  t: number;
}

/**
 * Clear `c` and draw one frame. `trail` holds CSS-px samples relative to the
 * canvas; it is returned with the expired ones dropped. `head` is where the dot
 * rests (null = use the newest sample, if any).
 */
export function paintLaserFrame(
  c: HTMLCanvasElement,
  trail: LaserPoint[],
  head: { x: number; y: number } | null,
  color: string,
  now: number,
): LaserPoint[] {
  const ctx = c.getContext("2d");
  const live = trail.filter((p) => now - p.t < LASER_LIFETIME);
  if (!ctx) return live;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save();
  for (const p of live) {
    const age = (now - p.t) / LASER_LIFETIME; // 0 fresh → 1 gone
    const a = 1 - age;
    const r = (4 + 6 * a) * dpr;
    ctx.globalAlpha = a * 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x * dpr, p.y * dpr, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // The dot rests at the last known position, not the newest trail point,
  // so it stays lit while the pointer is motionless (the trail fades out
  // behind it but the head does not vanish).
  const at = head ?? live[live.length - 1];
  if (at) {
    // The glow is three concentric fills at decreasing alpha, NOT
    // `ctx.shadowBlur`. A canvas shadow is a real Gaussian, recomputed
    // every frame over a full-window canvas, and this repo renders in
    // software (DMABUF is disabled — see the animated-box-shadow note in
    // themes.css). Paying for that at 60fps on the machine also driving a
    // second webview for the projector is the one place a stutter is
    // guaranteed to be noticed.
    ctx.fillStyle = color;
    for (const [r, a] of [
      [16, 0.12],
      [11, 0.22],
      [7, 1],
    ] as const) {
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(at.x * dpr, at.y * dpr, r * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(at.x * dpr, at.y * dpr, 2.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return live;
}
