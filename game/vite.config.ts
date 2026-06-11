import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// @pigeon/protocol is shared source (../protocol), consumed via alias rather
// than a published package — so every visualizer builds on the same Pigeon API
// client without a separate install step. The in-cluster build ships
// ../protocol alongside the app (see cluster/up.ps1).
export default defineConfig({
  build: { target: 'es2022' },
  server: { port: 5173 },
  resolve: {
    alias: {
      '@pigeon/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
});
