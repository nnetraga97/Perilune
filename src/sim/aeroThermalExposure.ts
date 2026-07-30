import type { AeroModel } from './aero';
import { defOf, type Craft } from './vessel';

export function evaluateThermalExposure(
  craft: Craft,
  model: AeroModel,
  flowAlign: number,
): Map<number, number> {
  const noseWeight = (1 + flowAlign) / 2;
  const shieldFractions = craft.parts
    .filter((part) => defOf(part).heatShield)
    .map((part) => model.axialFrac.get(part.key) ?? 0.5);
  const exposure = new Map<number, number>();
  for (const part of craft.parts) {
    const fraction = model.axialFrac.get(part.key) ?? 0.5;
    let value = 0.15 + 0.85 * (
      noseWeight * fraction * fraction
      + (1 - noseWeight) * (1 - fraction) * (1 - fraction)
    );
    if (
      !defOf(part).heatShield
      && shieldFractions.some((shield) => shield <= 0.5 ? fraction > shield : fraction < shield)
    ) value *= 0.08;
    exposure.set(part.key, value);
  }
  return exposure;
}
