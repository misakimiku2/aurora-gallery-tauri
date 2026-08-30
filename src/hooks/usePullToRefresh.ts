import { useRef, useState, useEffect } from 'react';

interface PullToRefreshState {
  isPulling: boolean;
  isRefreshing: boolean;
  canRefresh: boolean;
  isComplete: boolean;
}

interface UsePullToRefreshOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onRefresh: () => Promise<void>;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  pullDistanceRef?: React.MutableRefObject<number>;
  threshold?: number;
  maxPull?: number;
  resistance?: number;
  enabled?: boolean;
}

const COMPLETE_DELAY = 800;

function applyContentTransform(el: HTMLElement | null, distance: number) {
  if (!el) return;
  if (distance > 0) {
    el.style.transform = `translateY(${distance}px)`;
    el.style.transition = 'none';
  } else {
    el.style.transform = '';
    el.style.transition = 'transform 300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
  }
}

export function usePullToRefresh({
  containerRef,
  onRefresh,
  contentRef,
  pullDistanceRef,
  threshold = 80,
  maxPull = 160,
  resistance = 0.5,
  enabled = true,
}: UsePullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>({
    isPulling: false,
    isRefreshing: false,
    canRefresh: false,
    isComplete: false,
  });

  const touchStartY = useRef(0);
  const currentPullRef = useRef(0);
  const isRefreshingRef = useRef(false);
  const isCompleteRef = useRef(false);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const refreshStartTimeRef = useRef<number>(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const maxPullRef = useRef(maxPull);
  maxPullRef.current = maxPull;
  const resistanceRef = useRef(resistance);
  resistanceRef.current = resistance;

  const localPullDistanceRef = useRef(0);
  const activePullRef = pullDistanceRef || localPullDistanceRef;

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    console.log('[PullToRefresh] initialized', {
      id: container.id || container.className.slice(0, 40),
      threshold,
      maxPull,
      resistance,
      enabled,
    });

    const handleTouchStart = (e: TouchEvent) => {
      // 仅单指下拉生效：双指捏合时绝不能让 PTR 拖动内容
      if (e.touches.length !== 1) return;
      if (isRefreshingRef.current || isCompleteRef.current) {
        return;
      }
      if (container.scrollTop > 0) {
        return;
      }

      touchStartY.current = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      // 仅单指拉动：双指（捏合）期间不参与 PTR
      if (e.touches.length !== 1) {
        if (currentPullRef.current > 0) {
          currentPullRef.current = 0;
          activePullRef.current = 0;
          applyContentTransform(contentRef?.current ?? null, 0);
          setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
        }
        return;
      }
      if (isRefreshingRef.current || isCompleteRef.current) return;
      if (container.scrollTop > 2) {
        if (currentPullRef.current > 0) {
          console.log('[PullToRefresh] cancelled — scrollTop changed to', container.scrollTop.toFixed(1));
          currentPullRef.current = 0;
          activePullRef.current = 0;
          applyContentTransform(contentRef?.current ?? null, 0);
          setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
        }
        return;
      }

      const deltaY = e.touches[0].clientY - touchStartY.current;
      if (deltaY <= 0) {
        if (currentPullRef.current > 0) {
          console.log('[PullToRefresh] cancelled — deltaY <= 0, was at', currentPullRef.current.toFixed(1));
          currentPullRef.current = 0;
          activePullRef.current = 0;
          applyContentTransform(contentRef?.current ?? null, 0);
          setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
        }
        return;
      }

      if (deltaY > 10 && e.cancelable) {
        e.preventDefault();
      }

      const dampened = Math.min(maxPullRef.current, deltaY * resistanceRef.current);
      currentPullRef.current = dampened;
      activePullRef.current = dampened;

      applyContentTransform(contentRef?.current ?? null, dampened);

      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        const reachedThreshold = dampened >= thresholdRef.current;
        setState(prev => {
          if (prev.isPulling && prev.canRefresh === reachedThreshold) return prev;
          return { isPulling: true, isRefreshing: false, canRefresh: reachedThreshold, isComplete: false };
        });
      });
    };

    const handleTouchEnd = () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      if (isRefreshingRef.current || isCompleteRef.current) {
        return;
      }

      const finalPull = currentPullRef.current;
      console.log('[PullToRefresh] touchend', { finalPull: finalPull.toFixed(1), threshold: thresholdRef.current, willRefresh: finalPull >= thresholdRef.current });

      if (finalPull >= thresholdRef.current) {
        console.log('[PullToRefresh] >>> triggering refresh');
        isRefreshingRef.current = true;
        refreshStartTimeRef.current = Date.now();
        currentPullRef.current = 0;

        if (contentRef?.current) {
          contentRef.current.style.transform = `translateY(${thresholdRef.current}px)`;
          contentRef.current.style.transition = 'none';
        }

        setState({ isPulling: false, isRefreshing: true, canRefresh: true, isComplete: false });

        onRefreshRef.current()
          .then(() => {
            const elapsed = Date.now() - refreshStartTimeRef.current;
            console.log('[PullToRefresh] <<< refresh completed', { elapsedMs: elapsed });
            isRefreshingRef.current = false;
            isCompleteRef.current = true;
            setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: true });

            completeTimerRef.current = setTimeout(() => {
              console.log('[PullToRefresh] --- complete timeout, resetting');
              isCompleteRef.current = false;
              activePullRef.current = 0;
              applyContentTransform(contentRef?.current ?? null, 0);
              setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
            }, COMPLETE_DELAY);
          })
          .catch((err) => {
            const elapsed = Date.now() - refreshStartTimeRef.current;
            console.error('[PullToRefresh] !!! refresh failed', { elapsedMs: elapsed, error: err });
            isRefreshingRef.current = false;
            isCompleteRef.current = true;
            setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: true });

            completeTimerRef.current = setTimeout(() => {
              console.log('[PullToRefresh] --- complete timeout (after error), resetting');
              isCompleteRef.current = false;
              activePullRef.current = 0;
              applyContentTransform(contentRef?.current ?? null, 0);
              setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
            }, COMPLETE_DELAY);
          });
      } else {
        console.log('[PullToRefresh] below threshold, dismissing', { finalPull: finalPull.toFixed(1), threshold: thresholdRef.current });
        currentPullRef.current = 0;
        activePullRef.current = 0;
        applyContentTransform(contentRef?.current ?? null, 0);
        setState({ isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
    };
  }, [containerRef, contentRef, pullDistanceRef, enabled]);

  return {
    isPulling: state.isPulling,
    isRefreshing: state.isRefreshing,
    canRefresh: state.canRefresh,
    isComplete: state.isComplete,
  };
}