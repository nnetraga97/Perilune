import type { TerrainRequestClass, TerrainReservationPort } from './terrainScheduler';

interface TerrainReservation {
  readonly bytes: number;
  readonly requestClass: TerrainRequestClass;
}

interface TerrainResidentResource {
  readonly key: string;
  readonly bytes: number;
  readonly lastUsedFrame: number;
}

export interface TerrainInstallationDecision {
  readonly installed: boolean;
  readonly discarded: boolean;
  readonly overflow: boolean;
  readonly reason: 'installed' | 'coverage-overflow' | 'refinement-overflow' | 'missing-reservation';
}

export interface TerrainResidencyStats {
  readonly allocationBytes: number;
  readonly softTargetBytes: number;
  readonly installedBytes: number;
  readonly reservedBytes: number;
  readonly protectedBytes: number;
  readonly evictableBytes: number;
  readonly residentCount: number;
  readonly reservationCount: number;
  readonly overflow: boolean;
}

export class TerrainResidencyManager implements TerrainReservationPort {
  readonly hardReservationBytes: number;
  readonly softTargetBytes: number;
  private readonly reservations = new Map<string, TerrainReservation>();
  private readonly residents = new Map<string, TerrainResidentResource>();
  private readonly permanentProtection = new Set<string>();
  private frameProtection = new Set<string>();
  private currentFrame = 0;
  private installedTotal = 0;
  private reservedTotal = 0;
  private overflowPaused = false;

  constructor(allocationBytes: number, softTargetRatio = 0.75) {
    if (!Number.isInteger(allocationBytes) || allocationBytes < 0) {
      throw new Error(`Invalid terrain allocation ${allocationBytes}`);
    }
    if (!Number.isFinite(softTargetRatio) || softTargetRatio < 0 || softTargetRatio > 1) {
      throw new Error(`Invalid terrain soft-target ratio ${softTargetRatio}`);
    }
    this.hardReservationBytes = allocationBytes;
    this.softTargetBytes = Math.floor(allocationBytes * softTargetRatio);
  }

  beginFrame(frame: number, protectedKeys: ReadonlySet<string> = new Set()): void {
    if (!Number.isInteger(frame) || frame < 0) throw new Error(`Invalid terrain residency frame ${frame}`);
    this.currentFrame = frame;
    this.frameProtection = new Set(protectedKeys);
  }

  protectPermanently(key: string): void { this.permanentProtection.add(key); }
  unprotectPermanently(key: string): void { this.permanentProtection.delete(key); }

