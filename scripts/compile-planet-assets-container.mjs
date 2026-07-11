import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = 'linux/amd64';
const image = 'perilune-planet-assets:ktx-4.4.2';

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
], 'Planet compiler image build');

const assetsPath = resolve(root, 'assets/planets');
const generatedMetadataPath = resolve(root, 'src/generated');
run([
  'run', '--rm',
  '--platform', platform,
  '--mount', `type=bind,source=${assetsPath},target=/workspace/assets/planets`,
  '--mount', `type=bind,source=${generatedMetadataPath},target=/workspace/src/generated`,
  image,
  'sh', '-lc',
  'npm run compile:planet-assets -- --write && npm run validate:content',
], 'Planet asset generation');
