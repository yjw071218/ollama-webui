import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Opt-in private Ollama instance: no changes to the desktop app's process or
// user-wide environment. Both normal chat and Risu use the same OLLAMA_URL.
export async function ensureManagedOllama(env = {}, { fetchImpl = fetch, spawnImpl = spawn } = {}) {
  if (String(env.OLLAMA_MANAGED).toLowerCase() !== 'true') return;
  if (!env.OLLAMA_URL) throw new Error('Managed Ollama requires an explicit OLLAMA_URL.');
  const url = new URL(env.OLLAMA_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '11434'
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Managed Ollama requires a dedicated http://127.0.0.1:<port> URL (not 11434).');
  }
  const ready = async () => {
    try {
      const res = await fetchImpl(new URL('/api/version', url), { signal: AbortSignal.timeout(1500) });
      return res.ok && typeof (await res.json()).version === 'string';
    } catch { return false; }
  };
  if (await ready()) return;
  const fitTarget = String(env.OLLAMA_MANAGED_FIT_TARGET || '2048,768');
  if (!/^\d+(,\d+)*$/.test(fitTarget) || fitTarget.split(',').some(n => Number(n) < 512)) {
    throw new Error('Invalid Ollama VRAM headroom.');
  }
  const binary = env.OLLAMA_BINARY || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : 'ollama');
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(root, 'logs', 'ollama-managed.log'), 'a');
  let child;
  try {
    child = spawnImpl(binary, ['serve'], {
      cwd: root, windowsHide: true, detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, OLLAMA_HOST: url.host,
        OLLAMA_SCHED_SPREAD: 'true', OLLAMA_FLASH_ATTENTION: 'true',
        OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_MAX_LOADED_MODELS: '1', LLAMA_ARG_FIT_TARGET: fitTarget },
    });
  } finally { fs.closeSync(log); }
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure = new Error(`Managed Ollama exited (${code}). Check logs/ollama-managed.log.`); });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await ready()) return;
    if (failure) throw failure;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Managed Ollama startup timed out. Check logs/ollama-managed.log.');
}
