import { useEffect, useRef } from 'react';
import { signalMultiTouchCancel } from '../utils/touchGestureGuard';

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
  const { onPinchStart, onPinchZoom, onPinchEnd, minDistance = 18 } = options;
  const onPinchStartRef = useRef(onPinchStart);
  onPinchStartRef.current = onPinchStart;
  const onPinchZoomRef = useRef(onPinchZoom);
  onPinchZoomRef.current = onPinchZoom;
  const onPinchEndRef = useRef(onPinchEnd);
  onPinchEndRef.current = onPinchEnd;

  const initialDistanceRef = useRef(0);
  const isPinchingRef = useRef(false);
  // 手势日志：记录时间戳，便于对齐 手势输入→thumbSize→FLIP 的完整时序
  const pinchTraceT0Ref = useRef(0);
  const lastLogScaleRef = useRef(1);

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
        // 第二根手指落下：立即取消所有"单指长按"定时器（长按选择/右键菜单/范围选择）
        signalMultiTouchCancel();
        // 双指触摸不一定是捏合，先阻止浏览器默认行为（文字选择/图片拖拽）
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        pinchTraceT0Ref.current = performance.now();
        console.log(`[Pinch] touchstart 2 fingers dist=${dist.toFixed(1)}px (minDistance=${minDistance}) t=0ms`);
        if (dist > minDistance) {
          isPinchingRef.current = true;
          initialDistanceRef.current = dist;
          lastLogScaleRef.current = 1;
          console.log(`[Pinch] >>> PINCH START (dist=${dist.toFixed(1)}) t=0ms`);
          onPinchStartRef.current?.();
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isPinchingRef.current || e.touches.length !== 2) return;
      // 必须判 cancelable：一旦浏览器已进入原生滚动，后续 touchmove 不可取消，
      // 无条件 preventDefault 会让 Chrome 每次都抛
      // "[Intervention] Ignored attempt to cancel a touchmove event with cancelable=false"。
      // 实测一次捏合刷出 109 条——WebView 挂着调试日志时，光是这百来条控制台
      // 输出就足以拖慢手势期间的每一帧。
      if (e.cancelable) e.preventDefault();

      const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      if (currentDistance < minDistance) return;

      const totalScale = currentDistance / initialDistanceRef.current;
      // 缩放变化 ≥4% 才记录，避免刷屏
      if (Math.abs(totalScale - lastLogScaleRef.current) >= 0.04) {
        lastLogScaleRef.current = totalScale;
        console.log(`[Pinch] zoom scale=${totalScale.toFixed(3)} t=${(performance.now() - pinchTraceT0Ref.current).toFixed(0)}ms`);
      }
      onPinchZoomRef.current(totalScale);
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (isPinchingRef.current && e.touches.length < 2) {
        isPinchingRef.current = false;
        initialDistanceRef.current = 0;
        console.log(`[Pinch] <<< PINCH END t=${(performance.now() - pinchTraceT0Ref.current).toFixed(0)}ms`);
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
