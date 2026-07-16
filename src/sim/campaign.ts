import { partById, type PartDef } from '../content/parts';
import type { Craft } from './vessel';

export type GameMode = 'sandbox' | 'exploration' | 'program';

export interface CampaignState {
  mode: GameMode;
  funds: number;
  reputation: number;
  unlockedTech: string[];
  activeContracts: string[];
  completedContracts: string[];
}

export interface TechnologyDef {
  id: string;
  name: string;
  brief: string;
  scienceCost: number;
  requires: string | null;
}

export interface ContractDef {
  id: string;
  name: string;
  brief: string;
  achievement: string;
  rewardFunds: number;
  rewardReputation: number;
}

export const TECHNOLOGIES: readonly TechnologyDef[] = [
  {
    id: 'foundations',
    name: 'Flight Foundations',
    brief: 'Crewed capsules, compact tanks, a launch engine, staging, recovery, and basic instruments.',
    scienceCost: 0,
    requires: null,
  },
  {
    id: 'orbital-engineering',
    name: 'Orbital Engineering',
    brief: 'Vacuum propulsion, larger tanks, reaction control, electrical power, and stronger structures.',
    scienceCost: 30,
    requires: 'foundations',
  },
  {
    id: 'atmospheric-flight',
    name: 'Atmospheric Flight',
    brief: 'Wings, control surfaces, air-breathing propulsion, landing gear, and aerodynamic recovery.',
    scienceCost: 35,
    requires: 'foundations',
  },
  {
    id: 'exploration-instruments',
    name: 'Exploration Instruments',
    brief: 'Communications, advanced experiments, orbital survey hardware, and autonomous control.',
    scienceCost: 45,
    requires: 'orbital-engineering',
  },
  {
    id: 'deep-space-systems',
    name: 'Deep-Space Systems',
    brief: 'Heavy propulsion, docking, thermal protection, large power systems, and crewed expeditions.',
    scienceCost: 70,
    requires: 'orbital-engineering',
  },
  {
    id: 'surface-operations',
    name: 'Surface Operations',
    brief: 'Landing systems, rovers, prospecting, extraction, storage, and in-situ refining.',
    scienceCost: 85,
    requires: 'exploration-instruments',
  },
];

export const CONTRACTS: readonly ContractDef[] = [
  {
    id: 'first-launch',
    name: 'Clear the Tower',
    brief: 'Launch a vessel from Cape Skyward.',
    achievement: 'campaign:launched',
    rewardFunds: 4_000,
    rewardReputation: 1,
  },
  {
    id: 'veyra-orbit',
    name: 'A World Without Falling',
    brief: 'Place a controlled vessel into stable orbit around Veyra.',
    achievement: 'campaign:veyra-orbit',
    rewardFunds: 9_000,
    rewardReputation: 3,
  },
  {
    id: 'science-return',
    name: 'Bring Back Answers',
    brief: 'Recover a vessel carrying new scientific results.',
    achievement: 'campaign:science-return',
    rewardFunds: 7_500,
    rewardReputation: 2,
  },
  {
    id: 'palla-landing',
    name: 'A Quiet Place to Stand',
    brief: 'Land a controlled vessel on Palla.',
    achievement: 'campaign:palla-landed',
    rewardFunds: 18_000,
    rewardReputation: 6,
  },
];

const PART_TECH: Readonly<Record<string, string>> = {
  'pod-voyager': 'foundations',
  'tank-s1': 'foundations',
  'tank-s2': 'foundations',
  'eng-pike': 'foundations',
  'srb-flare': 'foundations',
  'dec-s': 'foundations',
  'nose-s': 'foundations',
  'fin-swift': 'foundations',
  'chute-main': 'foundations',
  'batt-s': 'foundations',
  'sci-thermo': 'foundations',

  'core-pilot': 'orbital-engineering',
  'tank-s4': 'orbital-engineering',
  'tank-m4': 'orbital-engineering',
  'eng-mule': 'orbital-engineering',
  'eng-ember': 'orbital-engineering',
  'eng-colt': 'orbital-engineering',
  'rcs-quad': 'orbital-engineering',
  'dec-interstage-ms': 'orbital-engineering',
  'dec-radial': 'orbital-engineering',
  'adapt-ms': 'orbital-engineering',
  'girder-s': 'orbital-engineering',
  'plate-base': 'orbital-engineering',
  'solar-flat': 'orbital-engineering',
  'wheel-rw': 'orbital-engineering',
  'lamp-dot': 'orbital-engineering',

  'fin-rudder': 'atmospheric-flight',
  'wing-span': 'atmospheric-flight',
  'chute-drogue': 'atmospheric-flight',
  'gear-skid': 'atmospheric-flight',
  'wing-delta': 'atmospheric-flight',
  'ctrl-elevon': 'atmospheric-flight',
  'eng-whirl': 'atmospheric-flight',

  'ant-whip': 'exploration-instruments',
  'ant-dish': 'exploration-instruments',
  'sci-baro': 'exploration-instruments',
  'sci-spore': 'exploration-instruments',
  'sci-survey': 'exploration-instruments',
  'sci-fieldkit': 'exploration-instruments',
  'scan-prospector': 'exploration-instruments',

  'pod-tandem': 'deep-space-systems',
  'tank-m8': 'deep-space-systems',
  'tank-radial': 'deep-space-systems',
  'eng-aspen': 'deep-space-systems',
  'srb-torch': 'deep-space-systems',
  'dec-m': 'deep-space-systems',
  'dock-port-s': 'deep-space-systems',
  'nose-m': 'deep-space-systems',
  'batt-m': 'deep-space-systems',
  'solar-fold': 'deep-space-systems',
  'shield-s': 'deep-space-systems',
  'shield-m': 'deep-space-systems',

  'leg-lander': 'surface-operations',
  'wheel-scout': 'surface-operations',
  'wheel-mesa': 'surface-operations',
  'drill-auger': 'surface-operations',
  'conv-kiln': 'surface-operations',
  'bin-ore': 'surface-operations',
};

