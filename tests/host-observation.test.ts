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
  function observe(powerSource: 'Battery Power' | 'AC Power') {
    const commands: string[] = [];
    const host = observeSanitizedMacHost((command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      if (command === 'system_profiler') return profiler;
      if (command === 'sw_vers' && args[0] === '-productVersion') return '15.5\n';
      if (command === 'sw_vers') return '24F74\n';
      if (args.join(' ') === '-g batt') return `Now drawing from '${powerSource}'\n`;
      return 'Battery Power:\n powermode 1\n standby 1\nAC Power:\n powermode 0\n standby 1\n';
    });
    return { commands, host };
  }

  it('selects only certification evidence from system_profiler, sw_vers, and pmset', () => {
    const { commands, host } = observe('AC Power');
    expect(commands).toEqual(expect.arrayContaining([
      'system_profiler SPHardwareDataType SPDisplaysDataType -json',
      'sw_vers -productVersion', 'sw_vers -buildVersion', 'pmset -g batt', 'pmset -g custom',
    ]));
    expect(host).toEqual({
      modelName: 'MacBook Pro', modelIdentifier: 'Mac15,10', chip: 'Apple M3 Max',
      gpuCoreCount: 30, memoryBytes: 36 * 1024 ** 3, firmwareVersion: '11881.121.1',
      osVersion: '15.5', osBuild: '24F74', powerSource: 'AC Power', powerMode: 0,
    });
    expect(JSON.stringify(host)).not.toMatch(/SECRET|serial|uuid|udid/i);
  });

  it('uses the powermode from the currently active power-source section', () => {
    expect(observe('Battery Power').host.powerMode).toBe(1);
    expect(observe('AC Power').host.powerMode).toBe(0);
  });
});
