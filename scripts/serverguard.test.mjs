// The AI must not stop or restart the WebUI server it runs inside.
import assert from 'node:assert/strict';
import { checkServerCommand } from '../server/serverGuard.js';

const opts = { pids: new Set([40008]), port: 5173 };
const blocked = [
  'taskkill /F /IM node.exe',
  'taskkill /pid 40008 /T /F',
  'Stop-Process -Name node -Force',
  'Get-Process node | Stop-Process',
  'Stop-Process -Id 40008',
  'Get-NetTCPConnection -LocalPort 5173 | % { Stop-Process -Id $_.OwningProcess }',
  'npx kill-port 5173',
  'pkill -f "server/index.js"',
  'killall node',
  'node server\\index.js',
  'cd C:\\Artificial_Intelligence\\ollama-webui && npm start',
  'pm2 restart ollama-webui',
  'Restart-Service ollama-webui',
  'shutdown /r /t 0',
];
const allowed = [
  'npm run build',
  'npm test',
  'node scripts/uireview.test.mjs',
  'git status',
  'Get-NetTCPConnection -LocalPort 5173',
  'taskkill /pid 1234 /F',
  'Stop-Process -Id 9999',
  'npm run dev -- --port 5199',
];
for (const c of blocked) assert.ok(checkServerCommand(c, opts), `should block: ${c}`);
for (const c of allowed) assert.equal(checkServerCommand(c, opts), null, `should allow: ${c}`);
console.log(`serverguard: ${blocked.length} blocked, ${allowed.length} allowed -- ok`);
