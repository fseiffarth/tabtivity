/** The schedule form's "In … h … min" (desktop `AgentScheduleDialog`, phone
 *  `ScheduleSheet`): whole minutes ahead, or null for anything the two boxes
 *  should not accept (blank both, negative, fractional, zero). */
export function delayMinutes(hours: string, minutes: string): number | null {
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) return null;
  const total = h * 60 + m;
  return total > 0 ? total : null;
}
