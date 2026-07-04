import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Camera, X } from 'lucide-react';
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode';

interface QrScannerModalProps {
  open: boolean;
  onScanResult: (data: string) => void;
  onCancel: () => void;
  onError: (error: string) => void;
  t: (key: string) => string;
}

const SCANNER_REGION_ID = 'aurora-qr-scanner-region';

function safeStopScanner(s: Html5Qrcode): Promise<void> {
  try {
    const state = s.getState();
    if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
      return s.stop().catch(() => {});
    }
  } catch {}
  return Promise.resolve();
}

export const QrScannerModal: React.FC<QrScannerModalProps> = ({
  open,
  onScanResult,
  onCancel,
  onError,
  t,
}) => {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [status, setStatus] = useState<'loading' | 'scanning' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const stoppedRef = useRef(false);

  const startScanner = useCallback(async (scanner: Html5Qrcode) => {
    return scanner.start(
      { facingMode: 'environment' as const },
      { fps: 10 },
      (decodedText) => {
        if (stoppedRef.current) return;
        stoppedRef.current = true;
        scannerRef.current = null;
        safeStopScanner(scanner)
          .then(() => { try { scanner.clear(); } catch {} })
          .finally(() => { onScanResult(decodedText); });
      },
      () => {}
    );
  }, [onScanResult]);

  useEffect(() => {
    if (!open) return;
    const handler = () => {
      (window as any).__androidBackHandled = true;
      onCancel();
    };
    window.addEventListener('android-back-press', handler);
    return () => window.removeEventListener('android-back-press', handler);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;

    stoppedRef.current = false;
    setStatus('loading');
    setErrorMsg('');

    const scanner = new Html5Qrcode(SCANNER_REGION_ID);
    scannerRef.current = scanner;

    startScanner(scanner)
      .then(() => {
        if (!stoppedRef.current) setStatus('scanning');
      })
      .catch((err) => {
        if (stoppedRef.current) return;
        const msg = err?.toString?.() || t('settings.lanShare.client.cameraNotAvailable') || 'Camera not available';
        setStatus('error');
        setErrorMsg(msg);
        onError(msg);
      });

    return () => {
      stoppedRef.current = true;
      const s = scannerRef.current;
      if (s) {
        scannerRef.current = null;
        safeStopScanner(s).then(() => { try { s.clear(); } catch {} });
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black flex flex-col">
      <div
        className="flex items-center justify-between px-5 z-10"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top, 16px))', paddingBottom: 12 }}
      >
        <button
          onClick={onCancel}
          className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white active:text-white"
        >
          <X size={24} />
        </button>
        <span className="text-white text-base font-medium">
          {t('settings.lanShare.client.scanning') || '扫描二维码'}
        </span>
        <div className="w-10" />
      </div>

      <div className="flex-1 relative overflow-hidden">
        {(status === 'loading' || status === 'scanning') && (
          <div
            id={SCANNER_REGION_ID}
            style={{ width: '100%', height: '100%' }}
          />
        )}
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Camera size={48} className="text-white/30 animate-pulse" />
          </div>
        )}
        {status === 'scanning' && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-[220px] h-[220px] relative">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-[3px] border-l-[3px] border-white rounded-tl-lg" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-[3px] border-r-[3px] border-white rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-[3px] border-l-[3px] border-white rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-[3px] border-r-[3px] border-white rounded-br-lg" />
            </div>
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 px-8 text-center">
            <AlertCircle size={48} className="text-red-400" />
            <p className="text-white/80 text-sm">{errorMsg}</p>
          </div>
        )}
      </div>

      <div
        className="text-center text-white/50 text-sm z-10"
        style={{ paddingTop: 16, paddingBottom: 'max(32px, env(safe-area-inset-bottom, 32px))' }}
      >
        {t('settings.lanShare.client.scanTip') || '将桌面端二维码放入框内，即可自动扫描'}
      </div>
    </div>,
    document.body
  );
};

export default QrScannerModal;
