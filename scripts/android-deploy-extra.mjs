/**
 * 多设备辅助部署脚本
 * 在已有设备通过 tauri android dev 运行后，将 APK 安装到其他 Android 设备并启动
 *
 * 用法: node scripts/android-deploy-extra.mjs
 * 前置条件: PC 端 Vite 开发服务器已运行 (npm run tauri dev 或 npm run dev)
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import http from 'http';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const APK_DIR = path.resolve(PROJECT_ROOT, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
const PACKAGE_NAME = 'com.aurora.gallery';
const MAIN_ACTIVITY = 'com.aurora.gallery.MainActivity';
const VITE_PORT = 14422;

function run(cmd, options = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...options });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function getDevices() {
  const output = runCapture('adb devices');
  const lines = output.split('\n').filter(l => l.includes('\t'));
  return lines
    .map(l => {
      const [serial, status] = l.split('\t');
      return { serial, status: status.trim() };
    })
    .filter(d => d.status === 'device');
}

function getLatestApk() {
  // 优先找 arm64（物理设备），其次 universal
  const candidates = [
    path.join(APK_DIR, 'arm64', 'debug', 'app-arm64-debug.apk'),
    path.join(APK_DIR, 'universal', 'debug', 'app-universal-debug.apk'),
  ];
  for (const apk of candidates) {
    if (fs.existsSync(apk)) return apk;
  }
  // 全量搜索
  const files = fs.readdirSync(APK_DIR, { recursive: true })
    .filter(f => f.endsWith('.apk') && !f.includes('unsigned'))
    .map(f => path.join(APK_DIR, f));
  // 按修改时间排序，取最新的
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function waitForViteServer() {
  return new Promise((resolve) => {
    const tryConnect = () => {
      const req = http.get(`http://localhost:${VITE_PORT}`, (res) => {
        resolve();
      });
      req.on('error', () => {
        process.stdout.write('.');
        setTimeout(tryConnect, 1000);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(tryConnect, 1000);
      });
    };
    process.stdout.write(`[deploy-extra] 等待 Vite 开发服务器 (localhost:${VITE_PORT})`);
    tryConnect();
  });
}

async function main() {
  console.log('=== 多设备辅助部署 ===\n');

  // 1. 等待 Vite 服务器
  await waitForViteServer();
  console.log('  [OK] Vite 服务器已就绪\n');

  // 2. 查找 APK
  const apkPath = getLatestApk();
  if (!apkPath) {
    console.error('[错误] 未找到已构建的 APK！');
    console.error('  请先运行 npm run tauri:android:dev:reuse 或 npm run tauri:android:dev 构建一次 APK');
    process.exit(1);
  }
  console.log(`[APK] ${apkPath}`);
  const apkSize = (fs.statSync(apkPath).size / 1024 / 1024).toFixed(1);
  console.log(`[大小] ${apkSize} MB\n`);

  // 3. 获取设备列表
  const allDevices = getDevices();
  if (allDevices.length === 0) {
    console.error('[错误] 未检测到任何 Android 设备！');
    console.error('  请确保设备已通过 USB 连接并开启 USB 调试');
    process.exit(1);
  }
  console.log(`[设备] 共检测到 ${allDevices.length} 台设备：`);
  allDevices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.serial} (${d.status})`);
  });

  // 4. 选择目标设备（跳过已有的主调试设备）
  let targetDevices = allDevices;

  // 如果有多台设备，询问用户是否安装到所有设备
  if (allDevices.length > 1) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    const answer = await new Promise(resolve => {
      rl.question(`\n安装到所有 ${allDevices.length} 台设备？(Y/n): `, resolve);
    });
    rl.close();
    if (answer.toLowerCase() === 'n') {
      console.log('跳过安装。');
      return;
    }
  }

  // 5. 安装到目标设备
  console.log('\n[安装] 开始安装 APK...');
  for (const device of targetDevices) {
    try {
      console.log(`\n  → ${device.serial}`);
      run(`adb -s ${device.serial} install -r "${apkPath}"`);
      console.log(`  ✓ 安装完成`);

      // 6. 启动应用
      console.log(`  → 启动应用...`);
      run(`adb -s ${device.serial} shell am start -n ${PACKAGE_NAME}/${MAIN_ACTIVITY} -W`);
      console.log(`  ✓ 应用已启动`);
    } catch (e) {
      console.error(`  ✗ 设备 ${device.serial} 部署失败:`, e.message);
    }
  }

  console.log('\n=== 部署完成 ===');
  console.log(`提示：所有设备上的应用已连接到 Vite 开发服务器，修改代码后自动 Hot Reload`);
  console.log(`      如需查看日志，可运行: adb -s <设备序列号> logcat -s Tauri Rust`);
}

main().catch(e => {
  console.error('脚本执行失败:', e.message);
  process.exit(1);
});