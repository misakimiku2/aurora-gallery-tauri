import { useCallback, useRef, useState } from 'react';

export type ToastState = { msg: string; visible: boolean; isLeaving: boolean };

export function useToasts(initial?: ToastState) {
  const [toast, setToast] = useState<ToastState>(initial || { msg: '', visible: false, isLeaving: false });
  const timerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string, duration = 2000) => {
    if (!msg) return;
    // Clear any existing timers
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
    }
    // Show toast immediately
    setToast({ msg, visible: true, isLeaving: false });
    // Set timer to start leaving animation
    timerRef.current = window.setTimeout(() => {
      setToast(prev => ({ ...prev, isLeaving: true }));
      // Set timer to hide toast after animation completes
      leaveTimerRef.current = window.setTimeout(() => {
        setToast({ msg: '', visible: false, isLeaving: false });
      }, 300); // Match CSS transition duration
    }, duration);
  }, []);

  const hideToast = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current);
    }
    setToast({ msg: '', visible: false, isLeaving: false });
  }, []);

  return { toast, showToast, hideToast } as const;
}
