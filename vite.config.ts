import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  clearScreen: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 1422,
    strictPort: true,
    // Listen on all interfaces to ensure availability
    host: '0.0.0.0',
    // Let Vite determine HMR settings automatically based on host
    hmr:  {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 1422,
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  }
});