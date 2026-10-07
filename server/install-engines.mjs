// Installs the engines the project runs, into engines/ of this install, so a
// new PC speaks, listens, joins video and draws like the original:
//
//   ffmpeg      video joins, audio decoding          ~100 MB  (always)
//   gpt-sovits  TTS, and the Python the STT runs in  ~7 GB    (asked)
//   comfyui     pictures and video                   ~6 GB    (asked, spec-gated)
//
// They are not inside the installer itself: together they are well over the
// 2 GB a GitHub release file may be, so they are fetched on the first run.
// FFmpeg is the exception on Windows -- the release workflow already puts it
// in runtime/ffmpeg, and then nothing is downloaded for it here.
//
// ComfyUI is only installed on a PC with at least 6 GB VRAM, 16 GB RAM and
// 32 GB RAM + page file (server/hwSpec.js). Near that floor it is installed
// with a warning that it may be slow, and --lowvram on a card under 8 GB.
//
//   node server/install-engines.mjs            asks for each
//   node server/install-engines.mjs --yes      installs all that fit
//
// Every URL can be replaced from .env (*_PACKAGE_URL), for a mirror or a
// newer package.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { comfySpec, MIN } from './hwSpec.js';
import { ENGINES_DIR, ffmpegDir, resolveEngine } from './engines.js';

const WIN = process.platform === 'win32';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES = {
  ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  sevenZip: 'https://www.7-zip.org/a/7zr.exe',
  gptSovits: 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v2pro-20250604.7z',
  // RTX 50xx needs the CUDA 12.8 build.
  gptSovits50: 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v2pro-20250604-nvidia50.7z',
  comfyui: 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z',
};

const gpuName = () => {
  try { return spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true }).stdout || ''; } catch { return ''; }
};

const freeGb = (dir) => {
  try { const s = fs.statfsSync(dir); return (s.bavail * s.bsize) / 1024 ** 3; } catch { return Infinity; }
};

/** Streams `url` to `file`, printing a percentage. */
const download = async (url, file, log) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url} -> HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0; let shown = -1;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      got += chunk.length;
      const pc = total ? Math.floor((got / total) * 100) : -1;
      if (pc >= 0 && pc !== shown && pc % 5 === 0) { shown = pc; log(`    ${pc}%  (${(got / 1024 ** 2).toFixed(0)} / ${(total / 1024 ** 2).toFixed(0)} MB)`); }
      ctl.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(`${file}.part`));
  fs.renameSync(`${file}.part`, file);
};

