import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function parseMemoryBytes(value) {
  const match = String(value ?? '').match(/([\d.]+)\s*(GB|GiB)/i);
  if (!match) return 0;
  return Math.round(Number(match[1]) * 1024 ** 3);
}

function parseActivePowerMode(output, powerSource) {
  let activeSection = false;
  for (const line of output.split(/\r?\n/)) {
    const section = line.match(/^(Battery|AC) Power:\s*$/);
    if (section) {
      activeSection = `${section[1]} Power` === powerSource;
      continue;
    }
    if (!activeSection) continue;
    const mode = line.match(/^\s*powermode\s+(\d+)\s*$/);
    if (mode) return Number(mode[1]);
  }
  return -1;
}

/**
 * Returns a strict allowlist of host facts. Raw command output is never
 * returned because system_profiler includes serial numbers and stable IDs.
 */
export function observeSanitizedMacHost(runCommand = run) {
  const report = JSON.parse(runCommand(
    'system_profiler',
    ['SPHardwareDataType', 'SPDisplaysDataType', '-json'],
  ));
  const hardware = report.SPHardwareDataType?.[0] ?? {};
  const display = report.SPDisplaysDataType?.[0] ?? {};
  const battery = runCommand('pmset', ['-g', 'batt']);
  const power = runCommand('pmset', ['-g', 'custom']);
  const sourceMatch = battery.match(/Now drawing from '([^']+)'/);
  const coreValue = display.sppci_cores ?? display.spdisplays_gpu_cores ?? display.gpu_cores;

  return Object.freeze({
    modelName: String(hardware.machine_name ?? ''),
    modelIdentifier: String(hardware.machine_model ?? ''),
    chip: String(hardware.chip_type ?? display._name ?? ''),
    gpuCoreCount: Number.parseInt(String(coreValue ?? ''), 10) || 0,
    memoryBytes: parseMemoryBytes(hardware.physical_memory),
    firmwareVersion: String(hardware.boot_rom_version ?? hardware.system_firmware_version ?? ''),
    osVersion: runCommand('sw_vers', ['-productVersion']).trim(),
    osBuild: runCommand('sw_vers', ['-buildVersion']).trim(),
    powerSource: sourceMatch?.[1] ?? '',
    powerMode: parseActivePowerMode(power, sourceMatch?.[1] ?? ''),
  });
}
