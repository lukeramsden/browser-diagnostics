import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Build 1: UI page + background service worker (ES modules).
// The agent is built separately as a single IIFE (vite.agent.config.ts).
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: 'public',
  define: {
    'import.meta.env.VITE_TEST_HOOKS': JSON.stringify(mode === 'test' ? 'true' : 'false'),
  },
  build: {
    outDir: mode === 'test' ? 'dist-test' : 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    minify: false,
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        ui: resolve(import.meta.dirname, 'src/ui/index.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
