import { defineConfig } from 'vite';
import { modelProxyPlugin } from './worker/dev-proxy';

export default defineConfig({
  // /models/ must be handled server-side in dev and preview too. The plugin
  // calls worker/model-proxy.ts (the production handler), so the browser never
  // receives a Hugging Face redirect to follow directly.
  plugins: [modelProxyPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
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
});
