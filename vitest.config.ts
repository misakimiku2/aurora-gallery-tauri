import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// ── 沙箱环境适配（2026-10-16，已定位到 vitest 源码级机制）──
// vitest 会把每个测试模块的 transform 结果写成「交换文件」供 worker 从磁盘 import：
//   join(os.tmpdir(), <sessionId>, <'web'|'ssr'>, sha1(模块 id))
// 本机沙箱的 fs shim 拒绝写系统 TEMP（EPERM）→ 被拒模块对应的测试文件在**收集阶段
// 被静默跳过**（既不 passed 也不 failed）→「N files / M tests」每次不同
// （126 / 140 / 156 / 164 / 173 均出现过）。
// 修复：把 TEMP / TMP 指向项目内目录（沙箱允许写项目目录）；vitest 主进程构造时
// 才读 tmpdir()，此处（配置加载期）生效；worker 进程继承主进程 env，同样命中。
// 注：vitest 1.6 并不存在 experimental.fsModuleCache 选项（曾误加、无效，已移除）。
const projectTmp = join(dirname(fileURLToPath(import.meta.url)), '.vitest-tmp');
try { mkdirSync(projectTmp, { recursive: true }); } catch { /* 目录已存在 */ }
process.env.TEMP = projectTmp;
process.env.TMP = projectTmp;

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setupTests.ts'
  }
});
