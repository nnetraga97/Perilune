import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = 'linux/amd64';
const image = 'perilune-part-assets:gltf-transform-4.3.0-ktx-4.4.2';

function run(args, label) {
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

run([
  'build',
  '--platform', platform,
  '--file', 'tools/planet-assets/Dockerfile',
  '--tag', image,
  '.',
], 'Part compiler image build');

run([
  'run', '--rm',
  '--platform', platform,
  '--mount', `type=bind,source=${resolve(root, 'assets/parts')},target=/workspace/assets/parts`,
  '--mount', `type=bind,source=${resolve(root, 'assets/planets')},target=/workspace/assets/planets,readonly`,
  '--mount', `type=bind,source=${resolve(root, 'src/generated')},target=/workspace/src/generated`,
  image,
  'sh', '-c',
  'npm run compile:part-assets -- --write && npm run validate:content',
], 'Part asset generation');
