import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Independent visualizer, same engine: imports @pigeon/protocol from the shared
// package (../protocol). Runs on :5174 so it can sit alongside the belt game
// (:5173) during dev.
export default defineConfig({
  build: { target: 'es2022' },
  server: { port: 5174 },
  resolve: {
    alias: {
      '@pigeon/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
});
