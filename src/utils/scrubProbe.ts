/**
 * 拖拽延迟诊断（**只在 dev 构建里跑**，产物写进应用日志目录，不需要开 DevTools）。
 *
 * 要回答的问题只有一个：**asset 协议每发请求到底多少毫秒、浏览器能并行几条**。
 * 台架（`range-harness/`）量不到这一项，而它是那个 1 MiB 截断代价的乘数 ——
 * 见 docs/视频拖拽实时预览-桌面端-方案草稿-2026-10-18.md §10。
 *
 * 两路数据：
 *  - **主动探针**：对当前这只片子连发若干小 Range 请求，量往返耗时、并行度，
 *    并顺手验一遍「要 8 MiB 实际回多少字节」（截断在真应用里成不成立）。全程后台 fetch，用户看不见。
 *  - **被动埋点**：记录**用户自己拖出来的每一发 seek** 从「发出目标」到 `seeked` 的毫秒数。
 *    这才是他手上那个"延迟挺大"的直接数字，比任何台架都准。
 *
 * 输出：`<应用日志目录>/aurora-scrub-probe.log`，同时 `console.log` 一份作为兜底。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { appLogDir, join } from '@tauri-apps/api/path';
import { writeTextFile } from '@tauri-apps/plugin-fs';

const PROBE_FILE = 'aurora-scrub-probe.log';
const ONE_KIB = 1024;
const ONE_MIB = 1024 * ONE_KIB;

/** 构建戳：证明这份数据是哪一版代码跑出来的（本机时间，精确到分） */
const STAMP = new Date().toISOString().replace('T', ' ').slice(0, 16);

const lines: string[] = [];
let activeDone = false;
let seekCount = 0;
/** 被后继 seek 取代、因而没计入延迟的发数——它本身就是"拖得比重播快"的证据 */
let seekReplaced = 0;

/**
 * 主线程是否在堵。`seeked` 的回调跑在主线程上，所以**只要事件循环被 React 重渲染占住，
 * 量出来的"延迟"就有一部分不是 seek 的成本**。dev 下挂一个 rAF 心跳，把最近的帧间隔
 * 一起打进每条记录里，就能把这两种原因分开。
 */
