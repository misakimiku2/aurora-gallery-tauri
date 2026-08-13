import { Loader2 } from 'lucide-react';

export interface LanDownloadProgress {
  active: boolean;
  completed: number;
  total: number;
}

interface LanDownloadOverlayProps {
  progress: LanDownloadProgress;
  t: (key: string) => string;
}

// LAN 桌面图片批量下载时的全屏进度遮罩
export const LanDownloadOverlay = ({ progress, t }: LanDownloadOverlayProps) => {
  if (!progress.active) return null;
  return (
    <div className="fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm flex items-center justify-center pointer-events-auto">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl px-8 py-6 flex flex-col items-center min-w-[220px]">
        <Loader2 size={28} className="text-blue-500 animate-spin mb-3" />
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
          {t('lanClient.downloading') || '正在下载桌面图片'}
        </div>
        <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-200"
            style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
          />
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
          {progress.completed} / {progress.total}
        </div>
      </div>
    </div>
  );
};
