const TWO_PI = Math.PI * 2;

/** Keep an unrestricted orbit angle numerically stable without introducing a hard stop. */
export function wrapOrbitAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}
