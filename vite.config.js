import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createApiRoutes } from './server/api.js';

// The API is shared with the production server (server/index.js) so that
// `npm run dev` and `npm start` cannot drift apart.
const apiPlugin = (env = {}) => ({
  name: 'ollama-webui-api',
  configureServer(server) {
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

  return {
    plugins: [react(), apiPlugin(env)],
    server: {
      // OAuth redirect URIs are registered per exact origin, so the port must
      // not drift. Without strictPort a second `npm run dev` silently lands on
      // 5174 and every social sign-in fails with a redirect-URI mismatch.
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/start-tts': {
          // Handled by our middleware; kept separate from the Ollama proxy.
        },
        '/api': {
          target: 'http://localhost:11434',
          changeOrigin: true,
        },
        '/tts-api': {
          target: `http://${env.TTS_HOST || '127.0.0.1'}:${env.TTS_PORT || 9880}`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/tts-api/, ''),
        },
      },
    },
  };
});
