import { describe, expect, it } from 'vitest';
import { observeSanitizedMacHost } from '../scripts/lib/host-observation.mjs';

const profiler = JSON.stringify({
  SPHardwareDataType: [{
    machine_name: 'MacBook Pro', machine_model: 'Mac15,10', chip_type: 'Apple M3 Max',
    physical_memory: '36 GB', boot_rom_version: '11881.121.1', serial_number: 'SECRET-SERIAL',
    platform_UUID: 'SECRET-UUID', provisioning_UDID: 'SECRET-UDID',
  }],
  SPDisplaysDataType: [{ sppci_cores: '30', spdisplays_vendor: 'Apple', _name: 'Apple M3 Max' }],
});

describe('sanitized host observation', () => {
  it('selects only certification evidence from system_profiler, sw_vers, and pmset', () => {
    const commands: string[] = [];
    const host = observeSanitizedMacHost((command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      if (command === 'system_profiler') return profiler;
      if (command === 'sw_vers' && args[0] === '-productVersion') return '15.5\n';
      if (command === 'sw_vers') return '24F74\n';
      if (args.join(' ') === '-g batt') return "Now drawing from 'Battery Power'\n";
      return ' powermode 0\n';
    });
    expect(commands).toEqual(expect.arrayContaining([
      'system_profiler SPHardwareDataType SPDisplaysDataType -json',
      'sw_vers -productVersion', 'sw_vers -buildVersion', 'pmset -g batt', 'pmset -g custom',
    ]));
    expect(host).toEqual({
      modelName: 'MacBook Pro', modelIdentifier: 'Mac15,10', chip: 'Apple M3 Max',
      gpuCoreCount: 30, memoryBytes: 36 * 1024 ** 3, firmwareVersion: '11881.121.1',
      osVersion: '15.5', osBuild: '24F74', powerSource: 'Battery Power', powerMode: 0,
    });
    expect(JSON.stringify(host)).not.toMatch(/SECRET|serial|uuid|udid/i);
  });
});
