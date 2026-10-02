import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integration = path.join(root, 'integrations/risuai');
const source = path.join(integration, 'upstream');
const version = JSON.parse(await fs.readFile(path.join(integration, 'version.json'), 'utf8'));
const run = (command, args, cwd = source) => new Promise((resolve, reject) => {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const child = process.platform === 'win32' && command === 'pnpm'
    ? spawn('pwsh', ['-NoProfile', '-Command', `& pnpm ${args.map(quote).join(' ')}; exit $LASTEXITCODE`], { cwd, stdio: 'inherit', windowsHide: true })
    : spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
if (!await fs.stat(path.join(source, '.git')).catch(() => null)) {
  await fs.mkdir(source, { recursive: true });
  await run('git', ['init']);
  await run('git', ['remote', 'add', 'origin', version.repository]);
  await run('git', ['fetch', '--depth', '1', 'origin', version.commit]);
  await run('git', ['checkout', '--detach', version.commit]);
}
// Refuse to silently build a different revision; no reset of someone's checkout.
const { execFileSync } = await import('node:child_process');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== version.commit) {
  throw new Error('RisuAI revision differs from integrations/risuai/version.json');
}
if (!process.argv.includes('--build-only')) await run('pnpm', ['install', '--frozen-lockfile']);
await fs.copyFile(path.join(integration, 'vite.webui.config.mjs'), path.join(source, 'vite.webui.config.mjs'));
await fs.copyFile(path.join(integration, 'webui-entry.js'), path.join(source, 'src/webui-entry.js'));
await fs.copyFile(path.join(integration, 'webui-bridge.ts'), path.join(source, 'src/webui-bridge.ts'));
await fs.copyFile(path.join(integration, 'asset-mime.js'), path.join(source, 'src/webui-asset-mime.js'));
await fs.copyFile(path.join(integration, 'asset-fallback.js'), path.join(source, 'src/webui-asset-fallback.js'));
await fs.copyFile(path.join(integration, 'local-model.js'), path.join(source, 'src/webui-local-model.js'));
await fs.copyFile(path.join(integration, 'webui-sync.ts'), path.join(source, 'src/webui-sync.ts'));
await fs.copyFile(path.join(integration, 'sync-merge.js'), path.join(source, 'src/webui-sync-merge.js'));
await fs.copyFile(path.join(integration, 'sync-settings.js'), path.join(source, 'src/webui-sync-settings.js'));
await fs.copyFile(path.join(integration, 'sync-assets.js'), path.join(source, 'src/webui-sync-assets.js'));
await fs.copyFile(path.join(integration, 'sync-delta.js'), path.join(source, 'src/webui-sync-delta.js'));
await fs.writeFile(path.join(source, 'src/webui-sync-asset-index.js'), (await fs.readFile(path.join(integration, 'sync-asset-index.js'), 'utf8')).replace("'./sync-assets.js'", "'./webui-sync-assets.js'"));
await fs.copyFile(path.join(root, 'src/byteFallback.js'), path.join(source, 'src/webui-byte-fallback.js'));
await fs.copyFile(path.join(integration, 'performance.js'), path.join(source, 'src/webui-performance.js'));
await fs.copyFile(path.join(integration, 'preset-crypto.js'), path.join(source, 'src/webui-preset-crypto.js'));
for (const file of ['webui-theme.js', 'webui-theme.css', 'WebUIHome.svelte', 'WebUIModelList.svelte']) {
  await fs.copyFile(path.join(integration, file), path.join(source, 'src', file));
}
await run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.webui.config.mjs']);
await fs.copyFile(path.join(source, 'LICENSE'), path.join(source, 'dist/LICENSE.txt'));
await fs.writeFile(path.join(source, 'dist/version.json'), JSON.stringify(version));
console.log('RisuAI ready at /risuai/. Start or restart the WebUI server.');
