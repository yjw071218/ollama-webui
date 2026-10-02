// Bring assets/danbooru-tags.csv up to date with danbooru.
//
//   node scripts/update-tags.mjs                 # tags with 50+ posts, written in place
//   node scripts/update-tags.mjs --min=200       # a higher threshold
//   node scripts/update-tags.mjs --dry-run       # fetch and merge, write .new only
//
// Why this exists: the file is the authority the server corrects prompts
// against -- a bracket it does not know is removed from a model's prompt -- and
// a list from last month does not know last month's characters. `arisu (blue
// archive)` is a real danbooru tag that this file did not have.
//
// What it keeps: every row already in the file, with its Korean description,
// which is the half of the file that is worth having and that danbooru does not
// provide. What it adds: tags the file did not have (with no description --
// they are found by their English name only), today's post counts, and the
// category, which the file carried as 0 for every row.
//
// Safe to interrupt: the new file is written beside the old one and swapped in
// only once it is complete, and the old one is kept as `.bak`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const B = await import(pathToFileURL(path.join(ROOT, 'server/booruTags.js')).href);

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MIN_POSTS = Math.max(1, Number(arg('min', 50)) || 50);
const DRY = process.argv.includes('--dry-run');
const PAGE = 1000;
// Danbooru serves tag pages up to 1000; past that it wants a cursor. The cursor
// is the id, which is what `page=b<id>` means in its API.
const MAX_PAGES = Math.max(1, Number(arg('pages', 400)) || 400);

/* The same mirrors the booru importer tries, because the main host is blocked
   on some networks and these carry the same database. */
const HOSTS = ['danbooru.donmai.us', ...B.DANBOORU_MIRRORS];

const fetchPage = async (cursor) => {
  const query = new URLSearchParams({
    'search[post_count]': `>=${MIN_POSTS}`,
    'search[hide_empty]': 'true',
    limit: String(PAGE),
    // Walk by id, which is stable while the list is being read; ordering by
    // count shifts under a reader as posts are tagged.
    page: cursor ? `b${cursor}` : '1',
    'only': 'id,name,post_count,category,is_deprecated',
  });
  let lastError = null;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`https://${host}/tags.json?${query}`, {
        headers: { 'User-Agent': 'ollama-webui tag list update' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('no host answered');
};

const existing = [];
if (fs.existsSync(B.TAG_FILE)) {
  B.parseCsv(fs.readFileSync(B.TAG_FILE, 'utf8'), (row) => {
    // The same test `loadTags` uses: a row whose count is not a number is the
    // spill of a broken description, not a tag.
    if (!row[0] || !/^\d+$/.test(row[2] || '')) return;
    existing.push({ name: row[0].trim(), category: Number(row[1]) || 0, count: Number(row[2]) || 0, description: row[3] || '' });
  });
}
console.log(`existing: ${existing.length.toLocaleString()} tags`);

const fetched = [];
let cursor = 0;
for (let page = 0; page < MAX_PAGES; page += 1) {
  let batch;
  try {
    batch = await fetchPage(cursor);
  } catch (e) {
    console.error(`stopped at page ${page + 1}: ${e.message}`);
    if (fetched.length === 0) {
      console.error('nothing was fetched; the file is unchanged');
      process.exit(1);
    }
    console.error('merging what was fetched so far');
    break;
  }
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const tag of batch) {
    const row = B.rowFromApiTag(tag);
    if (row) fetched.push(row);
  }
  // `b<id>` asks for ids below it, so the next cursor is the smallest seen.
  cursor = Math.min(...batch.map(t => Number(t.id)).filter(Number.isFinite));
  process.stdout.write(`\rfetched ${fetched.length.toLocaleString()} tags`);
  if (batch.length < PAGE) break;
  // Politeness: danbooru rate-limits anonymous readers.
  await new Promise(r => setTimeout(r, 1100));
}
process.stdout.write('\n');

const { rows, added, updated } = B.mergeTagRows(existing, fetched);
console.log(`merged: ${rows.length.toLocaleString()} tags (${added.toLocaleString()} new, ${updated.toLocaleString()} updated)`);

const body = rows.map(r => B.csvRow([r.name, r.category, r.count, r.description])).join('\n') + '\n';
const next = `${B.TAG_FILE}.new`;
fs.writeFileSync(next, body, 'utf8');

// Read back before swapping: a file this parser cannot read is not an update.
let readable = 0;
B.parseCsv(fs.readFileSync(next, 'utf8'), (row) => { if (/^\d+$/.test(row[2] || '')) readable += 1; });
if (readable !== rows.length) {
  console.error(`the new file reads back as ${readable} rows, not ${rows.length}; left at ${next}`);
  process.exit(1);
}

if (DRY) {
  console.log(`dry run: written to ${path.relative(ROOT, next)} and not swapped in`);
  process.exit(0);
}
if (fs.existsSync(B.TAG_FILE)) fs.copyFileSync(B.TAG_FILE, `${B.TAG_FILE}.bak`);
fs.renameSync(next, B.TAG_FILE);
console.log(`updated ${path.relative(ROOT, B.TAG_FILE)} (old copy kept as .bak). Restart the server to load it.`);
