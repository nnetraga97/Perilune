/**
 * Perilune entry point. Routes to prototype harnesses (`?proto=...`) or the
 * game shell.
 */
import { RenderCapabilityError } from './render/context';
import { parseRenderStartupOptions } from './render/renderStartupOptions';
import { browserProfileStore } from './ui/profileStore';
import { telemetry } from './telemetry/service';
import { clientLog } from './telemetry/log';

const params = new URLSearchParams(location.search);
const proto = params.get('proto');
const renderStartupOptions = parseRenderStartupOptions(location.search);
const telemetryPreference = browserProfileStore().get<{ telemetryEnabled?: boolean }>('settings', {});
telemetry.start(telemetryPreference.telemetryEnabled ?? true);

function setBoot(status: string, progress: number): void {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = status;
  const bar = document.getElementById('boot-progress');
  if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
}

async function boot(): Promise<void> {
  setBoot('loading systems', 0.2);
  if (proto === 'terrain') {
    const { runTerrainProto } = await import('./proto/terrainProto');
    await runTerrainProto();
    return;
  }
  if (proto === 'feasibility') {
    const { runFeasibilityProto } = await import('./proto/feasibilityProto');
    await runFeasibilityProto();
    return;
  }
  setBoot('starting game', 0.6);
  const { startGame } = await import('./game');
  await startGame(renderStartupOptions);
}

boot().catch((err) => {
  clientLog.error('client.boot.error', err, {
    source: proto ? 'prototype' : 'game',
    errorType: err instanceof Error ? err.name : 'UnknownError',
  });
  if (err instanceof RenderCapabilityError) {
    setBoot(err.message, 0);
    return;
  }
  setBoot(`boot failed: ${err instanceof Error ? err.message : String(err)}`, 0);
});
