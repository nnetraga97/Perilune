import { describe, expect, it } from 'vitest';
import type { SaveGame } from '../src/save/schema';
import { menuMissions } from '../src/ui/mainMenu';

const save = {
  label: 'autosave',
  time: 412,
  activeVesselId: 'v1',
  vessels: [{ name: 'Wayfarer' }],
} as unknown as SaveGame;

describe('main-menu mission hierarchy', () => {
  it('leads with Continue when an autosave exists', () => {
    const missions = menuMissions(save);
    expect(missions.map((mission) => mission.id)).toEqual(['continue', 'first-light', 'sandbox']);
    expect(missions.find((mission) => mission.primary)?.id).toBe('continue');
    expect(missions[0].detail).toContain('Wayfarer');
  });

  it('omits dead Continue and promotes First Light without a save', () => {
    const missions = menuMissions(null);
    expect(missions.map((mission) => mission.id)).toEqual(['first-light', 'sandbox']);
    expect(missions.find((mission) => mission.primary)?.id).toBe('first-light');
  });
});
