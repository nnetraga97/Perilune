import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const compilerArgs = process.argv.slice(2).filter((argument) => argument !== '--release' && argument !== '--native');

function dockerArchitecture() {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Arch}}'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not detect Docker architecture: ${result.error?.message ?? result.stderr}`);
  }
  const architecture = result.stdout.trim();
  if (architecture === 'arm64' || architecture === 'aarch64') return 'arm64';
  if (architecture === 'amd64' || architecture === 'x86_64') return 'amd64';
  throw new Error(`Unsupported Docker architecture: ${architecture}`);
}

// Local authoring follows the Docker server architecture to avoid QEMU. The
// release switch preserves the original pinned linux/amd64 reproduction path.
const architecture = release ? 'amd64' : dockerArchitecture();
const platform = `linux/${architecture}`;
const image = `perilune-planet-assets:ktx-4.4.2-${architecture}`;

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
const mountedRun = [
  'run', '--rm',
  '--platform', platform,
  '--mount', `type=bind,source=${assetsPath},target=/workspace/assets/planets`,
  '--mount', `type=bind,source=${generatedMetadataPath},target=/workspace/src/generated`,
];

console.log(`Planet asset compiler mode: ${release ? 'release' : 'native authoring'} (${platform})`);
run([
  ...mountedRun,
  image,
  'npm', 'run', 'compile:planet-assets', '--', '--write', ...compilerArgs,
], 'Planet asset generation');
run([
  ...mountedRun,
  image,
  'npm', 'run', 'validate:content',
], 'Planet asset validation');
