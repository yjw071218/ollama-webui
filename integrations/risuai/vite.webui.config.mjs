import original from './vite.config.ts';
import fs from 'node:fs';
import path from 'node:path';

// Apply small hosting adapters at build time; the pinned importer, prompt
// engine, renderer and scripts remain the original RisuAI implementation.
const publicNames = fs.readdirSync('public').filter(name => !['sw.js', 'manifest.json'].includes(name));
const assetPattern = new RegExp(`(["'\x60])/(?:${publicNames.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[/"'\x60?#])`, 'g');
const replaceOnce = (code, from, to, file) => {
  if (!code.includes(from)) throw new Error(`RisuAI adapter anchor missing: ${file}: ${from}`);
  return code.replace(from, to);
};
export default context => {
  const config = original(context);
  return {
    ...config,
    base: '/risuai/',
    // This integration is a private self-hosted installation. Keep RisuAI's
    // service terms dialog intact for the user to review on first use.
    define: { 'import.meta.env.VITE_RISU_LEGAL_CONFIGURED': JSON.stringify('TRUE') },
    plugins: [{
      name: 'webui-risu-host', enforce: 'pre',
      transformIndexHtml: { order: 'pre', handler: html => html.replace('src="/src/main.ts"', 'src="/src/webui-entry.js"').replace(/<link rel="manifest"[^>]+>/, '') },
      transform(code, id) {
        const file = id.replaceAll('\\', '/').split('?')[0];
        if (!file.includes('/src/') || file.includes('/node_modules/')) return;
        code = code.replaceAll('\r\n', '\n');
        if (file.endsWith('/ChatScreens/Chat.svelte')) {
          // Strong streaming normally bypasses CBS entirely. Keep that fast
          // path for prose, but evaluate command-bearing replies normally.
          code = replaceOnce(code,
            "let renderRawStreaming = $derived(isOptimizedStreamingMessage && streamingOptimizationMode === 'strong')",
            "let renderRawStreaming = $derived(isOptimizedStreamingMessage && streamingOptimizationMode === 'strong' && !rawStreamingText.includes('{{'))", file);
        }
        if (file.endsWith('/UI/GUI/SideBarArrow.svelte')) return { code: '<!-- Character panel is controlled by the host toolbar. -->', map: null };
        if (file.endsWith('/ts/util.ts')) {
          code = "import { presetCrypt } from '../webui-preset-crypto.js';\n" + code;
          for (const operation of ['encrypt', 'decrypt']) {
            const signature = `export async function ${operation}Buffer(data:Uint8Array, keys:string){`;
            code = replaceOnce(code, signature, signature + `\n    if (!window.crypto?.subtle) return presetCrypt(data, keys, ${operation === 'decrypt'});`, file);
          }
        }
        if (file.endsWith('/lib/UI/ModelList.svelte')) {
          // Every model picker in RisuAI -- the chat sidebar, the easy panel,
          // settings -- lists the WebUI's models instead of RisuAI's providers.
          return { code: fs.readFileSync('src/WebUIModelList.svelte', 'utf8'), map: null };
        }
        if (file.endsWith('/lib/UI/MainMenu.svelte')) {
          return { code: fs.readFileSync('src/WebUIHome.svelte', 'utf8'), map: null };
        }
        if (file.endsWith('/BotSettings.svelte')) {
          const start = code.indexOf('{#if submenu === 0 || submenu === -1}');
          const end = code.indexOf('{#if submenu === 1 || submenu === -1}');
          if (start < 0 || end < start) throw new Error('RisuAI model settings anchor missing');
          code = code.slice(0, start) + `{#if submenu === 0 || submenu === -1}
            <div class="webui-local-settings">
              <h3>모델</h3>
              <ModelList noMargin />
              <p>WebUI의 모델 선택과 같은 설정입니다. 여기서 바꾸면 WebUI 상단 선택도 함께 바뀝니다. 프리셋의 프롬프트와 생성 설정은 그대로 적용됩니다.</p>
            </div>
            <Check bind:check={DBState.db.useStreaming} name="Response 스트리밍" />
            <Check bind:check={DBState.db.webuiFastGeneration} name="빠른 생성 모드 · 로컬 모델 전용" />
            <p>Ollama 로컬 모델에만 문맥 최대 32K · 응답 최대 2,048토큰 · 별도 추론 끄기를 적용합니다. AGY·Claude Code·Codex는 켜져 있어도 프리셋의 원래 설정을 사용합니다. 긴 대화의 이전 내용은 일부 제외될 수 있습니다.</p>
          {/if}
          ` + code.slice(end);
        }
        if (file.endsWith('/ts/storage/database.svelte.ts')) {
          code = replaceOnce(code, 'useStreaming:boolean', 'webuiFastGeneration?:boolean\n    webuiHideThinking?:boolean\n    useStreaming:boolean', file);
          code = "import { pinLocalModel } from '../../webui-local-model.js';\n" + code;
          code = replaceOnce(code, '    return db\n}', '    return pinLocalModel(db)\n}', file);
        }
        if (file.endsWith('/ts/bootstrap.ts')) {
          code = replaceOnce(code, 'if (navigator.serviceWorker) {', 'if (false) {', file);
          code = replaceOnce(code, 'const db = getDatabase();', "const db = getDatabase();\n            await import('../webui-bridge').then(m => m.initializeWebUI());", file);
          code = replaceOnce(code, 'if (a === false) {', "if (a === true) window.parent.postMessage({ channel: 'webui-risu', ready: true }, location.origin);\n                if (a === false) {", file);
        }
        if (file.endsWith('/ts/storage/autoStorage.ts')) {
          code = replaceOnce(code, "else if(window.navigator?.storage?.getDirectory &&", "else if(false && window.navigator?.storage?.getDirectory &&", file);
        }
        if (file.endsWith('/ts/globalApi.svelte.ts')) {
          code = "import { assetMime } from '../webui-asset-mime.js';\n" + code;
          code = replaceOnce(code, 'export async function getFileSrc(loc: string) {', `const webuiAssetUrls = new Map<string, Promise<string>>();
export async function getFileSrc(loc: string) {
    if (!isTauri && !forageStorage.isAccount) {
        if (!loc) return '';
        if (/^(https?:|data:|blob:)/i.test(loc)) return loc;
        if (!webuiAssetUrls.has(loc)) {
            webuiAssetUrls.set(loc, (async () => {
                const bytes = await forageStorage.getItem(loc);
                if (!bytes) throw new Error('Missing character asset: ' + loc);
                return URL.createObjectURL(new Blob([bytes], { type: assetMime(bytes, loc) }));
            })().catch(error => { webuiAssetUrls.delete(loc); throw error; }));
        }
        return webuiAssetUrls.get(loc);
    }`, file);
        }
        if (file.endsWith('/ts/process/index.svelte.ts')) {
          code = "import { startBudget, liftBudget, responseBudget } from '../../webui-performance.js';\n" + code;
          code = replaceOnce(code, 'let maxContextTokens = DBState.db.maxContext', 'let maxContextTokens = startBudget(DBState.db)', file);
          // Before history is dropped to fit: if what cannot be dropped (card,
          // preset, lorebook) does not fit either, lift a ceiling this app set
          // rather than refuse. See liftBudget in performance.js.
          code = replaceOnce(code, `        while(currentTokens > maxContextTokens){
            if(chats.length <= 1){`, `        if(currentTokens > maxContextTokens){
            let historyTokens = 0
            for(const chat of chats.slice(0, -1)){
                historyTokens += await tokenizer.tokenizeChat(chat)
            }
            maxContextTokens = liftBudget(DBState.db, currentTokens - historyTokens, maxContextTokens)
        }
        while(currentTokens > maxContextTokens){
            if(chats.length <= 1){`, file);
          code = code.replaceAll('DBState.db.maxResponse', 'responseBudget(DBState.db)');
        }
        if (file.endsWith('/ts/process/request/request.ts')) {
          code = "import { decodeByteFallback } from '../../../webui-byte-fallback.js';\n" + code;
          code = replaceOnce(code, "formatThinkingOutput(response.message?.thinking ?? '', response.message?.content ?? '')", "formatThinkingOutput(decodeByteFallback(response.message?.thinking ?? ''), decodeByteFallback(response.message?.content ?? ''))", file);
          code = replaceOnce(code, '"0": formatThinkingOutput(thinking, content)', '"0": formatThinkingOutput(decodeByteFallback(thinking), decodeByteFallback(content))', file);
          code = "import { contextBudget, fastGeneration, isLocalOllama } from '../../../webui-performance.js';\n" + code;
          code = "import { ensureLocalModel } from '../../../webui-local-model.js';\n" + code;
          const entry = 'export async function requestChatData(arg:requestDataArgument, model:ModelModeExtended, abortSignal:AbortSignal=null):Promise<requestDataResponse> {';
          code = replaceOnce(code, entry, entry + '\n    try { await ensureLocalModel(getDatabase()); } catch (error) { return { type: "fail", result: String(error.message || error), noRetry: true }; }', file);
          code = replaceOnce(code, 'const fallBackModels:string[] = safeStructuredClone(db?.fallbackModels?.[model] ?? [])', 'const fallBackModels:string[] = []', file);
          code = replaceOnce(code, "targ.aiModel = arg.staticModel ? arg.staticModel : (model === 'model' ? db.aiModel : db.subModel)", "targ.aiModel = 'ollama-hosted'", file);
          code = replaceOnce(code, 'if(db.seperateModelsForAxModels && !arg.staticModel){', 'if(false && db.seperateModelsForAxModels && !arg.staticModel){', file);
          code = replaceOnce(code, 'think: ollamaThinkMode', `think: fastGeneration(db) ? false : ollamaThinkMode,
        keep_alive: isLocalOllama(db) ? '15m' : undefined,
        options: isCloud ? undefined : applyParameters(
            { num_ctx: contextBudget(db), num_predict: arg.maxTokens },
            ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'presence_penalty', 'frequency_penalty'],
            { repetition_penalty: 'repeat_penalty' }, arg.mode,
            { modelId: arg.aiModel, ignoreTopKIfZero: true }
        )`, file);
          code = replaceOnce(code, 'fetch: isCloud ? ollamaCloudFetch : undefined', 'fetch: isCloud ? ollamaCloudFetch : (url, options) => fetch(url, { ...options, signal: arg.abortSignal })', file);
        }
        if (file.endsWith('/ts/parser/parser.svelte.ts')) {
          // An expression the card does not ship falls back to the default
          // picture of the same character and outfit (asset-fallback.js).
          code = "import { defaultVariant } from '../../webui-asset-fallback.js';\n" + code;
          code = replaceOnce(code, '        let match = assetPaths?.[name]\n',
            '        let match = assetPaths?.[name] ?? defaultVariant(assetPaths, name)\n', file);
          // Display scripts can append/prepend conditional CBS after the
          // initial parse. Evaluate these before assets and Markdown, with
          // the same message index/character context on desktop and mobile.
          code = replaceOnce(code,
            "data = (await processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)).data",
            "data = (await processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)).data\n        if (/\\{\\{#(?:if|when)\\b/.test(data)) {\n            data = risuChatParser(data, { chara: char, chatID, rmVar: true, visualize: true, cbsConditions });\n        }", file);
          // The host toolbar's 사고과정 switch (webuiHideThinking): the model's
          // reasoning is left out of the display, not out of the saved message.
          // Taken out before the display scripts run, so the boxes modules draw
          // with the same tag stay (see thoughts.js).
          // And after them, the closed box a message opens with -- how a module
          // that draws the reasoning itself shows it (hideLeadingThoughts).
          code = "import { hideThoughts, hideLeadingThoughts } from '../../webui-thoughts.js';\n" + code;
          code = replaceOnce(code,
            "    let firstParsed = ''\n    const additionalAssetMode",
            "    if (DBState.db.webuiHideThinking) data = hideThoughts(data)\n    let firstParsed = ''\n    const additionalAssetMode", file);
          code = replaceOnce(code,
            "function parseThoughtsAndTools(data:string){\n",
            "function parseThoughtsAndTools(data:string){\n    if (DBState.db.webuiHideThinking) data = hideLeadingThoughts(data)\n", file);
          // The blob has the actual type. A hard-coded MP4/MP3 <source> type
          // prevents the browser from trying WAV, Ogg and WebM assets.
          code = code.replaceAll(' type="video/mp4"', '').replaceAll(' type="audio/mpeg"', '');
        }
        return { code: code.replace(assetPattern, match => match[0] + '/risuai/' + match.slice(2)), map: null };
      },
    }, ...config.plugins],
    resolve: { ...config.resolve, alias: { src: path.resolve('src') } },
    build: { ...config.build, sourcemap: false },
  };
};
