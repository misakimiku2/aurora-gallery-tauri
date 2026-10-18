import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import { useScrubSeek } from '../useScrubSeek';

// 探针会自己再挂一个 seeked 监听器，混进来看不到重点，直接桩掉
vi.mock('../../utils/scrubProbe', () => ({ recordSeekLatency: vi.fn() }));

/** 两发之间的最小间隔，与被测模块保持一致 */
const MIN_GAP = 60;

/**
 * 假 video：`currentTime` 被赋值就记一笔，并在 `seekMs` 之后派发 `seeked`。
 * 监听器按集合维护，所以「有没有成对摘掉」会被真实地检验到。
 */
const setup = (seekMs = 200) => {
    const applied: number[] = [];
    const listeners = new Set<() => void>();
    const video = {
        get currentTime() { return applied.length ? applied[applied.length - 1] : 0; },
        set currentTime(v: number) {
            applied.push(v);
            setTimeout(() => { [...listeners].forEach((l) => l()); }, seekMs);
        },
        addEventListener: (_e: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_e: string, cb: () => void) => listeners.delete(cb),
        buffered: { length: 0 },
    };
    const ref = { current: video } as unknown as RefObject<HTMLVideoElement | null>;
    return { ref, applied, listeners, seeks: () => applied.length, last: () => applied[applied.length - 1] };
};

describe('useScrubSeek', () => {
    // 被测模块同时用 setTimeout 与 performance.now：vitest 默认**不 fake performance**，
    // 两者不同源时"最小间隔"会永远算不满，测出来的行为与浏览器里不是一回事。
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('在飞期间不叠加：只追最新目标，中间位置不补发', () => {
        const { ref, applied } = setup(200);          // 一发要 200ms 才落地
        const { result } = renderHook(() => useScrubSeek(ref));

        act(() => {
            for (const t of [1, 2, 3, 4, 5]) result.current.scheduleScrub(t);
        });
        expect(applied).toEqual([1]);                 // 只有第一发立刻出去，其余全被合并

        act(() => { vi.advanceTimersByTime(200); });  // 第一发落地
        expect(applied).toEqual([1, 5]);              // 追的是最新那个，不是 2/3/4
    });

    it('持续移动时一路落地，不会饿死（去抖写法会在这条挂掉）', () => {
        const { ref, applied } = setup(100);
        const { result } = renderHook(() => useScrubSeek(ref));

        act(() => {
            for (let i = 1; i <= 20; i++) {
                result.current.scheduleScrub(i);
                vi.advanceTimersByTime(50);           // 1000ms 内每 50ms 来一发
            }
        });
        expect(applied.length).toBeGreaterThanOrEqual(6);
        expect(applied[applied.length - 1]).toBe(20); // 最新目标一定追得上
    });

    it('seeked 秒回时仍受最小间隔保护，不退化成每帧一发', () => {
        const { ref, applied } = setup(0);
        const { result } = renderHook(() => useScrubSeek(ref));

        act(() => {
            for (let i = 1; i <= 200; i++) {
                result.current.scheduleScrub(i);
                vi.advanceTimersByTime(5);            // 1000ms 内 200 发事件
            }
        });
        // 1000ms / 60ms ≈ 17，给边界留 2 的余量
        expect(applied.length).toBeLessThanOrEqual(Math.ceil(1000 / MIN_GAP) + 2);
    });

    it('flushScrub 立刻落地最终位置，并丢掉待追的', () => {
        const { ref, applied, seeks, last } = setup(500);   // 在飞很久
        const { result } = renderHook(() => useScrubSeek(ref));

        act(() => { result.current.scheduleScrub(5); });
        act(() => { result.current.scheduleScrub(7); });    // 待追
        const before = seeks();

        act(() => { result.current.flushScrub(12); });
        expect(last()).toBe(12);
        expect(seeks()).toBe(before + 1);                   // 绕过了在飞门控，当场就发

        act(() => { vi.advanceTimersByTime(3000); });
        expect(seeks()).toBe(before + 1);                   // 待追的 7 没被补发
        expect(last()).toBe(12);
    });

    it('卸载后不再发：在飞的那一发落地时不该把待追目标拖到新元素上', () => {
        const { ref, applied, seeks } = setup(300);
        const { result, unmount } = renderHook(() => useScrubSeek(ref));

        act(() => { result.current.scheduleScrub(3); });
        act(() => { result.current.scheduleScrub(9); });    // 待追
        const landed = seeks();

        unmount();
        act(() => { vi.advanceTimersByTime(3000); });
        expect(seeks()).toBe(landed);                       // 落地回调没再触发新 seek
        expect(applied).toEqual([3]);
    });

    it('seeked 一直不来也不会把门控锁死', () => {
        const { ref, applied } = setup(999999);             // 永不落地
        const { result } = renderHook(() => useScrubSeek(ref));

        act(() => { result.current.scheduleScrub(1); });
        expect(applied).toEqual([1]);
        act(() => { vi.advanceTimersByTime(3000); });       // SEEK_SETTLE_MS 兜底
        act(() => { result.current.scheduleScrub(2); });
        expect(applied).toEqual([1, 2]);                    // 门控已经放开
    });
});
