import { useEffect, useRef } from 'react';

interface UsePinchZoomOptions {
  onPinchStart?: () => void;
  onPinchZoom: (totalScale: number) => void;
  onPinchEnd?: () => void;
  minDistance?: number;
}

export function usePinchZoom(
  elementRef: React.RefObject<HTMLElement | null> | undefined | null,
  options: UsePinchZoomOptions
) {
  const { onPinchStart, onPinchZoom, onPinchEnd, minDistance = 10 } = options;
  const onPinchStartRef = useRef(onPinchStart);
  onPinchStartRef.current = onPinchStart;
  const onPinchZoomRef = useRef(onPinchZoom);
  onPinchZoomRef.current = onPinchZoom;
  const onPinchEndRef = useRef(onPinchEnd);
  onPinchEndRef.current = onPinchEnd;

  const initialDistanceRef = useRef(0);
  const isPinchingRef = useRef(false);

  const getTouchDistance = (t1: Touch, t2: Touch): number => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  useEffect(() => {
    const element = elementRef?.current;
    if (!element) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        if (dist > minDistance) {
          e.preventDefault();
          isPinchingRef.current = true;
          initialDistanceRef.current = dist;
          onPinchStartRef.current?.();
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isPinchingRef.current || e.touches.length !== 2) return;
      e.preventDefault();

      const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      if (currentDistance < minDistance) return;

      const totalScale = currentDistance / initialDistanceRef.current;
      onPinchZoomRef.current(totalScale);
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (isPinchingRef.current && e.touches.length < 2) {
        isPinchingRef.current = false;
        initialDistanceRef.current = 0;
        onPinchEndRef.current?.();
      }
    };

    element.addEventListener('touchstart', handleTouchStart, { passive: false });
    element.addEventListener('touchmove', handleTouchMove, { passive: false });
    element.addEventListener('touchend', handleTouchEnd, { passive: false });
    element.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [elementRef, minDistance]);
}