  tryReserve(key: string, bytes: number, requestClass: TerrainRequestClass): boolean {
    if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`Invalid terrain reservation ${bytes}`);
    if (this.reservations.has(key) || this.overflowPaused) return false;
    if (this.installedTotal + this.reservedTotal + bytes > this.hardReservationBytes) return false;
    this.reservations.set(key, Object.freeze({ bytes, requestClass }));
    this.reservedTotal += bytes;
    return true;
  }

  releaseReservation(key: string): boolean {
    const reservation = this.reservations.get(key);
    if (!reservation) return false;
    this.reservations.delete(key);
    this.reservedTotal -= reservation.bytes;
    this.refreshOverflowPause();
    return true;
  }

  reservationBytes(): number { return this.reservedTotal; }

  commitInstallation(
    reservationKey: string,
    resourceKey: string,
    actualBytes: number,
    requiredForCoverage = false,
  ): TerrainInstallationDecision {
    if (!Number.isInteger(actualBytes) || actualBytes < 0) {
      throw new Error(`Invalid installed terrain bytes ${actualBytes}`);
    }
    const reservation = this.reservations.get(reservationKey);
    if (!reservation) {
      return Object.freeze({
        installed: false,
        discarded: true,
        overflow: this.isOverflowing(),
        reason: 'missing-reservation',
      });
    }
    this.reservations.delete(reservationKey);
    this.reservedTotal -= reservation.bytes;
    const existing = this.residents.get(resourceKey);
    const projectedInstalled = this.installedTotal - (existing?.bytes ?? 0) + actualBytes;
    const projectedTotal = projectedInstalled + this.reservedTotal;
    const coverage = requiredForCoverage
      || reservation.requestClass === 'coverage-blocker'
      || reservation.requestClass === 'previous-frame-continuity';
    if (projectedTotal > this.hardReservationBytes && !coverage) {
      this.refreshOverflowPause();
      return Object.freeze({
        installed: false,
        discarded: true,
        overflow: this.isOverflowing(),
        reason: 'refinement-overflow',
      });
    }
    this.installedTotal = projectedInstalled;
    this.residents.set(resourceKey, Object.freeze({
      key: resourceKey,
      bytes: actualBytes,
      lastUsedFrame: this.currentFrame,
    }));
    const overflow = projectedTotal > this.hardReservationBytes;
    this.overflowPaused = overflow;
    return Object.freeze({
      installed: true,
      discarded: false,
      overflow,
      reason: overflow ? 'coverage-overflow' : 'installed',
    });
  }

  installCoverageWithoutReservation(resourceKey: string, actualBytes: number): TerrainInstallationDecision {
    if (!Number.isInteger(actualBytes) || actualBytes < 0) {
      throw new Error(`Invalid installed terrain bytes ${actualBytes}`);
    }
    const existing = this.residents.get(resourceKey);
    this.installedTotal = this.installedTotal - (existing?.bytes ?? 0) + actualBytes;
    this.residents.set(resourceKey, Object.freeze({
      key: resourceKey,
      bytes: actualBytes,
      lastUsedFrame: this.currentFrame,
    }));
    this.refreshOverflowPause();
    return Object.freeze({
      installed: true,
      discarded: false,
      overflow: this.isOverflowing(),
      reason: this.isOverflowing() ? 'coverage-overflow' : 'installed',
    });
  }

  markUsed(key: string): boolean {
    const resource = this.residents.get(key);
    if (!resource) return false;
    this.residents.set(key, Object.freeze({ ...resource, lastUsedFrame: this.currentFrame }));
    return true;
  }

  isProtected(key: string): boolean {
    return this.permanentProtection.has(key) || this.frameProtection.has(key);
  }

  removeInstalled(key: string, force = false): boolean {
    const resource = this.residents.get(key);
    if (!resource || (!force && this.isProtected(key))) return false;
    this.residents.delete(key);
    this.installedTotal -= resource.bytes;
    this.refreshOverflowPause();
    return true;
  }

  trimToSoftTarget(): readonly string[] {
    const evicted: string[] = [];
    const candidates = [...this.residents.values()]
      .filter((resource) => !this.isProtected(resource.key))
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame || a.key.localeCompare(b.key));
    for (const resource of candidates) {
      if (this.installedTotal <= this.softTargetBytes) break;
      if (!this.removeInstalled(resource.key)) continue;
      evicted.push(resource.key);
    }
    this.refreshOverflowPause();
    return Object.freeze(evicted);
  }

  residentKeys(): readonly string[] {
    return Object.freeze([...this.residents.keys()].sort());
  }

  clear(): void {
    this.reservations.clear();
    this.residents.clear();
    this.permanentProtection.clear();
    this.frameProtection.clear();
    this.installedTotal = 0;
    this.reservedTotal = 0;
    this.overflowPaused = false;
  }

  stats(): TerrainResidencyStats {
    let protectedBytes = 0;
    for (const resource of this.residents.values()) {
      if (this.isProtected(resource.key)) protectedBytes += resource.bytes;
    }
    return Object.freeze({
      allocationBytes: this.hardReservationBytes,
      softTargetBytes: this.softTargetBytes,
      installedBytes: this.installedTotal,
      reservedBytes: this.reservedTotal,
      protectedBytes,
      evictableBytes: this.installedTotal - protectedBytes,
      residentCount: this.residents.size,
      reservationCount: this.reservations.size,
      overflow: this.isOverflowing(),
    });
  }

  private isOverflowing(): boolean {
    return this.installedTotal + this.reservedTotal > this.hardReservationBytes;
  }

  private refreshOverflowPause(): void { this.overflowPaused = this.isOverflowing(); }
}
