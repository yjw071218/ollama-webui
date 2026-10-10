// Before server/api.js, which reaches node:sqlite. See server/quiet.js.
import './server/quiet.js';
import { ensureManagedOllama } from './server/ollamaRuntime.js';

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiRoutes } from './server/api.js';
import { normaliseOrigin } from './server/origin.js';
import { backendOf } from './server/llamacpp.js';
import { cliInterceptor } from './server/cliModels.js';
import { inferenceHook, isInference, vramGuard } from './server/vram.js';
import { startScheduleRunner } from './server/serverSchedules.js';
import { resumeLongVideos } from './server/studio.js';

// The API is shared with the production server (server/index.js) so that
// `npm run dev` and `npm start` cannot drift apart.
const apiPlugin = (env = {}) => ({
  name: 'ollama-webui-api',
  async configureServer(server) {
    await ensureManagedOllama(env);
    // The dev server answers an account's schedules too; see server/serverSchedules.js.
    startScheduleRunner(env, { beforeInference: () => vramGuard(env).beforeInference() });
    resumeLongVideos(env);
    // Ahead of everything, the llama.cpp routes and the Ollama proxy alike:
    // ComfyUI lets go of the card before a language model is loaded onto it,
    // and while one of our videos is being drawn the model answers from the
    // CPU instead. See server/vram.js.
    // Claude, GPT and Gemini through the signed-in CLIs, ahead of both: they
    // use none of the card. See server/cliModels.js.
    const cliModels = cliInterceptor(env);
    server.middlewares.use((req, res, next) => {
      if (!(req.url || '').startsWith('/api/')) return next();
      cliModels(req, res, next);
    });
    const inference = inferenceHook(env);
    server.middlewares.use((req, res, next) => {
      if (!isInference((req.url || '').split('?')[0])) return next();
      inference(req, res, next);
    });
    for (const { path, handler } of createApiRoutes(env)) {
      server.middlewares.use(path, handler);
    }
  },
});

/* Every UI language but English as its own chunk, in a build only.
   src/i18n.jsx keeps all twelve tables in one file -- the tests read it as
   text -- which put a megabyte of translations nobody reads into the first
   download. Here each table is cut out into a module of its own and the
   file's LANGUAGE_LOADERS is pointed at them; see loadLanguage there. */
const I18N_LAZY = { ko: 'ko', ja: 'ja', zhHans: 'zh-Hans', zhHant: 'zh-Hant', es: 'es', fr: 'fr', de: 'de', pt: 'pt', ru: 'ru', vi: 'vi', ar: 'ar' };
const PREFIX = 'virtual:i18n-lang/';
const VIRTUAL = '\0'; // Rollup's mark for a module with no file behind it.
const i18nSplit = () => {
  const tables = new Map();
  return {
    name: 'ollama-webui-i18n-split',
    apply: 'build',
    enforce: 'pre',
    resolveId(id) { return id.startsWith(PREFIX) ? VIRTUAL + id : null; },
    load(id) {
      if (!id.startsWith(VIRTUAL + PREFIX)) return null;
      const lang = id.slice(PREFIX.length + 1);
      if (!tables.has(lang)) throw new Error(`i18nSplit: no table for ${lang}`);
      return `export default ${tables.get(lang)};`;
    },
    transform(code, id) {
      if (!/[\\/]src[\\/]i18n\.jsx(\?|$)/.test(id)) return null;
      let out = code.replace(/\r\n/g, '\n');
      const loaders = [];
      for (const [name, lang] of Object.entries(I18N_LAZY)) {
        const head = '\nconst ' + name + ' = {\n';
        const start = out.indexOf(head);
        const end = start < 0 ? -1 : out.indexOf('\n};\n', start);
        if (end < 0) throw new Error(`i18nSplit: table ${name} not found in src/i18n.jsx`);
        tables.set(lang, out.slice(start + head.length - 2, end + 3));
        out = out.slice(0, start) + '\nconst ' + name + ' = {};' + out.slice(end + 3);
        loaders.push(`${JSON.stringify(lang)}: () => import(${JSON.stringify(PREFIX + lang)})`);
      }
      if (!out.includes('const LANGUAGE_LOADERS = null;')) throw new Error('i18nSplit: LANGUAGE_LOADERS not found');
      out = out.replace('const LANGUAGE_LOADERS = null;', `const LANGUAGE_LOADERS = { ${loaders.join(', ')} };`);
      return { code: out, map: null };
    },
  };
};

