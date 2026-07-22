import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { canonicalJson, SAVE_FINGERPRINT_VERSION } from '../src/save/canonicalJson.ts';

const databaseUrl = process.env.POSTGRES_URL_NON_POOLING;
if (!databaseUrl) throw new Error('POSTGRES_URL_NON_POOLING is required');
const sql = postgres(databaseUrl, { max: 1, ssl: 'require' });
let scanned = 0;
let updated = 0;
let raced = 0;
let afterUserId = null;
let afterSlot = null;

try {
  for (;;) {
    const rows = afterUserId === null
      ? await sql`
          select user_id, slot, payload, payload_hash
          from public.cloud_saves
          where fingerprint_version = 1
          order by user_id, slot
          limit 100
        `
      : await sql`
          select user_id, slot, payload, payload_hash
          from public.cloud_saves
          where fingerprint_version = 1
            and (user_id, slot) > (${afterUserId}::uuid, ${afterSlot})
          order by user_id, slot
          limit 100
        `;
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned++;
      const payloadHash = createHash('sha256').update(canonicalJson(row.payload)).digest('hex');
      const result = await sql`
        update public.cloud_saves
        set payload_hash = ${payloadHash}, fingerprint_version = ${SAVE_FINGERPRINT_VERSION}
        where user_id = ${row.user_id}
          and slot = ${row.slot}
          and payload_hash = ${row.payload_hash}
          and fingerprint_version = 1
        returning 1
      `;
      if (result.length === 1) updated++;
      else raced++;
    }
    afterUserId = rows.at(-1).user_id;
    afterSlot = rows.at(-1).slot;
  }
  console.log(`cloud fingerprint backfill: scanned=${scanned} updated=${updated} raced=${raced}`);
} finally {
  await sql.end();
}
