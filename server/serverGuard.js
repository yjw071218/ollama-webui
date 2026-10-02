/* The chat's AI may run commands, but never stop or restart the WebUI server
   it is running inside: that cut off its own answer, and every open tab and
   phone with it. Restarting is the owner's call, not the model's.

   checkServerCommand(command, { pids, port }) returns a reason string when the
   command would kill, stop or restart the server, or null when it may run. */
import { execFileSync } from 'node:child_process';

const KILL = /\b(taskkill|stop-process|spps|kill|pkill|killall|tskill|kill-port|fkill)\b|\bwmic\b[^\n]*\b(delete|terminate)\b|\.kill\(|process\.exit|\bterminate\(\)/i;
const NODE_BY_NAME = /(\/im\s+"?node(\.exe)?"?|-(process)?name\s+"?node"?|\b(pkill|killall|tskill)\s+(-\w+\s+)*node\b|name\s*=\s*'node(\.exe)?'|get-process\s+(-name\s+)?node\b)/i;
const SERVER_FILE = /(server[\\/]+index\.js|ollama-webui)/i;
const RESTART = [
  /\bnode(\.exe)?\b[^\n|;&]*server[\\/]+index\.js/i,   // a second server start, or a restart script
  /\bnpm\s+(run\s+)?(start|serve|restart|stop)\b/i,
  /\bpm2\s+(restart|reload|stop|delete|kill)\b/i,
  /\b(restart|stop)-service\b/i,
  /\bnssm\s+(restart|stop)\b/i,
  /\bsc(\.exe)?\s+stop\b/i,
  /\bshutdown(\.exe)?\s+[/-][rsp]\b/i,
  /\b(restart|stop)-computer\b/i,
];

export function serverPids(port) {
  const pids = new Set([process.ppid].filter(Boolean));
  if (process.env.WEBUI_SERVER_PID) pids.add(Number(process.env.WEBUI_SERVER_PID));
  try {
    const out = process.platform === 'win32'
      ? execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      : execFileSync('sh', ['-c', `lsof -tiTCP:${port} -sTCP:LISTEN || true`], { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split(/\r?\n/)) {
      if (process.platform !== 'win32') { if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim())); continue; }
      const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
      if (m) pids.add(Number(m[1]));
    }
  } catch { /* the ppid is still known */ }
  return pids;
}

export function checkServerCommand(command, { pids, port = Number(process.env.PORT) || 5173 } = {}) {
  const cmd = String(command || '');
  for (const re of RESTART) if (re.test(cmd)) return 'restarting or stopping the WebUI server';
  if (!KILL.test(cmd)) return null;
  if (NODE_BY_NAME.test(cmd)) return 'killing every node process takes the WebUI server with it';
  if (SERVER_FILE.test(cmd)) return 'killing the WebUI server';
  if (new RegExp(`(^|\\D)${port}(\\D|$)`).test(cmd)) return `killing whatever listens on the WebUI port ${port}`;
  const ids = pids || serverPids(port);
  for (const n of cmd.match(/\d+/g) || []) if (ids.has(Number(n))) return `killing the WebUI server (pid ${n})`;
  return null;
}

export const blockedMessage = reason =>
  `Blocked: this command was not run, because it would mean ${reason}. The AI may not stop or restart the ollama-webui server; ask the user to restart it themselves.`;
