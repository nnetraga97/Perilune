import { partById, type PartDef, type TechId } from '../content/parts';
import type { Craft } from './vessel';

export type GameMode = 'sandbox' | 'exploration' | 'program';

export interface CampaignState {
  mode: GameMode;
  funds: number;
  reputation: number;
  unlockedTech: TechId[];
  activeContracts: string[];
  completedContracts: string[];
  upgradeLevels: Record<UpgradeId, number>;
}

export interface TechnologyDef {
  id: TechId;
  name: string;
  brief: string;
  scienceCost: number;
  requires: TechId | null;
}

export type UpgradeId = 'field-methods' | 'downlink-coding';

export interface RepeatableUpgradeDef {
  id: UpgradeId;
  name: string;
  brief: string;
  requires: TechId;
  baseCost: number;
  costGrowth: number;
}

export interface ContractDef {
  id: string;
  name: string;
  brief: string;
  achievement: string;
  rewardFunds: number;
  rewardReputation: number;
  requiresTech?: TechId;
  /** Contract is hidden when any named world is absent from the selected system. */
  requiredBodyIds?: readonly string[];
}

export const PROGRAM_RESERVE_THRESHOLD = 6_000;
export const PROGRAM_RESERVE_FLOOR = 12_000;
export const PROGRAM_RESERVE_REPUTATION_COST = 2;

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
    brief: 'Short-range communications, atmospheric readings, and biological exposure experiments.',
    scienceCost: 45,
    requires: 'orbital-engineering',
  },
  {
    id: 'deep-space-systems',
    name: 'Deep-Space Systems',
    brief: 'Heavy propulsion, interplanetary communications, large structures, and thermal protection.',
    scienceCost: 70,
    requires: 'orbital-engineering',
  },
  {
    id: 'surface-operations',
    name: 'Surface Operations',
    brief: 'Dedicated landing legs and powered rover wheels for sustained surface travel.',
    scienceCost: 85,
    requires: 'exploration-instruments',
  },
  {
    id: 'precision-science',
    name: 'Precision Science',
    brief: 'Long-range downlinks, orbital surveys, field sampling, and higher-fidelity instruments.',
    scienceCost: 180,
    requires: 'exploration-instruments',
  },
  {
    id: 'crewed-expeditions',
    name: 'Crewed Expeditions',
    brief: 'Docking, multi-crew cabins, large batteries and arrays, and heavy thermal protection.',
    scienceCost: 240,
    requires: 'deep-space-systems',
  },
  {
    id: 'planetary-industry',
    name: 'Planetary Industry',
    brief: 'Prospecting, extraction, storage, and conversion hardware for sustained surface operations.',
    scienceCost: 300,
    requires: 'surface-operations',
  },
];

export const REPEATABLE_UPGRADES: readonly RepeatableUpgradeDef[] = [
  {
    id: 'field-methods',
    name: 'Field Methods',
    brief: 'Future collections capture a larger share of each site\'s remaining value.',
    requires: 'precision-science',
    baseCost: 60,
    costGrowth: 1.55,
  },
  {
    id: 'downlink-coding',
    name: 'Downlink Coding',
    brief: 'Future non-sample results preserve more value when transmitted.',
    requires: 'precision-science',
    baseCost: 75,
    costGrowth: 1.6,
  },
];

export const CONTRACTS: readonly ContractDef[] = [
  {
    id: 'first-launch',
    name: 'Clear the Tower',
    brief: 'Launch a vessel from Kennedy Space Center LC-39B.',
    achievement: 'campaign:launched',
    rewardFunds: 4_000,
    rewardReputation: 1,
    requiredBodyIds: ['veyra'],
  },
  {
    id: 'veyra-orbit',
    name: 'A World Without Falling',
    brief: 'Place a controlled vessel into stable orbit around Veyra.',
    achievement: 'campaign:veyra-orbit',
    rewardFunds: 9_000,
    rewardReputation: 3,
    requiredBodyIds: ['veyra'],
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
    requiredBodyIds: ['palla'],
  },
  {
    id: 'first-docking',
    name: 'Handshake in the Dark',
    brief: 'Dock two independently launched vessels in orbit.',
    achievement: 'campaign:first-docking',
    rewardFunds: 16_000,
    rewardReputation: 5,
    requiresTech: 'crewed-expeditions',
  },
  {
    id: 'outer-moon-landing',
    name: 'The Giant\'s Shore',
    brief: 'Land a controlled vessel on Brimm, Glacia, or Mote in the Tyran system.',
    achievement: 'campaign:outer-moon-landed',
    rewardFunds: 30_000,
    rewardReputation: 8,
    requiresTech: 'deep-space-systems',
    requiredBodyIds: ['tyran', 'brimm', 'glacia', 'mote'],
  },
  {
    id: 'surface-industry',
    name: 'Make Fuel Under Another Sky',
    brief: 'Convert locally mined ore into propellant on a planetary surface.',
    achievement: 'campaign:surface-industry',
    rewardFunds: 25_000,
    rewardReputation: 8,
    requiresTech: 'planetary-industry',
  },
];

