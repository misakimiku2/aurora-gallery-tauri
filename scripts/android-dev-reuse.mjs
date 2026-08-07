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

function getConnectedDevices() {
  try {
    const output = execSync('adb devices', { encoding: 'utf-8' });
    const lines = output.split('\n').filter(l => l.includes('\t'));
    return lines
      .map(l => {
        const [serial, status] = l.split('\t');
        return { serial, status: status.trim() };
      })
      .filter(d => d.status === 'device');
  } catch {
    return [];
  }
}

// 检查多设备场景
const devices = getConnectedDevices();
const primaryDevice = devices[0]?.serial;

if (devices.length > 1) {
  console.log(`[android-reuse] 检测到 ${devices.length} 台设备：`);
  devices.forEach((d, i) => console.log(`  ${i + 1}. ${d.serial}`));
  console.log(`\n  tauri android dev 一次只能与一台设备建立调试连接。`);
  console.log(`  将使用 ${primaryDevice} 作为主调试设备。`);
  console.log(`  其他设备可通过以下方式手动部署：\n`);
  console.log(`  1. 保持此终端运行`);
  console.log(`  2. 新开终端，运行:`);
  console.log(`     npm run android:deploy-extra\n`);
  console.log(`  (按 Ctrl+C 取消，或等待自动继续...)\n`);
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