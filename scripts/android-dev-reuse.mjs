import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

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

const ip = getLocalIP();
console.log(`[android-reuse] IP: ${ip} (reusing Vite at http://${ip}:14422)`);

process.env.TAURI_DEV_HOST = ip;

const tmpConfig = path.resolve('src-tauri', '.tauri-reuse.json');
const configOverride = { build: { beforeDevCommand: "" } };
fs.writeFileSync(tmpConfig, JSON.stringify(configOverride, null, 2));

try {
  const cmd = `npx tauri android dev --host ${ip} --config ${tmpConfig}`;
  console.log(`[android-reuse] Running: ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: process.env });
} catch (e) {
  process.exit(e.status || 1);
} finally {
  try { fs.unlinkSync(tmpConfig); } catch {}
}