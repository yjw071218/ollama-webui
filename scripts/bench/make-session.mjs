// Real-data bench: a sign-in for one account, in a SNAPSHOT data dir only.
//   WEBUI_DATA_DIR=<snapshotDir> node scripts/bench/make-session.mjs <userId>
// Refuses to run against the live server/data directory.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const live = path.resolve(HERE, '../../server/data');
const dir = process.env.WEBUI_DATA_DIR ? path.resolve(process.env.WEBUI_DATA_DIR) : '';
if (!dir || dir.toLowerCase() === live.toLowerCase()) { console.error('Set WEBUI_DATA_DIR to a snapshot, not the live data.'); process.exit(2); }
const { createSession } = await import(pathToFileURL(path.resolve(HERE, '../../server/session.js')).href);
console.log(createSession(process.argv[2], { userAgent: 'bench' }));
