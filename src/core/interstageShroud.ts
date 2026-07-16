export interface InterstageShroudShape {
  lowerRadius: number;
  upperRadius: number;
  lowerY: number;
  upperY: number;
}

const MIN_RADIUS = 0.05;
const MAX_RADIUS = 10;
const MIN_SPAN = 0.08;
const MAX_SPAN = 8;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate untrusted craft/save data and return a fresh bounded snapshot. */
export function sanitizeInterstageShroudSpec(raw: unknown): InterstageShroudShape | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<InterstageShroudShape>;
  if (
    !finite(value.lowerRadius)
    || !finite(value.upperRadius)
    || !finite(value.lowerY)
    || !finite(value.upperY)
  ) return null;
  const span = value.upperY - value.lowerY;
  if (
    value.lowerRadius < MIN_RADIUS || value.lowerRadius > MAX_RADIUS
    || value.upperRadius < MIN_RADIUS || value.upperRadius > MAX_RADIUS
    || span < MIN_SPAN || span > MAX_SPAN
    || Math.abs(value.lowerY) > MAX_SPAN || Math.abs(value.upperY) > MAX_SPAN
  ) return null;
  return {
    lowerRadius: value.lowerRadius,
    upperRadius: value.upperRadius,
    lowerY: value.lowerY,
    upperY: value.upperY,
  };
}
