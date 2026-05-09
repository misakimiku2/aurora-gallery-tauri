import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const iface of Object.values(interfaces)) {
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) {
        candidates.push(config.address);
      }
    }
  }
  const privateIP = candidates.find(ip =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || ip.match(/^172\.(1[6-9]|2\d|3[01])\./)
  );
  return privateIP || candidates[0] || 'localhost';
}

const isAndroid = process.env.TAURI_ENV_PLATFORM === 'android';
const localIP = getLocalIP();

if (isAndroid && localIP !== 'localhost') {
  process.env.TAURI_DEV_HOST = localIP;
}

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
    port: 14422,
    strictPort: true,
    host: '0.0.0.0',
    ...(isAndroid ? {
      hmr: {
        host: localIP,
        port: 14422,
      }
    } : {}),
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    headers: {
      'Cache-Control': 'no-store',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  }
});
