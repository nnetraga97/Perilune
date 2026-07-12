import { lstat, rename, rm } from 'node:fs/promises';

async function exists(path, statFile) {
  try {
    await statFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Publish a staged set as one generation, restoring every prior target on failure. */
export async function publishFilesAtomically(entries, operations = {}) {
  const renameFile = operations.renameFile ?? rename;
  const removePath = operations.removePath ?? rm;
  const statFile = operations.statFile ?? lstat;
  const records = entries.map(({ stagedPath, targetPath }, index) => ({
    stagedPath,
    targetPath,
    backupPath: `${targetPath}.backup-${process.pid}-${index}`,
    backedUp: false,
    published: false,
  }));

  for (const record of records) {
    if (!await exists(record.stagedPath, statFile)) throw new Error(`Missing staged publication file: ${record.stagedPath}`);
  }
  for (const record of records) await removePath(record.backupPath, { recursive: true, force: true });
  try {
    for (const record of records) {
      if (await exists(record.targetPath, statFile)) {
        await renameFile(record.targetPath, record.backupPath);
        record.backedUp = true;
      }
      await renameFile(record.stagedPath, record.targetPath);
      record.published = true;
    }
  } catch (publishError) {
    const rollbackErrors = [];
    for (const record of [...records].reverse()) {
      try {
        if (record.published) await removePath(record.targetPath, { recursive: true, force: true });
        if (record.backedUp) await renameFile(record.backupPath, record.targetPath);
      } catch (error) {
        rollbackErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const detail = rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join('; ')}` : '';
    throw new Error(`Atomic file publication failed: ${publishError instanceof Error ? publishError.message : publishError}${detail}`, {
      cause: publishError,
    });
  }

  await Promise.all(records.map((record) => removePath(record.backupPath, { recursive: true, force: true })));
}

/** Swap a fully validated staged directory into place, restoring the prior tree on failure. */
export async function swapDirectoryAtomically({ stagedPath, targetPath, backupPath }, operations = {}) {
  const renameFile = operations.renameFile ?? rename;
  const removePath = operations.removePath ?? rm;
  const statFile = operations.statFile ?? lstat;
  let backedUp = false;
  let published = false;
  if (!await exists(stagedPath, statFile)) throw new Error(`Missing staged publication directory: ${stagedPath}`);
  await removePath(backupPath, { recursive: true, force: true });
  try {
    if (await exists(targetPath, statFile)) {
      await renameFile(targetPath, backupPath);
      backedUp = true;
    }
    await renameFile(stagedPath, targetPath);
    published = true;
  } catch (publishError) {
    const rollbackErrors = [];
    try {
      if (published) await removePath(targetPath, { recursive: true, force: true });
      if (backedUp) await renameFile(backupPath, targetPath);
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error));
    }
    const detail = rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join('; ')}` : '';
    throw new Error(`Atomic directory publication failed: ${publishError instanceof Error ? publishError.message : publishError}${detail}`, {
      cause: publishError,
    });
  }
  await removePath(backupPath, { recursive: true, force: true });
}
