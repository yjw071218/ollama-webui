// Moves risu_assets bytes out of SQLite into server/data/risu-assets/<user>/<hash>.
// Safe while the server runs (WAL, small batches) and safe to re-run: each
// row is cleared only after its file is written and its SHA-256 re-checked.
//   node scripts/migrate-risu-assets.mjs [--batch 100] [--dry-run]
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RISU_ASSET_DIR, writeRisuAssetFile, ensureRisuAssetColumns } from '../server/risuSync.js';

const args = process.argv.slice(2);
const batch = Number(args[args.indexOf('--batch') + 1]) || 100;
const dryRun = args.includes('--dry-run');
const dbFile = fileURLToPath(new URL('../server/data/webui.db', import.meta.url));

const sql = new DatabaseSync(dbFile);
sql.exec('PRAGMA busy_timeout = 10000');

const total = sql.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(bytes)),0) AS b FROM risu_assets WHERE length(bytes) > 0').get();
console.log(`남은 에셋: ${total.n}개, ${(total.b / 1048576).toFixed(1)}MB${dryRun ? ' (dry run)' : ''}`);
if (dryRun) process.exit(0);
// Adding columns breaks the pre-update server's 3-value INSERT, so this must
// only run after the server has restarted on the new risuSync.js.
ensureRisuAssetColumns(sql);

const next = sql.prepare('SELECT user_id, hash, bytes FROM risu_assets WHERE length(bytes) > 0 LIMIT ?');
const clear = sql.prepare("UPDATE risu_assets SET bytes = x'', size = ?, created = COALESCE(created, ?) WHERE user_id = ? AND hash = ? AND length(bytes) > 0");
let moved = 0, bytesMoved = 0;
for (;;) {
  const rows = next.all(batch);
  if (!rows.length) break;
  for (const row of rows) {
    const bytes = Buffer.from(row.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== row.hash) throw new Error(`DB 데이터 해시 불일치: ${row.hash} — 중단합니다.`);
    const file = writeRisuAssetFile(DEFAULT_RISU_ASSET_DIR, row.user_id, row.hash, bytes);
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== row.hash) throw new Error(`파일 검증 실패: ${file} — 중단합니다.`);
  }
  sql.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) clear.run(row.bytes.length, Date.now(), row.user_id, row.hash);
    sql.exec('COMMIT');
  } catch (error) { sql.exec('ROLLBACK'); throw error; }
  moved += rows.length;
  bytesMoved += rows.reduce((s, r) => s + r.bytes.length, 0);
  console.log(`  ${moved}/${total.n}개 (${(bytesMoved / 1048576).toFixed(1)}MB)`);
}
console.log('완료. 파일 크기를 실제로 줄이려면 한가할 때 VACUUM을 실행하세요.');
sql.close();