export function createCampaign(mode: GameMode = 'sandbox'): CampaignState {
  return {
    mode,
    funds: mode === 'program' ? 25_000 : 0,
    reputation: 0,
    unlockedTech: mode === 'sandbox' ? TECHNOLOGIES.map((technology) => technology.id) : ['foundations'],
    activeContracts: [],
    completedContracts: [],
  };
}

export function normalizeCampaign(raw: Partial<CampaignState> | null | undefined): CampaignState {
  const mode: GameMode = raw?.mode === 'exploration' || raw?.mode === 'program' ? raw.mode : 'sandbox';
  const fallback = createCampaign(mode);
  const knownTech = new Set(TECHNOLOGIES.map((technology) => technology.id));
  const knownContracts = new Set(CONTRACTS.map((contract) => contract.id));
  return {
    mode,
    funds: Number.isFinite(raw?.funds) ? Math.max(0, Math.round(raw!.funds!)) : fallback.funds,
    reputation: Number.isFinite(raw?.reputation) ? Math.max(0, Math.round(raw!.reputation!)) : 0,
    unlockedTech: mode === 'sandbox'
      ? fallback.unlockedTech
      : [...new Set(['foundations', ...(raw?.unlockedTech ?? [])])].filter((id) => knownTech.has(id)),
    activeContracts: [...new Set(raw?.activeContracts ?? [])].filter((id) => knownContracts.has(id)),
    completedContracts: [...new Set(raw?.completedContracts ?? [])].filter((id) => knownContracts.has(id)),
  };
}

export function technologyForPart(part: Pick<PartDef, 'id'>): TechnologyDef {
  const id = PART_TECH[part.id] ?? 'deep-space-systems';
  return TECHNOLOGIES.find((technology) => technology.id === id)!;
}

export function isPartUnlocked(campaign: CampaignState, part: Pick<PartDef, 'id'>): boolean {
  return campaign.mode === 'sandbox' || campaign.unlockedTech.includes(technologyForPart(part).id);
}

export function craftCost(craft: Craft): number {
  return craft.parts.reduce((total, part) => total + partById(part.defId).cost, 0);
}

export function lockedCraftParts(campaign: CampaignState, craft: Craft): PartDef[] {
  if (campaign.mode === 'sandbox') return [];
  const locked = new Map<string, PartDef>();
  for (const part of craft.parts) {
    const definition = partById(part.defId);
    if (!isPartUnlocked(campaign, definition)) locked.set(definition.id, definition);
  }
  return [...locked.values()];
}

export function unlockTechnology(
  campaign: CampaignState,
  sciencePoints: number,
  technologyId: string,
): { ok: boolean; sciencePoints: number; reason?: string } {
  if (campaign.mode === 'sandbox') return { ok: false, sciencePoints, reason: 'All technology is already available in Sandbox.' };
  const technology = TECHNOLOGIES.find((candidate) => candidate.id === technologyId);
  if (!technology) return { ok: false, sciencePoints, reason: 'Unknown technology.' };
  if (campaign.unlockedTech.includes(technology.id)) return { ok: false, sciencePoints, reason: 'Technology already unlocked.' };
  if (technology.requires && !campaign.unlockedTech.includes(technology.requires)) {
    return { ok: false, sciencePoints, reason: 'Unlock the preceding technology first.' };
  }
  if (sciencePoints < technology.scienceCost) {
    return { ok: false, sciencePoints, reason: `Requires ${technology.scienceCost} science.` };
  }
  campaign.unlockedTech.push(technology.id);
  return { ok: true, sciencePoints: sciencePoints - technology.scienceCost };
}

export function acceptContract(campaign: CampaignState, contractId: string): { ok: boolean; reason?: string } {
  if (campaign.mode !== 'program') return { ok: false, reason: 'Contracts are available in Space Program mode.' };
  if (!CONTRACTS.some((contract) => contract.id === contractId)) return { ok: false, reason: 'Unknown contract.' };
  if (campaign.completedContracts.includes(contractId)) return { ok: false, reason: 'Contract already completed.' };
  if (campaign.activeContracts.includes(contractId)) return { ok: false, reason: 'Contract already active.' };
  if (campaign.activeContracts.length >= 3) return { ok: false, reason: 'The program can track three active contracts at a time.' };
  campaign.activeContracts.push(contractId);
  return { ok: true };
}

export function settleContracts(campaign: CampaignState, flags: Readonly<Record<string, boolean>>): ContractDef[] {
  if (campaign.mode !== 'program') return [];
  const completed: ContractDef[] = [];
  for (const id of [...campaign.activeContracts]) {
    const contract = CONTRACTS.find((candidate) => candidate.id === id);
    if (!contract || !flags[contract.achievement]) continue;
    campaign.activeContracts = campaign.activeContracts.filter((candidate) => candidate !== id);
    if (!campaign.completedContracts.includes(id)) campaign.completedContracts.push(id);
    campaign.funds += contract.rewardFunds;
    campaign.reputation += contract.rewardReputation;
    completed.push(contract);
  }
  return completed;
}
