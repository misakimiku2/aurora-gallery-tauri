import { useRef, useState, useEffect } from 'react';

interface PullToRefreshState {
  pullDistance: number;
  isPulling: boolean;
  isRefreshing: boolean;
  canRefresh: boolean;
  isComplete: boolean;
}

interface UsePullToRefreshOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onRefresh: () => Promise<void>;
  threshold?: number;
  maxPull?: number;
  resistance?: number;
  enabled?: boolean;
}

const COMPLETE_DELAY = 800;

export function usePullToRefresh({
  containerRef,
  onRefresh,
  threshold = 80,
  maxPull = 160,
  resistance = 0.5,
  enabled = true,
}: UsePullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>({
    pullDistance: 0,
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
      if (isRefreshingRef.current || isCompleteRef.current) {
        console.log('[PullToRefresh] touchstart ignored — busy (refreshing:', isRefreshingRef.current, 'complete:', isCompleteRef.current, ')');
        return;
      }
      if (container.scrollTop > 0) {
        return;
      }

      touchStartY.current = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isRefreshingRef.current || isCompleteRef.current) return;
      if (container.scrollTop > 2) {
        if (currentPullRef.current > 0) {
          console.log('[PullToRefresh] cancelled — scrollTop changed to', container.scrollTop.toFixed(1));
          currentPullRef.current = 0;
          setState({ pullDistance: 0, isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
        }
        return;
      }

      const deltaY = e.touches[0].clientY - touchStartY.current;
      if (deltaY <= 0) {
        if (currentPullRef.current > 0) {
          console.log('[PullToRefresh] cancelled — deltaY <= 0, was at', currentPullRef.current.toFixed(1));
          currentPullRef.current = 0;
          setState({ pullDistance: 0, isPulling: false, isRefreshing: false, canRefresh: false, isComplete: false });
        }
        return;
      }

      if (deltaY > 10 && e.cancelable) {
        e.preventDefault();
      }

      const dampened = Math.min(maxPullRef.current, deltaY * resistanceRef.current);
      currentPullRef.current = dampened;

      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        const reachedThreshold = dampened >= thresholdRef.current;
        setState({
          pullDistance: dampened,
          isPulling: true,
          isRefreshing: false,
          canRefresh: reachedThreshold,
          isComplete: false,
        });
      });
    };

    const handleTouchEnd = () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }

      if (isRefreshingRef.current || isCompleteRef.current) {
        console.log('[PullToRefresh] touchend ignored — already in progress');
        return;
      }

      const finalPull = currentPullRef.current;
      console.log('[PullToRefresh] touchend', { finalPull: finalPull.toFixed(1), threshold: thresholdRef.current, willRefresh: finalPull >= thresholdRef.current });

      if (finalPull >= thresholdRef.current) {
        console.log('[PullToRefresh] >>> triggering refresh');
        isRefreshingRef.current = true;
        refreshStartTimeRef.current = Date.now();
        currentPullRef.current = 0;
        setState({
          pullDistance: thresholdRef.current,
          isPulling: false,
          isRefreshing: true,
          canRefresh: true,
          isComplete: false,
        });

        onRefreshRef.current()
          .then(() => {
            const elapsed = Date.now() - refreshStartTimeRef.current;
            console.log('[PullToRefresh] <<< refresh completed', { elapsedMs: elapsed });
            isRefreshingRef.current = false;
            isCompleteRef.current = true;
            setState(prev => ({
              ...prev,
              isRefreshing: false,
              isComplete: true,
            }));

            completeTimerRef.current = setTimeout(() => {
              console.log('[PullToRefresh] --- complete timeout, resetting');
              isCompleteRef.current = false;
              setState({
                pullDistance: 0,
                isPulling: false,
                isRefreshing: false,
                canRefresh: false,
                isComplete: false,
              });
            }, COMPLETE_DELAY);
          })
          .catch((err) => {
            const elapsed = Date.now() - refreshStartTimeRef.current;
            console.error('[PullToRefresh] !!! refresh failed', { elapsedMs: elapsed, error: err });
            isRefreshingRef.current = false;
            isCompleteRef.current = true;
            setState(prev => ({
              ...prev,
              isRefreshing: false,
              isComplete: true,
            }));

            completeTimerRef.current = setTimeout(() => {
              console.log('[PullToRefresh] --- complete timeout (after error), resetting');
              isCompleteRef.current = false;
              setState({
                pullDistance: 0,
                isPulling: false,
                isRefreshing: false,
                canRefresh: false,
                isComplete: false,
              });
            }, COMPLETE_DELAY);
          });
      } else {
        console.log('[PullToRefresh] below threshold, dismissing', { finalPull: finalPull.toFixed(1), threshold: thresholdRef.current });
        currentPullRef.current = 0;
        setState({
          pullDistance: 0,
          isPulling: false,
          isRefreshing: false,
          canRefresh: false,
          isComplete: false,
        });
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
  }, [containerRef, enabled]);

  return {
    pullDistance: state.pullDistance,
    isPulling: state.isPulling,
    isRefreshing: state.isRefreshing,
    canRefresh: state.canRefresh,
    isComplete: state.isComplete,
  };
}
