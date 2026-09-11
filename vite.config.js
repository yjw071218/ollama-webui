// Before server/api.js, which reaches node:sqlite. See server/quiet.js.
import './server/quiet.js';

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiRoutes } from './server/api.js';
import { normaliseOrigin } from './server/origin.js';
import { backendOf } from './server/llamacpp.js';
import { vramGuard, isInference } from './server/vram.js';

// The API is shared with the production server (server/index.js) so that
// `npm run dev` and `npm start` cannot drift apart.
const apiPlugin = (env = {}) => ({
  name: 'ollama-webui-api',
  configureServer(server) {
    // Ahead of everything, the llama.cpp routes and the Ollama proxy alike:
    // ComfyUI lets go of the card before a language model is loaded onto it.
    // See server/vram.js.
    const vram = vramGuard(env);
    server.middlewares.use((req, res, next) => {
      if (!isInference((req.url || '').split('?')[0])) return next();
      vram.beforeInference().catch(() => {}).finally(() => next());
    });
    for (const { path, handler } of createApiRoutes(env)) {
      server.middlewares.use(path, handler);
    }
  },
});

// https://vitejs.dev/config/
// The third argument to loadEnv is an empty prefix, so unprefixed values like
// KAKAO_CLIENT_SECRET are readable here without ever being exposed to the client.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // The address everything should be opened on, if .env names one. See
  // server/origin.js: two hostnames reaching one server are still two origins,
  // and a browser gives two origins two of everything.
  const canonical = normaliseOrigin(env.PUBLIC_ORIGIN, { port: Number(env.PORT) || 5173 });
  const canonicalHost = canonical ? new URL(canonical).hostname : '';

  return {
    plugins: [react(), apiPlugin(env)],
    server: {
      // OAuth redirect URIs are registered per exact origin, so the port must
      // not drift. Without strictPort a second `npm run dev` silently lands on
      // 5174 and every social sign-in fails with a redirect-URI mismatch.
      port: 5173,
      strictPort: true,
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
