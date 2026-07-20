import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from './fixtures/legacyAurenSystem';
import { contractsForBodies } from '../src/sim/campaign';

describe('system-aware campaign contracts', () => {
  it('does not expose fictional destinations in the production Sol system', () => {
    const ids = contractsForBodies(SOL_SYSTEM.map((body) => body.id)).map((contract) => contract.id);
    expect(ids).not.toContain('veyra-orbit');
    expect(ids).not.toContain('palla-landing');
    expect(ids).not.toContain('outer-moon-landing');
  });

  it('preserves the compact campaign board for explicit legacy tests', () => {
    expect(contractsForBodies(AUREN_SYSTEM.map((body) => body.id))).toHaveLength(7);
  });
});
