/**
 * 通用触屏长按 hook。
 *
 * ⚠️ **当前零引用**（2026-10-23 复核仍未接线），但**刻意保留**：
 * - 它是通用 `TouchEvent` 实现，桌面触屏手势也能用，不专属于已退役的安卓壳；
 * - `docs/Android/React安卓版退役残留清单.md` §2 注 ① 明确写它是"本表唯一归属存疑项、
 *   唯一有将来复用价值"，建议最后再决定。
 *
 * 要删就先确认放弃 Windows 触屏长按；否则留着它比将来重写划算。
 */
import { useRef, useCallback } from 'react';

interface UseLongPressOptions {
  onLongPress: (e: TouchEvent) => void;
  delay?: number;
}

export function useLongPress({ onLongPress, delay = 500 }: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);
  const touchPosRef = useRef<{ x: number; y: number } | null>(null);

  const start = useCallback((e: TouchEvent) => {
    isLongPressRef.current = false;
    touchPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };

    timerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      onLongPress(e);
    }, delay);
  }, [onLongPress, delay]);

  const move = useCallback((e: TouchEvent) => {
    if (!touchPosRef.current) return;
    const dx = Math.abs(e.touches[0].clientX - touchPosRef.current.x);
    const dy = Math.abs(e.touches[0].clientY - touchPosRef.current.y);
    if (dx > 10 || dy > 10) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, []);

  const end = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const isLongPress = useCallback(() => isLongPressRef.current, []);

  return {
    onTouchStart: start,
    onTouchMove: move,
    onTouchEnd: end,
    isLongPress,
  };
}
