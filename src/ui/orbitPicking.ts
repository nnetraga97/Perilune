export interface ScreenOrbitPoint {
  x: number;
  y: number;
  depth: number;
  visible: boolean;
}

export interface OrbitPick {
  segmentIndex: number;
  segmentT: number;
  fraction: number;
  distance: number;
  depth: number;
}

/** Pick a rendered orbit by a stable screen-space band instead of WebGL line width. */
export function pickOrbitSegment(
  points: readonly ScreenOrbitPoint[],
  x: number,
  y: number,
  radius: number,
): OrbitPick | null {
  const maxDistanceSq = radius * radius;
  let best: OrbitPick | null = null;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    if (!a.visible || !b.visible) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const segmentT = lengthSq > 0
      ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq))
      : 0;
    const nearestX = a.x + dx * segmentT;
    const nearestY = a.y + dy * segmentT;
    const ox = x - nearestX;
    const oy = y - nearestY;
    const distanceSq = ox * ox + oy * oy;
    if (distanceSq > maxDistanceSq) continue;
    const depth = a.depth + (b.depth - a.depth) * segmentT;
    const distance = Math.sqrt(distanceSq);
    const fraction = (index + segmentT) / Math.max(1, points.length - 1);
    if (
      !best ||
      distance < best.distance - 0.01 ||
      (Math.abs(distance - best.distance) <= 0.01 && depth < best.depth) ||
      (Math.abs(distance - best.distance) <= 0.01 && Math.abs(depth - best.depth) <= 1e-6 && fraction < best.fraction)
    ) {
      best = { segmentIndex: index, segmentT, fraction, distance, depth };
    }
  }
  return best;
}
