import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [tailwindcss(), TanStackRouterVite({ quoteStyle: 'single' }), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Workspace packages export their TypeScript source under `source`, so the SPA and
    // its tests build from it with no package build step in between.
    conditions: ['source', ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: ['source', ...defaultServerConditions],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/agents': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/api/ws': {
        target: 'ws://localhost:3003',
        ws: true,
      },
      '/api/computer': {
        target: 'ws://localhost:3003',
        ws: true,
      },
    },
  },
});
