/** The index `delta` steps on from `at` in a ring of `n`, wrapping at both
 *  ends: one past the last is the first, one before the first the last. */
export function wrapStep(at: number, delta: number, n: number): number {
  return (((at + delta) % n) + n) % n;
}
