import { useCallback, useRef, useState } from 'react';

export type ToastState = { msg: string; visible: boolean };

export function useToasts(initial?: ToastState) {
  const [toast, setToast] = useState<ToastState>(initial || { msg: '', visible: false });
  const timerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string, duration = 2000) => {
    if (!msg) return;
    setToast({ msg, visible: true });
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setToast({ msg: '', visible: false }), duration);
  }, []);

  const hideToast = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast({ msg: '', visible: false });
  }, []);

  return { toast, showToast, hideToast } as const;
}
