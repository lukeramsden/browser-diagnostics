import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Build 2: the content agent as one self-contained classic script.
// executeScript({ files }) cannot load ES modules, so no code splitting here.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: mode === 'test' ? 'dist-test' : 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/agent/index.ts'),
      name: 'BrowserDiagnosticsAgent',
      formats: ['iife'],
      fileName: () => 'agent.js',
    },
  },
}));
