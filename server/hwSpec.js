// What this PC has, and whether ComfyUI may be set up on it.
//
// Shared by the first run (install-engines.mjs) and the server (/api/engines),
// so the installer and the guide say the same thing.
//
// The floor, as asked for: 6 GB of VRAM, 16 GB of RAM, and 32 GB of RAM plus
// page file. Below it a picture model either does not load or the PC pages
// itself to a halt, so ComfyUI is not installed. Between the floor and a
// comfortable machine (12 GB VRAM, 32 GB RAM) it is installed with a warning
// that pictures and especially video may be slow.

import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const MIN = { vramGb: 6, ramGb: 16, commitGb: 32 };
export const COMFORT = { vramGb: 12, ramGb: 32 };

const GB = 1024 ** 3;
const quiet = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
};

/** Largest NVIDIA card's memory in GB, or 0 when there is none / no driver. */
export const vramGb = () => {
  const out = quiet('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
  const mib = out.split(/\r?\n/).map(Number).filter(Number.isFinite);
  return mib.length ? Math.round((Math.max(...mib) / 1024) * 10) / 10 : 0;
};

/** RAM plus page file in GB. Windows reports it directly; elsewhere RAM + swap. */
export const commitGb = (ram = os.totalmem() / GB) => {
  if (process.platform === 'win32') {
    const kb = Number(quiet('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize']).trim());
    if (Number.isFinite(kb) && kb > 0) return Math.round((kb / 1024 / 1024) * 10) / 10;
  }
  const swap = quiet('sh', ['-c', "free -b 2>/dev/null | awk '/Swap/{print $2}' || sysctl -n vm.swapusage"]);
  const bytes = Number(String(swap).trim());
  return Math.round((ram + (Number.isFinite(bytes) ? bytes / GB : 0)) * 10) / 10;
};

/** Pure: the verdict for given numbers, so it can be tested without hardware. */
export const judge = ({ vram, ram, commit }) => {
  const missing = [];
  if (vram < MIN.vramGb) missing.push(`VRAM ${vram} GB < ${MIN.vramGb} GB`);
  if (ram < MIN.ramGb) missing.push(`RAM ${ram} GB < ${MIN.ramGb} GB`);
  if (commit < MIN.commitGb) missing.push(`RAM+가상 메모리 ${commit} GB < ${MIN.commitGb} GB`);
  const ok = missing.length === 0;
  const slow = ok && (vram < COMFORT.vramGb || ram < COMFORT.ramGb);
  return { vram, ram, commit, ok, slow, missing };
};

let cached = null;
/** This PC's verdict, measured once per process. */
export const comfySpec = () => {
  if (!cached) {
    const ram = Math.round((os.totalmem() / GB) * 10) / 10;
    cached = judge({ vram: vramGb(), ram, commit: commitGb(ram) });
  }
  return cached;
};
