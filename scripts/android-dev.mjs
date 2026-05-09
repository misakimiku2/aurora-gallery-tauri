import { execSync } from 'child_process';
import os from 'os';

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
console.log(`[android-dev] Using IP: ${ip}`);

process.env.TAURI_DEV_HOST = ip;

const extraArgs = process.argv.slice(2).join(' ');
const cmd = `npx tauri android dev --host ${ip} ${extraArgs}`;
console.log(`[android-dev] Running: ${cmd}`);

try {
  execSync(cmd, { stdio: 'inherit', env: process.env });
} catch (e) {
  process.exit(e.status || 1);
}