export function contractsForBodies(bodyIds: Iterable<string>): readonly ContractDef[] {
  const available = new Set(bodyIds);
  return CONTRACTS.filter((contract) => (
    contract.requiredBodyIds?.every((bodyId) => available.has(bodyId)) ?? true
  ));
}

export function createCampaign(mode: GameMode = 'sandbox'): CampaignState {
  return {
    mode,
    funds: mode === 'program' ? 25_000 : 0,
    reputation: 0,
    unlockedTech: mode === 'sandbox' ? TECHNOLOGIES.map((technology) => technology.id) : ['foundations'],
    activeContracts: [],
    completedContracts: [],
    upgradeLevels: { 'field-methods': 0, 'downlink-coding': 0 },
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
      : [...new Set<TechId>(['foundations', ...(raw?.unlockedTech ?? [])])].filter((id) => knownTech.has(id)),
    activeContracts: [...new Set(raw?.activeContracts ?? [])].filter((id) => knownContracts.has(id)),
    completedContracts: [...new Set(raw?.completedContracts ?? [])].filter((id) => knownContracts.has(id)),
    upgradeLevels: {
      'field-methods': normalizedUpgradeLevel(raw?.upgradeLevels?.['field-methods']),
      'downlink-coding': normalizedUpgradeLevel(raw?.upgradeLevels?.['downlink-coding']),
    },
  };
}

function normalizedUpgradeLevel(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
}

export function technologyForPart(part: Pick<PartDef, 'tech'>): TechnologyDef {
  const technology = TECHNOLOGIES.find((candidate) => candidate.id === part.tech);
  if (!technology) throw new Error(`Unknown technology ${part.tech}`);
  return technology;
}

export function isPartUnlocked(campaign: CampaignState, part: Pick<PartDef, 'tech'>): boolean {
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

export function upgradeCost(upgrade: RepeatableUpgradeDef, level: number): number {
  return Math.round(upgrade.baseCost * upgrade.costGrowth ** Math.max(0, level));
}

export function purchaseUpgrade(
  campaign: CampaignState,
  sciencePoints: number,
  upgradeId: UpgradeId,
): { ok: boolean; sciencePoints: number; reason?: string } {
  if (campaign.mode === 'sandbox') return { ok: false, sciencePoints, reason: 'Research purchases are disabled in Sandbox.' };
  const upgrade = REPEATABLE_UPGRADES.find((candidate) => candidate.id === upgradeId);
  if (!upgrade) return { ok: false, sciencePoints, reason: 'Unknown upgrade.' };
  if (!campaign.unlockedTech.includes(upgrade.requires)) {
    return { ok: false, sciencePoints, reason: 'Unlock Precision Science first.' };
  }
  const level = campaign.upgradeLevels[upgrade.id] ?? 0;
  const cost = upgradeCost(upgrade, level);
  if (sciencePoints < cost) return { ok: false, sciencePoints, reason: `Requires ${cost} science.` };
  campaign.upgradeLevels[upgrade.id] = level + 1;
  return { ok: true, sciencePoints: sciencePoints - cost };
}

export function acceptContract(campaign: CampaignState, contractId: string): { ok: boolean; reason?: string } {
  if (campaign.mode !== 'program') return { ok: false, reason: 'Contracts are available in Space Program mode.' };
  const contract = CONTRACTS.find((candidate) => candidate.id === contractId);
  if (!contract) return { ok: false, reason: 'Unknown contract.' };
  if (contract.requiresTech && !campaign.unlockedTech.includes(contract.requiresTech)) {
    return { ok: false, reason: `Unlock ${TECHNOLOGIES.find((technology) => technology.id === contract.requiresTech)?.name ?? 'the required technology'} first.` };
  }
  if (campaign.completedContracts.includes(contractId)) return { ok: false, reason: 'Contract already completed.' };
  if (campaign.activeContracts.includes(contractId)) return { ok: false, reason: 'Contract already active.' };
  if (campaign.activeContracts.length >= 3) return { ok: false, reason: 'The program can track three active contracts at a time.' };
  campaign.activeContracts.push(contractId);
  return { ok: true };
}

export function requestProgramReserve(
  campaign: CampaignState,
  hasOperationalVessels: boolean,
): { ok: boolean; awarded: number; reason?: string } {
  if (campaign.mode !== 'program') {
    return { ok: false, awarded: 0, reason: 'The program reserve is available only in Space Program mode.' };
  }
  if (hasOperationalVessels) {
    return { ok: false, awarded: 0, reason: 'Recover or operate the vessels already in the field first.' };
  }
  if (campaign.funds >= PROGRAM_RESERVE_THRESHOLD) {
    return { ok: false, awarded: 0, reason: `Reserve review begins below ${PROGRAM_RESERVE_THRESHOLD.toLocaleString()} funds.` };
  }
  const awarded = Math.max(0, PROGRAM_RESERVE_FLOOR - campaign.funds);
  campaign.funds += awarded;
  campaign.reputation = Math.max(0, campaign.reputation - PROGRAM_RESERVE_REPUTATION_COST);
  return { ok: true, awarded };
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
