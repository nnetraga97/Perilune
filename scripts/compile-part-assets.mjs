import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Bytes } from './lib/canonical-json.mjs';
import {
  loadPartAssetInputs,
  validatePartAssetDocuments,
} from './lib/part-asset-schema.mjs';
import { inspectGlb } from './lib/glb-stats.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function checkedPath(base, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) ||
    relativePath.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(relativePath) ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const target = resolve(base, relativePath);
  const fromBase = relative(base, target);
  if (!fromBase || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new Error(`${label} must remain below ${base}`);
  }
  return target;
}

function optimizeWithCli({ inputPath, outputPath, simplifyRatio, textureMaxDimension }) {
  const executable = process.env.GLTF_TRANSFORM_CLI ?? 'gltf-transform';
  const args = [
    'optimize', inputPath, outputPath,
    '--compress', 'meshopt',
    '--meshopt-level', 'high',
    '--flatten', 'true',
    '--join', 'true',
    '--prune', 'true',
    '--weld', 'true',
    '--simplify', 'true',
    '--simplify-ratio', String(simplifyRatio),
    '--simplify-error', '0.0005',
    '--simplify-lock-border', 'true',
    '--texture-compress', 'ktx2',
    '--texture-size', String(textureMaxDimension),
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`glTF Transform could not start: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `glTF Transform failed (${code === null ? `signal ${signal}` : `exit ${code}`}): ` +
        `${stderr.trim() || stdout.trim() || 'no diagnostic output'}`,
      ));
    });
  });
}

function enforceBounds(stats, recipe) {
  for (let axis = 0; axis < 3; axis++) {
    if (stats.boundsMin[axis] < recipe.visualBounds.min[axis] ||
      stats.boundsMax[axis] > recipe.visualBounds.max[axis]) {
      throw new Error(
        `Compiled part ${recipe.assetId} exceeds visual bounds on axis ${axis}: ` +
        `[${stats.boundsMin[axis]}, ${stats.boundsMax[axis]}] is outside ` +
        `[${recipe.visualBounds.min[axis]}, ${recipe.visualBounds.max[axis]}]`,
      );
    }
  }
}

/** Compile and validate all normalized authoring models declared by part recipes. */
export async function compilePartAssets({ root = defaultRoot, write = false, optimize = optimizeWithCli } = {}) {
  const { sources, recipes } = loadPartAssetInputs(root);
  const inputErrors = validatePartAssetDocuments(sources, recipes);
  if (inputErrors.length) throw new Error(`Part asset inputs are invalid:\n${inputErrors.join('\n')}`);

  const partRoot = resolve(root, 'assets/parts');
  const models = [];
  const pending = [];
  try {
    for (const recipe of recipes.models) {
      const authoringPath = recipe.authoringPath ?? `authoring/${recipe.assetId}.glb`;
      const outputPath = recipe.outputPath ?? `generated/${recipe.assetId}.glb`;
      const inputPath = checkedPath(partRoot, authoringPath, `Part recipe ${recipe.assetId} authoringPath`);
      const finalPath = checkedPath(partRoot, outputPath, `Part recipe ${recipe.assetId} outputPath`);
      if (!finalPath.toLowerCase().endsWith('.glb')) {
        throw new Error(`Part recipe ${recipe.assetId} outputPath must end in .glb`);
      }
      // glTF Transform infers the output encoding from the last suffix. Keep
      // .glb last so the checked temporary artifact is binary glTF.
      const partialPath = finalPath.replace(/\.glb$/i, '.partial.glb');
      await mkdir(dirname(finalPath), { recursive: true });
      await rm(partialPath, { force: true });
      const directoryBefore = new Set(await readdir(dirname(finalPath)));
      let unexpectedSidecars = [];

      const sourceStats = inspectGlb(await readFile(inputPath));
      if (sourceStats.triangles <= 0) throw new Error(`Authoring part ${recipe.assetId} has no indexed triangles`);
      const simplifyRatio = Math.min(1, recipe.triangleLimit / sourceStats.triangles);
      try {
        await optimize({ inputPath, outputPath: partialPath, simplifyRatio, textureMaxDimension: recipe.textureMaxDimension, recipe });
        unexpectedSidecars = (await readdir(dirname(finalPath)))
          .filter((name) => !directoryBefore.has(name) && name !== basename(partialPath))
          .map((name) => resolve(dirname(finalPath), name));
        if (unexpectedSidecars.length) {
          throw new Error(
            `glTF Transform emitted unexpected sidecars for ${recipe.assetId}: ` +
            unexpectedSidecars.map((path) => basename(path)).join(', '),
          );
        }
        const bytes = await readFile(partialPath);
        const stats = inspectGlb(bytes);
        if (stats.triangles > recipe.triangleLimit) {
          throw new Error(`Compiled part ${recipe.assetId} has ${stats.triangles} triangles; limit is ${recipe.triangleLimit}`);
        }
        if (recipe.animationPolicy === 'none' && stats.animationClips !== 0) {
          throw new Error(`Compiled part ${recipe.assetId} contains ${stats.animationClips} animation clips`);
        }
        enforceBounds(stats, recipe);
        const transferBytes = (await stat(partialPath)).size;
        const gpuBytes = stats.geometryBytes + stats.textureBytes;
        if (Number.isSafeInteger(recipe.transferLimit) && transferBytes > recipe.transferLimit) {
          throw new Error(`Compiled part ${recipe.assetId} exceeds its transferLimit`);
        }
        if (Number.isSafeInteger(recipe.gpuLimit) && gpuBytes > recipe.gpuLimit) {
          throw new Error(`Compiled part ${recipe.assetId} exceeds its gpuLimit`);
        }
        models.push({
          assetId: recipe.assetId,
          partId: recipe.partId,
          outputPath,
          sha256: sha256Bytes(bytes),
          triangles: stats.triangles,
          transferBytes,
          gpuBytes,
          boundsMin: stats.boundsMin,
          boundsMax: stats.boundsMax,
          plumeAnchors: recipe.plumeAnchors,
        });
        pending.push({ partialPath, finalPath });
      } catch (error) {
        const newPaths = (await readdir(dirname(finalPath)))
          .filter((name) => !directoryBefore.has(name))
          .map((name) => resolve(dirname(finalPath), name));
        await Promise.all(newPaths.map((path) => rm(path, { recursive: true, force: true })));
        throw error;
      }
    }

    models.sort((a, b) => a.assetId.localeCompare(b.assetId));
    const totals = models.reduce((sum, model) => ({
      totalTriangleLimit: sum.totalTriangleLimit + model.triangles,
      totalTransferBytes: sum.totalTransferBytes + model.transferBytes,
      totalGpuBytes: sum.totalGpuBytes + model.gpuBytes,
    }), { totalTriangleLimit: 0, totalTransferBytes: 0, totalGpuBytes: 0 });
    for (const [name, total] of Object.entries(totals)) {
      if (total > recipes.budgets[name]) {
        throw new Error(`Compiled part assets exceed ${name}: ${total} > ${recipes.budgets[name]}`);
      }
    }

    const manifest = { schemaVersion: 1, models };
    const artifact = { schemaVersion: 1, manifestSha256: sha256Bytes(canonicalJson(manifest)), manifest };
    if (write) {
      for (const { partialPath, finalPath } of pending) await rename(partialPath, finalPath);
      const artifactPath = resolve(root, 'src/generated/checked-part-manifest.json');
      const artifactPartialPath = `${artifactPath}.partial`;
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPartialPath, `${canonicalJson(artifact)}\n`);
      await rename(artifactPartialPath, artifactPath);
      console.log(`part assets: wrote ${models.length} checked models`);
    } else {
      for (const { partialPath } of pending) await rm(partialPath, { force: true });
      console.log(`part assets: verified ${models.length} checked models (dry run)`);
    }
    return artifact;
  } catch (error) {
    await Promise.all(pending.map(({ partialPath }) => rm(partialPath, { force: true })));
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await compilePartAssets({ root: defaultRoot, write: process.argv.includes('--write') });
}