let lastTick = 0;
let frameGap = 0;
let worstGap = 0;
if (import.meta.env.DEV) {
    const tick = (t: number) => {
        if (lastTick) { frameGap = t - lastTick; if (frameGap > worstGap) worstGap = frameGap; }
        lastTick = t;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

const pct = (sorted: number[], p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

const stat = (name: string, ms: number[], extra = '') => {
    const s = [...ms].sort((a, b) => a - b);
    const avg = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    lines.push(`${name}: n=${s.length} avg=${avg.toFixed(1)} p50=${pct(s, 0.5).toFixed(1)} ` +
        `p90=${pct(s, 0.9).toFixed(1)} max=${(s[s.length - 1] ?? 0).toFixed(1)} ms${extra}`);
};

async function flush() {
    try {
        const path = await join(await appLogDir(), PROBE_FILE);
        await writeTextFile(path, lines.join('\n') + '\n');
        console.log(`[scrubProbe] 已写 ${path}`);
    } catch (e) {
        // 写不出去也别把诊断丢了：整份打到控制台，DevTools 可导出
        console.warn('[scrubProbe] 写文件失败，下面是全文 ↓\n' + lines.join('\n'), e);
    }
}

/** 取一段 Range，返回耗时与实际收到的字节数（字节数是截断的直接证据） */
async function timedRange(url: string, from: number, to: number) {
    const t0 = performance.now();
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
    const buf = await res.arrayBuffer();
    return { ms: performance.now() - t0, got: buf.byteLength, status: res.status };
}

/**
 * 主动探针。`sizeBytes` 用来把「每 MB 多少毫秒」换算成「囤够 N 秒要多久」。
 */
export async function runAssetProbe(path: string, sizeBytes: number): Promise<void> {
    if (activeDone || !import.meta.env.DEV) return;
    activeDone = true;
    const url = convertFileSrc(path);
    lines.push(`# aurora-scrub-probe stamp=${STAMP} file=${path.split(/[\\/]/).pop()} size=${(sizeBytes / ONE_MIB).toFixed(1)}MiB`);

    try {
        // 1) 单发往返（1 KiB，几乎纯开销）
        const one: number[] = [];
        for (let i = 0; i < 20; i++) one.push((await timedRange(url, 0, ONE_KIB - 1)).ms);
        stat('A 单发 1KiB 顺序 ×20', one);

        // 2) 8 发并发 → 有效并行度 = 8 × 单发中位数 / 并发总耗时
        const t0 = performance.now();
        await Promise.all(Array.from({ length: 8 }, () => timedRange(url, 0, ONE_KIB - 1)));
        const wall = performance.now() - t0;
        const serial = [...one].sort((a, b) => a - b)[Math.floor(one.length / 2)];
        lines.push(`B 8 发并发: wall=${wall.toFixed(1)}ms 有效并行度≈${((8 * serial) / wall).toFixed(2)}`);

        // 3) 截断证据：要 8 MiB，看实际回多少
        const big = await timedRange(url, 0, 8 * ONE_MIB - 1);
        lines.push(`C 请求 8.00MiB → 实收 ${(big.got / ONE_MIB).toFixed(2)}MiB status=${big.status} ` +
            `耗时=${big.ms.toFixed(1)}ms`);

        // 4) 每 MiB 的到手速度（顺序 8 发），用来推「囤 8 秒要多久」
        const mb: number[] = [];
        for (let i = 0; i < 8; i++) mb.push((await timedRange(url, i * ONE_MIB, (i + 1) * ONE_MIB - 1)).ms);
        stat('D 单发 1MiB 顺序 ×8', mb);
        const perMiB = mb.reduce((a, b) => a + b, 0) / mb.length;
        const par = (8 * serial) / wall;
        // 囤 8 秒 @64 Mbps ≈ 64 MiB（这就是"拖一下要等多久"的分子）
        lines.push(`E 推算: 每 MiB ${perMiB.toFixed(1)}ms → 囤 8 秒(64Mbps≈64MiB) 顺序要 ` +
            `${(64 * perMiB / 1000).toFixed(2)}s，按上面那个并行度摊 ${(64 * perMiB / 1000 / Math.max(1, par)).toFixed(2)}s`);
    } catch (e) {
        lines.push(`!! 主动探针失败：${String(e)}`);
    }
    lines.push('');
    console.log('[scrubProbe]\n' + lines.join('\n'));
    await flush();
}

/**
 * 被动埋点：量**用户自己拖出来的**每一发 seek 从发出到 `seeked` 的毫秒数。
 *
 * ⚠️ 两个坑，都是这一版修掉的：
 *  1. 「在不在缓冲内」必须在**发出前**读。第一版在 `seeked` 之后读，那时目标必然已被缓冲，
 *     42 条全报 `true`，等于没测。
 *  2. **一个元素只能有一个在飞的 seek 记录。** 上一版每次 seek 各挂一个一次性监听器，
 *     手指拖得比重播快时，被取代的那些不会自己消失，会把延迟算到后面那发的事件上 ——
 *     表现为"越往后越慢"（第二版实测 6ms 一路涨到 1285ms，与 `囤了` 同步涨，是堆积不是真成本）。
 *     现在新 seek 一来就把上一发标 `被取代` 并撤监听，那一发**不计入延迟**。
 *
 * 顺带记 `发出前缓冲内` / `超出` / `囤了` / 本发之前有多少发被取代，用来判断拖拽节奏本身。
 */
type Outstanding = { target: number; setAt: number; onSeeked: () => void; timer: ReturnType<typeof setTimeout> };
const flying = new WeakMap<HTMLVideoElement, Outstanding>();

export function recordSeekLatency(v: HTMLVideoElement, target: number, setAt: number): void {
    if (!import.meta.env.DEV) return;

    // 上一发还没落地就被这次拖拽取代了：它不该计入延迟，只记一笔
    const prev = flying.get(v);
    if (prev) {
        clearTimeout(prev.timer);
        v.removeEventListener('seeked', prev.onSeeked);
        seekReplaced += 1;
        lines.push(`X${seekReplaced} 目标=${prev.target.toFixed(1)}s 被取代（上一发在 ${(performance.now() - prev.setAt).toFixed(0)}ms 时仍未落地）`);
    }

    let inBuf = false, bufEnd = 0, bufTotal = 0;
    for (let i = 0; i < v.buffered.length; i++) {
        const s = v.buffered.start(i), e = v.buffered.end(i);
        bufTotal += e - s;
        if (target >= s && target <= e) inBuf = true;
        if (e > bufEnd) bufEnd = e;
    }
    const gapSec = +(Math.max(0, target - bufEnd)).toFixed(2);
    const ranges = v.buffered.length;

    let done = false;
    const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        flying.delete(v);
        const ms = performance.now() - setAt;
        seekCount += 1;
        lines.push(`S${seekCount} 目标=${target.toFixed(1)}s ${ok ? 'seeked' : '超时'} ${ms.toFixed(0)}ms ` +
            `发出前缓冲内=${inBuf} 超出=${gapSec}s 囤了=${bufTotal.toFixed(1)}s 段数=${ranges} ` +
            `帧间隔=${frameGap.toFixed(0)}/${worstGap.toFixed(0)}ms`);
        if (seekCount % 8 === 0) {
            console.log('[scrubProbe]\n' + lines.join('\n'));
            void flush();
        }
    };
    const onSeeked = () => finish(true);
    const timer = setTimeout(() => finish(false), 5000);
    v.addEventListener('seeked', onSeeked);
    flying.set(v, { target, setAt, onSeeked, timer });
}
