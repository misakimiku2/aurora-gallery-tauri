import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Smartphone, Copy, Check, AlertCircle } from 'lucide-react';
import { ANDROID_DOWNLOAD_PAGE_URL, qrImageUrl, resolveAndroidDownloadUrl } from '../../utils/androidDownload';

interface AndroidDownloadCardProps {
  t: (key: string) => string;
}

/**
 * 「获取安卓端」下载卡：局域网共享**未开启**时显示在面板里，给一条完整的扫码下载链路。
 * 开启后不再显示——那时面板中央已经是「扫码连接」二维码，两个码并排会互相抢注意力。
 *
 * 二维码目标与欢迎向导同源（见 utils/androidDownload）：优先当前版本 APK 直链，
 * 取不到回退发行页。外链图片加载不出来时不把用户堵死：地址行常驻且可复制。
 */
export const AndroidDownloadCard: React.FC<AndroidDownloadCardProps> = ({ t }) => {
  const [downloadUrl, setDownloadUrl] = useState(ANDROID_DOWNLOAD_PAGE_URL);
  const [loading, setLoading] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveAndroidDownloadUrl().then(url => {
      if (!cancelled) setDownloadUrl(url);
    });
    return () => { cancelled = true; };
  }, []);

  // 地址变化（发行页 → APK 直链）时 img 按 key 重挂载，转圈重新计时
  useEffect(() => {
    setLoading(true);
    setImageFailed(false);
  }, [downloadUrl]);

  const qrRef = useRef<HTMLImageElement>(null);

  /**
   * 命中图片缓存时 <img> 可能在 React 挂上 onLoad **之前**就已 complete（二次进入面板、
   * 热更新重挂载必现），只靠 onLoad 会让转圈永远收不起来——挂载后主动核对一次。
   */
  useEffect(() => {
    const img = qrRef.current;
    if (!img?.complete) return;
    if (img.naturalWidth === 0) setImageFailed(true);
    setLoading(false);
  }, [downloadUrl]);

  const handleCopy = () => {
    // Promise.resolve 兜住非 Promise 的 clipboard 实现（测试桩/老旧 WebView），不让异常打断点击
    void Promise.resolve(navigator.clipboard?.writeText(downloadUrl)).catch(() => { /* 剪贴板不可用不阻断 */ });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div data-testid="lan-android-download" className="bg-surface rounded-xl p-6 border border-subtle">
      <div className="flex items-center gap-5">
        <div className="relative shrink-0">
          {/* 清单直链与外链二维码都要等，加载期间用白底转圈占位，避免闪空白方块 */}
          {loading && (
            <div
              data-testid="lan-android-qr-loading"
              className="absolute inset-0 rounded-xl bg-white flex items-center justify-center z-10"
            >
              <Loader2 size={26} className="animate-spin text-blue-500" />
            </div>
          )}
          <img
            key={downloadUrl}
            ref={qrRef}
            data-testid="lan-android-qr"
            src={qrImageUrl(downloadUrl)}
            alt="Android APK download QR"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setImageFailed(true); }}
            /* 白底 + 内边距是二维码静区的一部分，勿收窄；圆角与卡片一致 */
            className="w-40 h-40 rounded-xl bg-white p-2.5 block shadow-sm ring-1 ring-gray-900/5 dark:ring-white/10"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-cyan-100 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400 flex items-center justify-center shrink-0">
              <Smartphone size={16} />
            </span>
            <h4 className="text-sm font-bold text-gray-800 dark:text-white">
              {t('settings.lanShare.androidDownload.title')}
            </h4>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mt-2.5">
            {t('settings.lanShare.androidDownload.hint')}
          </p>
        </div>
      </div>

      {/* 地址行独占一行：APK 直链比发行页长得多，挤在二维码旁边会被截成「https://gite…」 */}
      <div className="flex items-center gap-2 mt-5">
        <div
          className="flex-1 min-w-0 bg-panel rounded-lg px-3 py-2 text-xs font-mono text-gray-600 dark:text-gray-400 truncate"
          title={downloadUrl}
        >
          {downloadUrl}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
        >
          {copied ? (
            <>
              <Check size={13} />
              {t('settings.lanShare.copied')}
            </>
          ) : (
            <>
              <Copy size={13} />
              {t('settings.lanShare.copy')}
            </>
          )}
        </button>
      </div>

      {imageFailed && (
        <div className="flex items-start gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <p>{t('settings.lanShare.androidDownload.qrFailed')}</p>
        </div>
      )}
    </div>
  );
};

export default AndroidDownloadCard;
