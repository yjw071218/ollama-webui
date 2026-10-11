import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { supportsOfficeConversion, convertWithLibreOffice } from './libreOffice.js';

const execute = promisify(execFile);
let running = false;
export async function convertOffice({ data, from, to, text } = {}) {
  const hangul = ['hwp','hwpx','text'].includes(from) && ['hwp','hwpx'].includes(to);
  const office = supportsOfficeConversion(from,to);
  if (!hangul && !office) throw new Error('Unsupported document conversion.');
  if (hangul && process.platform !== 'win32') throw new Error('HWP 변환에는 한/글이 설치된 Windows 서버가 필요합니다.');
  if (running) throw new Error('다른 문서를 변환 중입니다. 잠시 후 다시 시도해 주세요.');
  const bytes = from === 'text' ? Buffer.from(String(text || ''), 'utf8') : Buffer.from(String(data || ''), 'base64');
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('변환할 문서는 50 MB 이하여야 합니다.');
  running = true;
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-office-'));
    const source = path.join(directory, `source.${from === 'text' ? 'txt' : from}`);
    const target = path.join(directory, `result.${to}`);
    await fs.writeFile(source, bytes);
    if (office) {
      const output=await convertWithLibreOffice(directory,source,from,to);
      return {data:output.toString('base64'),format:to};
    }
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./office-convert.ps1', import.meta.url)), '-SourceFile', source, '-TargetFile', target, '-Format', to.toUpperCase(),
      ...(from === 'text' ? ['-TextInput'] : [])], { windowsHide: true, timeout: 90000, maxBuffer: 8192 });
    const output = await fs.readFile(target);
    return { data: output.toString('base64'), format: to };
  } catch (error) {
    const application = office ? 'LibreOffice' : '한/글';
    throw new Error(error.killed ? `${application} 변환 시간이 초과되었습니다. 서버의 프로그램 응답 상태와 확인 창을 확인해 주세요.` : `${application} 변환에 실패했습니다. 설치·자동화 권한을 확인해 주세요. ${String(error.stderr || error.message).slice(0, 400)}`);
  } finally {
    running = false;
    if (directory && path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('webui-office-')) {
      // Office may retain a file handle after its automation host times out.
      // Cleanup must not replace the useful conversion error with EBUSY.
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(error => {
        console.warn(`Office temporary files could not be removed (${error.code}): ${directory}`);
      });
    }
  }
}