// https://vitejs.dev/config/
// The third argument to loadEnv is an empty prefix, so unprefixed values like
// KAKAO_CLIENT_SECRET are readable here without ever being exposed to the client.
/* With emptyOutDir off, hashed assets older than two weeks are swept. */
const keepOldAssets = () => ({
  name: 'ollama-webui-keep-old-assets', apply: 'build',
  async closeBundle() {
    const fs = await import('node:fs'); const path = await import('node:path');
    const dir = path.resolve('dist/assets'); const cutoff = Date.now() - 14 * 86400_000;
    try { for (const f of fs.readdirSync(dir)) { const full = path.join(dir, f); try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch {} } } catch {}
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // The address everything should be opened on, if .env names one. See
  // server/origin.js: two hostnames reaching one server are still two origins,
  // and a browser gives two origins two of everything.
  const canonical = normaliseOrigin(env.PUBLIC_ORIGIN, { port: Number(env.PORT) || 5173 });
  const canonicalHost = canonical ? new URL(canonical).hostname : '';

  return {
    plugins: [i18nSplit(), react(), apiPlugin(env), keepOldAssets()],
    /* The previous build's chunks stay: a page still open on it loads its lazy
       panels from them instead of reloading itself (src/lazyPanel.jsx). */
    build: { emptyOutDir: false },
    server: {
      // OAuth redirect URIs are registered per exact origin, so the port must
      // not drift. Without strictPort a second `npm run dev` silently lands on
      // 5174 and every social sign-in fails with a redirect-URI mismatch.
      port: 5173,
      strictPort: true,
      /* The engines are whole installs -- a Python runtime and its site-packages,
         model weights, hundreds of thousands of files -- and none of them is
         source. A watcher left to walk them is the startup stall and the memory
         creep this app has already been through once. */
      watch: { ignored: ['**/engines/**', '**/integrations/risuai/upstream/**'] },
      // Loopback only is the default, and it makes `npm run dev` invisible to
      // the phone this app is meant to be used from — the one device where the
      // mobile layout can actually be looked at. `npm start` has bound beyond
      // loopback all along; the two are not supposed to drift.
      host: true,
      // Vite refuses a request whose Host header it does not recognise. Bare IP
      // addresses and `localhost` pass by default, so a phone reaching this by
      // address already worked; a *hostname* did not, and the app hands out two
      // of them. `<address>.nip.io` is what server/index.js prints for social
      // sign-in, because Google will not accept a bare IP as an origin, and
      // whatever is in PUBLIC_ORIGIN is by definition an address someone meant
      // to serve on. Without these, both fail as a blank page that says only
      // "Blocked request", which is a bad hour to spend.
      //
      // What is being given up: the check exists to stop a hostile page from
      // pointing a name at 127.0.0.1 and talking to a dev server through the
      // browser. `.nip.io` is precisely the tool for that, so this is a real
      // loosening — acceptable here because the same names are the documented
      // way to use this app, and the production server (server/index.js) has
      // never had a host check at all; it uses ACCESS_TOKEN instead.
      allowedHosts: [
        'localhost',
        '.nip.io',
        ...(canonicalHost ? [canonicalHost] : []),
      ],
      proxy: {
        '/api/start-tts': {
          // Handled by our middleware; kept separate from the Ollama proxy.
        },
        /* Whatever the API middleware above did not claim.
         *
         * Under Ollama that is every inference call and this proxy is where
         * they go. Under llama.cpp the translating routes in server/llamacpp.js
         * are mounted as middleware and match first, so this would only ever
         * catch a path llama.cpp has no answer for — and quietly forwarding
         * that to an Ollama which may not even be running is a confusing way to
         * fail. So it is not mounted at all on that backend. */
        ...(backendOf(env) === 'llamacpp' ? {} : {
          '/api': {
            target: env.OLLAMA_URL || 'http://localhost:11434',
            changeOrigin: true,
            /* A body server/cliModels.js already read, to see which model it
               named, is not in the request stream any more. It is written
               here instead; the proxy's own pipe of the spent stream then
               only ends the request. */
            configure: (proxy) => proxy.on('proxyReq', (proxyReq, req) => {
              if (!req.rawBody) return;
              proxyReq.setHeader('Content-Length', req.rawBody.length);
              proxyReq.write(req.rawBody);
            }),
          },
        }),
        '/tts-api': {
          target: `http://${env.TTS_HOST || '127.0.0.1'}:${env.TTS_PORT || 9880}`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/tts-api/, ''),
        },
      },
    },
  };
});
