import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// In dev we serve from the origin root for convenience; in production the
// Worker mounts the app under /starfield, so generated asset URLs must be
// prefixed with /starfield/ to resolve correctly.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/starfield/' : '/',
  root: resolve(__dirname, 'src/client'),
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'src/client/index.html'),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [resolve(__dirname, '..')],
    },
  },
}));
