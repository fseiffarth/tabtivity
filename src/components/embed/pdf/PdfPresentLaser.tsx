/**
 * The present window's laser pointer: the same dot and trail as the viewers'
 * `PresentationOverlay` (`laserPaint.ts`), over the whole window while it is on.
 *
 * It never takes the pointer — clicks still turn sheets, the way a clicker with
 * a laser on it still has its buttons. It follows the window's own pointer moves
 * and goes dark over the bar, where the reader is pressing buttons rather than
 * pointing at the sheet.
 */

import { useEffect, useRef } from "react";
import { type LaserPoint, paintLaserFrame } from "../laserPaint";

/** Presenter red: reads on white paper and on a black blank alike. */
const LASER_COLOR = "#ff3b3b";

export function PdfPresentLaser() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    let trail: LaserPoint[] = [];
    let head: { x: number; y: number } | null = null;

    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(window.innerWidth * dpr));
      c.height = Math.max(1, Math.round(window.innerHeight * dpr));
    };
    size();

    const onMove = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".pdf-present-bar")) {
        head = null;
        return;
      }
      head = { x: e.clientX, y: e.clientY };
      trail.push({ ...head, t: performance.now() });
    };
    const onLeave = () => {
      head = null;
    };

    let raf = requestAnimationFrame(function tick() {
      trail = paintLaserFrame(c, trail, head, LASER_COLOR, performance.now());
      raf = requestAnimationFrame(tick);
    });

    window.addEventListener("resize", size);
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="pdf-present-laser" aria-hidden="true" />;
}
