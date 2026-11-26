import { readFileSync } from 'node:fs';
import { sentryVitePlugin } from '@sentry/bundler-plugins/vite';
import { defineConfig, loadEnv } from 'vite';
import { modelProxyPlugin } from './worker/dev-proxy.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN || process.env.SENTRY_AUTH_TOKEN;
  const sentryRelease = env.VITE_SENTRY_RELEASE || process.env.VITE_SENTRY_RELEASE || `moodsift@${pkg.version}`;

  return {
    // /models/ must be handled server-side in dev and preview too. The plugin
    // calls worker/model-proxy.ts (the production handler), so the browser never
    // receives a Hugging Face redirect to follow directly.
    plugins: [
      modelProxyPlugin(),
      ...(command === 'build' && sentryAuthToken
        ? [
            sentryVitePlugin({
              org: 'adj189',
              project: 'moodsift-frontend',
              authToken: sentryAuthToken,
              release: { name: sentryRelease },
              sourcemaps: {
                filesToDeleteAfterUpload: ['./dist/**/*.map'],
              },
            }),
          ]
        : []),
    ],
    build: {
      target: 'es2022',
      sourcemap: 'hidden',
      rollupOptions: {
        output: {
          // Keep the optional in-browser LLM module in its own chunk so it
          // never ships to users who don't opt into it.
          manualChunks(id) {
            if (id.includes('src/lib/llm.ts')) return 'llm';
            if (id.includes('src/lib/ambient.ts')) return 'ambient';
          },
        },
      },
    },
    server: {
      port: 5173,
    },
    preview: {
      port: 4173,
    },
  };
});
