/** Launch hardware is driven by simulation time, never by renderer delta time. */
export interface PadLaunchSequence {
  startedAt: number | null;
  releasedAt: number | null;
}
export const PAD_CLEARANCE_SECONDS = 4;
const fraction = (elapsed: number, start: number, end: number) => Math.max(0, Math.min(1, (elapsed-start)/(end-start)));
export function padDeployFractions(sequence: PadLaunchSequence | undefined, time: number) {
  // No vessel at the pad: park the hardware safely away from the launch axis.
  const elapsed=sequence ? sequence.startedAt === null ? -Infinity : time-sequence.startedAt : Infinity;
  return {
    'crew-access': fraction(elapsed,0,2.5),
    'umbilical-upper': fraction(elapsed,2,3.4),
    'umbilical-lower': fraction(elapsed,2.2,3.6),
    'clamp-ne': fraction(elapsed,3.5,4),
    'clamp-nw': fraction(elapsed,3.5,4),
    'clamp-se': fraction(elapsed,3.5,4),
    'clamp-sw': fraction(elapsed,3.5,4),
  };
}
/** Once released the mechanism stays clear, even if throttle is reduced. */
export function advancePadSequence(sequence: PadLaunchSequence, time: number, canThrust: boolean): boolean {
  if(sequence.releasedAt !== null) return true;
  if(!canThrust) { sequence.startedAt=null; return false; }
  sequence.startedAt ??= time;
  if(time-sequence.startedAt < PAD_CLEARANCE_SECONDS) return false;
  sequence.releasedAt=time;
  return true;
}
