import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Independent visualizer, same engine: imports @pigeon/protocol from the shared
// package (../protocol). Runs on :5174 alongside the belt game (:5173).
//
// The COOP/COEP headers enable cross-origin isolation, which is REQUIRED for
// SharedArrayBuffer — how the physics Web Worker streams ball transforms back
// with zero copies. The in-cluster serving will need the same two headers.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation],
  build: { target: 'es2022' },
  server: { port: 5174 },
  preview: {
    port: 5174,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  resolve: {
    alias: {
      '@pigeon/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
});