/** Extracts an archive into a fresh folder and moves its single top folder to `dest`. */
const unpack = async (archive, dest, log) => {
  const tmp = `${dest}.unpack`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  let ok;
  if (/\.zip$/i.test(archive)) {
    ok = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${tmp}' -Force`], { stdio: 'inherit' }).status === 0;
  } else {
    const seven = path.join(ENGINES_DIR, '.tools', '7zr.exe');
    if (!fs.existsSync(seven)) { fs.mkdirSync(path.dirname(seven), { recursive: true }); await download(PACKAGES.sevenZip, seven, () => {}); }
    log('    압축 푸는 중... (몇 분 걸려요)');
    ok = spawnSync(seven, ['x', archive, `-o${tmp}`, '-y', '-bso0', '-bsp1'], { stdio: 'inherit' }).status === 0;
  }
  if (!ok) throw new Error(`압축 풀기 실패: ${archive}`);
  const top = fs.readdirSync(tmp);
  const inner = top.length === 1 && fs.statSync(path.join(tmp, top[0])).isDirectory() ? path.join(tmp, top[0]) : tmp;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(inner, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
};

const fetchAndUnpack = async (url, dest, log) => {
  fs.mkdirSync(ENGINES_DIR, { recursive: true });
  const archive = path.join(ENGINES_DIR, '.downloads', path.basename(new URL(url).pathname));
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  if (!fs.existsSync(archive)) { log(`    받는 중: ${url}`); await download(url, archive, log); }
  await unpack(archive, dest, log);
  fs.rmSync(archive, { force: true }); // tens of GB of 7z is not worth keeping
};

/* ------------------------------------------------------------ voice model

   The default voice, "ai-voice" (GPT-SoVITS v2Pro: GPT ckpt + SoVITS pth),
   ships inside the Windows installer in runtime/voice-model (release.yml
   fetches it from the voice-model-v1 release). Here it is copied into the
   GPT-SoVITS install and made the `custom` model in tts_infer.yaml, with
   paths relative to the engine folder so the file is the same on every PC.
   Device and precision match the original PC (CPU, full precision), which
   leaves the GPU to the chat model.

   The reference audio is deliberately not part of it: the voice follows the
   reference mostly, so whoever installs the app picks their own in
   Settings -> Voice. */
export const VOICE_MODEL = { ckpt: 'ai-voice.ckpt', pth: 'ai-voice.pth' };
const VOICE_MODEL_URL = 'https://github.com/yjw071218/ollama-webui/releases/download/voice-model-v1/';

const voiceSource = (env) => [
  env.VOICE_MODEL_DIR,
  path.resolve(ROOT, '..', 'runtime', 'voice-model'), // installed: {app}\runtime\voice-model
  path.join(ROOT, 'voice-model'),
].filter(Boolean).find(d => fs.existsSync(path.join(d, VOICE_MODEL.ckpt)) && fs.existsSync(path.join(d, VOICE_MODEL.pth))) || null;

/** tts_infer.yaml with its `custom:` block pointing at the ai-voice weights. */
export const withVoiceModel = (yaml) => {
  const block = [
    'custom:',
    '  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
    '  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base',
    '  device: cpu',
    '  is_half: false',
    `  t2s_weights_path: GPT_weights_v2Pro/${VOICE_MODEL.ckpt}`,
    '  version: v2Pro',
    `  vits_weights_path: SoVITS_weights_v2Pro/${VOICE_MODEL.pth}`,
  ].join('\n');
  const text = String(yaml || '').replace(/\r\n/g, '\n');
  // The custom block runs to the next top-level key.
  return /^custom:\n(?:[ \t].*\n?)*/m.test(text)
    ? text.replace(/^custom:\n(?:[ \t].*\n?)*/m, `${block}\n`)
    : `${block}\n${text}`;
};

export const installVoiceModel = async (env = {}, log = console.log) => {
  const engine = path.join(ENGINES_DIR, 'gpt-sovits');
  const gptDir = path.join(engine, 'GPT_weights_v2Pro');
  const vitsDir = path.join(engine, 'SoVITS_weights_v2Pro');
  fs.mkdirSync(gptDir, { recursive: true });
  fs.mkdirSync(vitsDir, { recursive: true });
  const ckpt = path.join(gptDir, VOICE_MODEL.ckpt);
  const pth = path.join(vitsDir, VOICE_MODEL.pth);
  if (!fs.existsSync(ckpt) || !fs.existsSync(pth)) {
    const src = voiceSource(env);
    if (src) {
      fs.copyFileSync(path.join(src, VOICE_MODEL.ckpt), ckpt);
      fs.copyFileSync(path.join(src, VOICE_MODEL.pth), pth);
    } else {
      // Not in this package (Linux/macOS, or run from a source checkout): fetch it.
      log('  음성 모델(ai-voice, 약 290MB) 받는 중...');
      if (!fs.existsSync(ckpt)) await download(VOICE_MODEL_URL + VOICE_MODEL.ckpt, ckpt, log);
      if (!fs.existsSync(pth)) await download(VOICE_MODEL_URL + VOICE_MODEL.pth, pth, log);
    }
  }
  const yamlFile = path.join(engine, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
  const before = fs.existsSync(yamlFile) ? fs.readFileSync(yamlFile, 'utf8') : '';
  fs.mkdirSync(path.dirname(yamlFile), { recursive: true });
  fs.writeFileSync(yamlFile, withVoiceModel(before));
  return '음성 모델(ai-voice): 준비됨 - 참조 음성은 설정 → 음성에서 지정하세요';
};

/**
 * Runs the whole thing. `yes(question)` decides each optional step;
 * `env` is the .env as an object (for *_PACKAGE_URL and existing paths);
 * returns { summary: string[], envChanges: { KEY: value } }.
 */
export const installEngines = async ({ yes = async () => true, env = {}, log = console.log } = {}) => {
  const summary = [];
  const envChanges = {};
  if (!WIN) {
    log('  Windows가 아니라서 엔진 자동 설치는 건너뛰어요. ffmpeg는 패키지 관리자로(apt/brew install ffmpeg),');
    log('  ComfyUI·GPT-SoVITS는 각 저장소 안내대로 설치한 뒤 .env의 COMFYUI_PATH·GPT_SOVITS_PATH를 지정하세요.');
    return { summary: ['엔진: Windows 외에는 수동 설치'], envChanges };
  }

  /* ------------------------------------------------------------- ffmpeg */
  if (ffmpegDir(env)) summary.push('FFmpeg: 준비됨');
  else {
    try {
      log('  FFmpeg 설치 중...');
      await fetchAndUnpack(env.FFMPEG_PACKAGE_URL || PACKAGES.ffmpeg, path.join(ENGINES_DIR, 'ffmpeg'), log);
      summary.push(ffmpegDir(env) ? 'FFmpeg: 설치함' : 'FFmpeg: 설치 실패');
    } catch (e) { summary.push(`FFmpeg: 실패 - ${e.message}`); }
  }

  const disk = freeGb(ROOT);
  const gpu = gpuName();
  const spec = comfySpec();

  /* -------------------------------------------------------- voice (TTS+STT) */
  const sovits = resolveEngine('gpt-sovits', env);
  if (sovits?.installed) summary.push('음성(TTS·STT): 준비됨');
  else if (!spec.vram) summary.push('음성(TTS·STT): NVIDIA GPU가 없어 건너뜀');
  else if (await yes('  음성 엔진(GPT-SoVITS + Whisper 음성 인식, 약 7GB)을 설치할까요?')) {
    if (disk < 20) summary.push(`음성: 디스크 여유 공간 부족 (${disk.toFixed(0)} GB, 20 GB 필요)`);
    else {
      try {
        const url = env.GPT_SOVITS_PACKAGE_URL || (/RTX\s*50\d\d/i.test(gpu) ? PACKAGES.gptSovits50 : PACKAGES.gptSovits);
        await fetchAndUnpack(url, path.join(ENGINES_DIR, 'gpt-sovits'), log);
        summary.push(resolveEngine('gpt-sovits', env)?.installed ? '음성(TTS·STT): 설치함' : '음성: 설치됐지만 구성 확인 필요');
      } catch (e) { summary.push(`음성: 실패 - ${e.message}`); }
    }
  } else summary.push('음성: 건너뜀 (나중에 node server/install-engines.mjs)');

  /* The bundled voice, once GPT-SoVITS is there (installed now or before). */
  if (resolveEngine('gpt-sovits', env)?.installed) {
    try { summary.push(await installVoiceModel(env, log)); } catch (e) { summary.push(`음성 모델: 실패 - ${e.message}`); }
  }

  /* ------------------------------------------------------------- ComfyUI */
  log('');
  log(`  이 PC: VRAM ${spec.vram} GB · RAM ${spec.ram} GB · RAM+가상 메모리 ${spec.commit} GB`);
  log(`  ComfyUI 최소 사양: VRAM ${MIN.vramGb} GB · RAM ${MIN.ramGb} GB · RAM+가상 메모리 ${MIN.commitGb} GB`);
  const comfy = resolveEngine('comfyui', env);
  if (comfy?.installed) summary.push('ComfyUI: 준비됨');
  else if (!spec.ok) {
    log(`  최소 사양에 못 미쳐 ComfyUI는 설치하지 않아요: ${spec.missing.join(', ')}`);
    if (spec.vram >= MIN.vramGb && spec.ram >= MIN.ramGb && spec.commit < MIN.commitGb) {
      log(`  가상 메모리(페이지 파일)를 ${Math.ceil(MIN.commitGb - spec.ram)} GB 이상으로 늘리면 설치할 수 있어요:`);
      log('  설정 → 시스템 → 정보 → 고급 시스템 설정 → 성능 설정 → 고급 → 가상 메모리 변경');
    }
    summary.push(`ComfyUI: 사양 부족으로 건너뜀 (${spec.missing.join(', ')})`);
  } else {
    if (spec.slow) {
      log('  ⚠ 최소 사양 근처예요. 그림은 느릴 수 있고, 영상 생성은 매우 느리거나 메모리 부족으로 실패할 수 있어요.');
    }
    if (await yes('  ComfyUI(그림·영상 생성, 약 6GB)를 설치할까요?')) {
      if (disk < 15) summary.push(`ComfyUI: 디스크 여유 공간 부족 (${disk.toFixed(0)} GB, 15 GB 필요)`);
      else {
        try {
          await fetchAndUnpack(env.COMFYUI_PACKAGE_URL || PACKAGES.comfyui, path.join(ENGINES_DIR, 'comfyui'), log);
          if (spec.vram < 8 && !env.COMFYUI_ARGS) envChanges.COMFYUI_ARGS = '--lowvram';
          envChanges.COMFYUI_URL = 'http://127.0.0.1:8188';
          summary.push(`ComfyUI: 설치함${spec.slow ? ' (최소 사양 근처 - 느릴 수 있음)' : ''}`);
        } catch (e) { summary.push(`ComfyUI: 실패 - ${e.message}`); }
      }
    } else summary.push('ComfyUI: 건너뜀');
  }
  return { summary, envChanges };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { readEnvValue, writeEnvValue } = await import('./envFile.js');
  const envFile = path.join(ROOT, '.env');
  let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const env = Object.fromEntries([...text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => [m[1], readEnvValue(text, m[1])]));
  const auto = process.argv.includes('--yes');
  const readline = await import('node:readline/promises');
  const rl = auto ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const yes = async (q) => auto || /^(y|yes|ㅛ|예|네|응)$/i.test((await rl.question(`${q} [y/N] `)).trim());
  const { summary, envChanges } = await installEngines({ yes, env });
  for (const [k, v] of Object.entries(envChanges)) text = writeEnvValue(text, k, v);
  if (Object.keys(envChanges).length) fs.writeFileSync(envFile, text);
  rl?.close();
  for (const s of summary) console.log(`  - ${s}`);
}
