import os from 'node:os';
import { execFile } from 'node:child_process';

export const memoryPressure = (critical = false, { free = os.freemem(), total = os.totalmem() } = {}) =>
  free < Math.max((critical ? 1 : 4) * 1024 ** 3, total * (critical ? 0.03 : 0.10));

export const assertMemoryAvailable = () => {
  if (memoryPressure()) throw Object.assign(new Error('시스템 여유 RAM이 부족하여 새 작업을 시작하지 않았습니다. 실행 중인 작업이 끝난 뒤 다시 시도하세요.'), { statusCode: 503 });
};

/* ------------------------------------------------------------ commit charge

   Free RAM is the wrong number for a model load on Windows. A safetensors file
   is mapped copy-on-write, and Windows charges the *whole* file against the
   commit limit -- physical RAM plus the page file -- the moment it is mapped,
   whether or not a page of it is ever touched. Windows does not overcommit, so
   when that charge cannot be met the load does not wait or swap: ComfyUI dies
   with an access violation in torch_cpu.dll, taking every queued job with it.

   Measured on the machine this was reported from: 45GB of RAM "free", and 37GB
   of commit left, with ComfyUI not even running -- Docker, WSL and the desktop
   apps hold the rest. MiniMax H3 maps about 40GB of weights. So the check is on
   commit, and it is made before the job is queued. */

let commitCache = null;

/** Bytes of commit left (Windows), or null where it cannot be read or does not apply. */
export const commitAvailable = ({ platform = process.platform, run = execFile, now = Date.now() } = {}) => {
  if (platform !== 'win32') return Promise.resolve(null);
  if (commitCache && now - commitCache.at < 2000) return commitCache.value;
  const value = new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory'],
    { timeout: 8000, windowsHide: true }, (error, stdout) => {
      const kb = Number(String(stdout || '').trim());
      resolve(!error && Number.isFinite(kb) && kb > 0 ? kb * 1024 : null);
    });
  });
  commitCache = { at: now, value };
  return value;
};

export const forgetCommit = () => { commitCache = null; statsCache = null; };

let statsCache = null;

/**
 * The commit limit and what is left of it, for the system monitor. Null where it
 * cannot be read. Ten seconds between readings: the monitor polls every two, and
 * each reading is a PowerShell starting up.
 */
export const commitStats = ({ platform = process.platform, run = execFile, now = Date.now() } = {}) => {
  if (platform !== 'win32') return Promise.resolve(null);
  if (statsCache && now - statsCache.at < 10000) return statsCache.value;
  const value = new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)"'],
    { timeout: 8000, windowsHide: true }, (error, stdout) => {
      const [total, free] = String(stdout || '').trim().split(/\s+/).map(Number);
      resolve(!error && total > 0 && free >= 0 ? { total: total * 1024, free: free * 1024, used: (total - free) * 1024 } : null);
    });
  });
  statsCache = { at: now, value };
  return value;
};

/** Is this address this machine? Commit here says nothing about a ComfyUI elsewhere. */
export const isLocalAddress = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
  } catch { return false; }
};

/**
 * The refusal, when a load needs more commit than is left. `null` when it fits,
 * or when nothing could be measured -- a check that cannot read the number does
 * not get to stop the job.
 */
export const commitShortfall = (available, neededBytes) => {
  if (!Number.isFinite(available) || !Number.isFinite(neededBytes) || neededBytes <= 0) return null;
  if (available >= neededBytes) return null;
  const gb = (n) => Math.round(n / 1024 ** 3);
  return {
    available,
    needed: neededBytes,
    message: `이 모델을 불러오려면 가상 메모리(RAM+페이지 파일)가 약 ${gb(neededBytes)}GB 필요한데 `
      + `${gb(available)}GB만 남아 있어 작업을 시작하지 않았습니다. 그대로 실행하면 ComfyUI가 `
      + '메모리 접근 오류로 종료됩니다. 다른 프로그램(Docker, WSL, 브라우저 탭 등)을 닫거나 '
      + 'Windows 페이지 파일 크기를 늘린 뒤 다시 시도하세요.',
  };
};
