import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/',
  root: path.resolve(__dirname, 'src/lan-share'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'src-tauri/static/lan-share'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
    target: 'esnext',
    minify: 'esbuild',
    cssCodeSplit: false,
  },
  define: {
    'process.env.LAN_SHARE_MODE': JSON.stringify(true),
  },
});
