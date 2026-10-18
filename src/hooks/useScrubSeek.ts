import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { recordSeekLatency } from '../utils/scrubProbe';

/**
 * 进度条拖拽期间的**实时 seek**（画面跟着进度走）。
 *
 * 为什么需要它：不接实时 seek 时，拖拽只改时间文字、松手才 seek，画面在整段拖拽里纹丝不动，
 * 与安卓端（2026-10-18 已放开）行为不一致。
 *
 * ## 为什么是「在飞门控 + 只追最新」而不是「按时间节流」
 *
 * 第一版按时间节流（每 200ms 无脑发一发）。真应用里量出来的问题是：**一发 seek 要 80~280ms
 * 才落地**（2026-10-19 埋点，n=48：缓冲内 p50 80ms、缓冲外 p50 111ms），比 200ms 的发射间隔还长，
 * 于是**你拖出来的 seek 里有约 31% 根本没来得及出画就被下一发顶掉**（同一轮 22 发被取代）。
 * 观感就是"画面偶尔跳到两秒前那个位置"。
 *
 * 现在改成：**同时最多一发在飞**；新目标只记进 `pendingRef`，等这一发 `seeked` 落地后
 * **立刻追最新那个**。有效刷新率由播放器自己决定（约 9~12/s，比原来的 5/s 更快），
 * 而且每一发都是真出过画的。
 *
 * ## 两条别踩的老坑（都在这里防住了）
 *
 * 1. **不能写成去抖**：「每来一发就 clearTimeout + setTimeout」会让手指连续移动时计时器
 *    永远推后、seek 一次都不落地（安卓那轮实测过，而时间文字照改，只看文字会误判成在工作）。
 * 2. **一个元素只能有一个在飞的记录**：监听器必须成对增删，否则被取代的那些会把延迟算到
 *    后面那发的事件上（本仓库探针第二版就栽在这儿，表现为"越拖越慢"的假信号）。
 *
 * `MIN_SEEK_GAP_MS` 是下限保护：小文件上 `seeked` 只要几毫秒，纯门控会退化成每帧一发。
 */

/** 两发 seek 之间的最小间隔。防的是"文件小、seeked 秒回"时退化成请求风暴。 */
const MIN_SEEK_GAP_MS = 60;
/** `seeked` 万一不来（外部改了 currentTime、元素出错）不能把门控锁死。 */
const SEEK_SETTLE_MS = 3000;
/**
 * 「从没发过」的哨兵。**不能用 0**：页面刚加载完 `performance.now()` 本身就接近 0，
 * 那会让第一发被最小间隔无故压后（这个错在本文件里犯过两次，测试真撞出来了）。
 */
const NEVER = Number.NEGATIVE_INFINITY;

export function useScrubSeek(videoRef: RefObject<HTMLVideoElement | null>) {
    /** 最新但还没落地的目标。`null` = 没有待追的。 */
    const pendingRef = useRef<number | null>(null);
    /** 当前在飞的那一发；`null` = 播放器空闲，可以立刻发。 */
    const flyingRef = useRef<{ target: number; onSeeked: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);
    const gapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastAtRef = useRef(NEVER);
    /** `apply` 落地后要叫的"发下一发"，用 ref 存：两者互相引用，直接闭包会踩 TDZ 与陈旧实例。 */
    const pumpRef = useRef<() => void>(() => {});

    const dropFlying = useCallback(() => {
        const f = flyingRef.current;
        if (!f) return;
        flyingRef.current = null;
        clearTimeout(f.timer);
        videoRef.current?.removeEventListener('seeked', f.onSeeked);
    }, [videoRef]);

    const dropGapTimer = () => {
        if (gapTimerRef.current !== null) {
            clearTimeout(gapTimerRef.current);
            gapTimerRef.current = null;
        }
    };

    /** 发一发 seek，并把 `seeked` 挂成"落地即追最新"。 */
    const apply = useCallback((t: number) => {
        const v = videoRef.current;
        if (!v) return;
        dropFlying();
        dropGapTimer();

        const settle = () => {
            if (flyingRef.current?.target !== t) return;   // 已被更新的一发取代，别重复收尾
            dropFlying();
            pumpRef.current();
        };
        const onSeeked = () => settle();
        const timer = setTimeout(settle, SEEK_SETTLE_MS);
        flyingRef.current = { target: t, onSeeked, timer };
        v.addEventListener('seeked', onSeeked);

        lastAtRef.current = performance.now();
        const setAt = lastAtRef.current;
        v.currentTime = t;
        // 被动埋点：量真实拖拽下「发出目标 → seeked」要多久（只在 dev 构建里跑）
        if (import.meta.env.DEV) recordSeekLatency(v, t, setAt);
    }, [videoRef, dropFlying]);

    /** 播放器空闲时决定：够间隔就发，不够就等余下的时间到再发。 */
    const pump = useCallback(() => {
        if (flyingRef.current) return;
        const next = pendingRef.current;
        if (next === null) return;
        pendingRef.current = null;        // 必须在这里取走：留着它，落地回调会再拿它发一遍，无限自激
        const wait = MIN_SEEK_GAP_MS - (performance.now() - lastAtRef.current);
        if (wait <= 0) apply(next);
        else gapTimerRef.current = setTimeout(() => { gapTimerRef.current = null; pump(); }, wait);
    }, [apply]);
    pumpRef.current = pump;

    /**
     * 拖出一个新目标。**不排队历史位置**——只留最新那个，等当前这发落地再追。
     * 播放器空闲时由 `pump()` 立刻发，所以这里不需要时间窗口去"攒"。
     */
    const scheduleScrub = useCallback((t: number) => {
        pendingRef.current = t;
        pump();
    }, [pump]);

    /**
     * 结束拖拽（松手）：丢掉待追的，把最终位置**立刻**落地。
     * 这里绕过在飞门控是有意的——松手那一下必须精确，宁可顶掉在飞的那一发。
     */
    const flushScrub = useCallback((t: number) => {
        pendingRef.current = null;
        apply(t);
    }, [apply]);

    // 组件卸载（切换文件、关闭查看器）时把在飞的与待追的都收干净
    useEffect(() => () => {
        dropFlying();
        dropGapTimer();
        pendingRef.current = null;
    }, [dropFlying]);

    return { scheduleScrub, flushScrub };
}
