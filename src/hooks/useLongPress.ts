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
