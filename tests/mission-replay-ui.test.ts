import { describe, expect, it } from 'vitest';
import { formatMissionDistance, formatMissionTime } from '../src/ui/missionReplay';

describe('mission replay presentation helpers', () => {
  it('formats elapsed mission time without wrapping after 24 hours', () => {
    expect(formatMissionTime(0)).toBe('00:00:00');
    expect(formatMissionTime(3_661.9)).toBe('01:01:01');
    expect(formatMissionTime(2 * 86_400 + 3_661)).toBe('2d 01:01:01');
  });

  it('uses readable SI distance scales while preserving sign', () => {
    expect(formatMissionDistance(4.25)).toBe('4.25 m');
    expect(formatMissionDistance(850)).toBe('850 m');
    expect(formatMissionDistance(12_500)).toBe('12.50 km');
    expect(formatMissionDistance(-2_500_000)).toBe('-2.50 Mm');
  });
});
