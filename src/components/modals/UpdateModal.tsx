import React from 'react';
import { 
  Download, 
  X, 
  BellOff, 
  ExternalLink, 
  Sparkles, 
  Pause, 
  Play, 
  FolderOpen,
  RotateCcw,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { UpdateInfo, DownloadProgress, DownloadState } from '../../types';

interface UpdateModalProps {
  isOpen: boolean;
  updateInfo: UpdateInfo | null;
  downloadProgress: DownloadProgress | null;
  onClose: () => void;
  onStartDownload: () => void;
  onPauseDownload: () => void;
  onResumeDownload: () => void;
  onCancelDownload: () => void;
  onInstall: () => void;
  onOpenFolder: () => void;
  onIgnore: () => void;
  t: (key: string) => string;
}

const formatDate = (dateString: string, t: (key: string) => string): string => {
  if (!dateString || dateString.trim() === '') {
    return t('settings.about.dateUnknown');
  }
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return t('settings.about.dateUnknown');
    }
    return date.toLocaleDateString(t('locale') || 'zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return t('settings.about.dateUnknown');
  }
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec === 0) return '0 KB/s';
  return formatFileSize(bytesPerSec) + '/s';
};

const formatReleaseNotes = (notes: string, t: (key: string) => string): string => {
  if (!notes) return t('settings.about.noReleaseNotes');
  
  // 简单的 Markdown 格式转换
  return notes
    .replace(/#{1,6}\s+/g, '') // 移除标题标记
    .replace(/\*\*/g, '') // 移除粗体标记
    .replace(/\*/g, '•') // 将星号转换为圆点
    .trim();
};

export const UpdateModal: React.FC<UpdateModalProps> = ({
  isOpen,
  updateInfo,
  downloadProgress,
  onClose,
  onStartDownload,
  onPauseDownload,
  onResumeDownload,
  onCancelDownload,
  onInstall,
  onOpenFolder,
  onIgnore,
  t,
}) => {
  if (!isOpen || !updateInfo) return null;

  const downloadState: DownloadState = downloadProgress?.state || 'idle';
  const isDownloading = downloadState === 'downloading';
  const isPreparing = downloadState === 'preparing';
  const isPaused = downloadState === 'paused';
  const isCompleted = downloadState === 'completed';
  const isError = downloadState === 'error';
  const hasDownloadProgress = downloadProgress !== null && downloadState !== 'idle';

  // 渲染下载进度条
  const renderProgressBar = () => {
    if (!hasDownloadProgress) return null;

    const progress = downloadProgress?.progress || 0;
    const downloaded = downloadProgress?.downloadedBytes || 0;
    const total = downloadProgress?.totalBytes || 0;
    const speed = downloadProgress?.speedBytesPerSec || 0;

    return (
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-600 dark:text-white/60">
            {isCompleted
              ? t('settings.about.downloadComplete')
              : isPreparing
                ? t('settings.about.preparing')
                : isPaused
                  ? t('settings.about.paused')
                  : isError
                    ? t('settings.about.downloadFailed')
                    : t('settings.about.downloading')}
          </span>
          {!isPreparing && (
            <span className="text-sm font-medium text-gray-800 dark:text-white/80">
              {progress.toFixed(1)}%
            </span>
          )}
        </div>

        {/* 进度条 */}
        <div className="h-2 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden mb-2 relative">
          {isPreparing ? (
            // 准备状态：长条向右发射动画
            <div className="absolute inset-0 overflow-hidden">
              <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-[shimmer_1.5s_infinite]" />
            </div>
          ) : (
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isError
                  ? 'bg-red-500'
                  : isCompleted
                    ? 'bg-green-500'
                    : 'bg-blue-500'
              }`}
              style={{ width: `${isCompleted ? 100 : progress}%` }}
            />
          )}
        </div>

        {/* 下载信息 */}
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-white/50">
          {!isPreparing && (
            <span>
              {formatFileSize(downloaded)} / {formatFileSize(total)}
            </span>
          )}
          {isPreparing && (
            <span>{formatFileSize(total)}</span>
          )}
          {!isCompleted && !isPaused && !isError && !isPreparing && speed > 0 && (
            <span>{formatSpeed(speed)}</span>
          )}
        </div>

        {/* 错误信息 */}
        {isError && downloadProgress?.errorMessage && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-red-500/10 rounded-lg text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{downloadProgress.errorMessage}</span>
          </div>
        )}
      </div>
    );
  };

  // 渲染操作按钮
  const renderActionButtons = () => {
    // 下载完成状态
    if (isCompleted) {
      return (
        <div className="flex flex-col gap-3">
          <button
            onClick={onInstall}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-green-500 hover:bg-green-600 active:bg-green-700 text-white rounded-xl font-medium transition-all duration-200 shadow-lg shadow-green-500/20"
          >
            <CheckCircle2 size={18} />
            <span>{t('settings.about.installNow')}</span>
          </button>
          
          <div className="flex gap-3">
            <button
              onClick={onOpenFolder}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl text-sm font-medium transition-colors"
            >
              <FolderOpen size={16} />
              <span>{t('settings.about.openFolder')}</span>
            </button>
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl text-sm font-medium transition-colors"
            >
              {t('settings.about.installLater')}
            </button>
          </div>
        </div>
      );
    }

    // 下载中或暂停状态
    if (isDownloading || isPaused) {
      return (
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <button
              onClick={isPaused ? onResumeDownload : onPauseDownload}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white rounded-xl font-medium transition-all duration-200"
            >
              {isPaused ? <Play size={18} /> : <Pause size={18} />}
              <span>{isPaused ? t('settings.about.resume') : t('settings.about.pause')}</span>
            </button>
            <button
              onClick={onCancelDownload}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl font-medium transition-colors"
            >
              <X size={18} />
              <span>{t('settings.about.cancel')}</span>
            </button>
          </div>
        </div>
      );
    }

    // 错误状态
    if (isError) {
      return (
        <div className="flex flex-col gap-3">
          <button
            onClick={onStartDownload}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white rounded-xl font-medium transition-all duration-200 shadow-lg shadow-blue-500/20"
          >
            <RotateCcw size={18} />
            <span>{t('settings.about.retry')}</span>
          </button>
          
          <div className="flex gap-3">
            <button
              onClick={() => window.open(updateInfo.downloadUrl, '_blank')}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl text-sm font-medium transition-colors"
            >
              <ExternalLink size={14} />
              <span>{t('settings.about.goToBrowser')}</span>
            </button>
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl text-sm font-medium transition-colors"
            >
              {t('settings.about.remindLater')}
            </button>
          </div>
        </div>
      );
    }

    // 默认状态（未开始下载）
    return (
      <div className="flex flex-col gap-3">
        <button
          onClick={onStartDownload}
          disabled={isPreparing}
          className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all duration-200 shadow-lg ${
            isPreparing
              ? 'bg-blue-400 cursor-not-allowed text-white/80 shadow-blue-400/20'
              : 'bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white shadow-blue-500/20'
          }`}
        >
          {isPreparing ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>{t('settings.about.preparing')}</span>
            </>
          ) : (
            <>
              <Download size={18} />
              <span>{updateInfo.installerUrl ? t('settings.about.download') : t('settings.about.goToBrowser')}</span>
              {!updateInfo.installerUrl && <ExternalLink size={14} className="opacity-70" />}
            </>
          )}
        </button>
        
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-white/80 rounded-xl text-sm font-medium transition-colors"
          >
            {t('settings.about.remindLater')}
          </button>
          <button
            onClick={onIgnore}
            className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-gray-400 hover:text-gray-600 dark:text-white/50 dark:hover:text-white/70 hover:bg-gray-100 dark:hover:bg-white/5 rounded-xl text-sm transition-colors"
            title={t('settings.about.ignoreVersion')}
          >
            <BellOff size={14} />
            <span>{t('settings.about.ignoreVersion')}</span>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-lg mx-4 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden animate-zoom-in">
        {/* 顶部装饰条 */}
        <div className="h-1.5 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />
        
        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <X size={18} />
        </button>

        {/* 内容区域 */}
        <div className="p-6">
          {/* 标题区域 */}
          <div className="flex items-start gap-4 mb-6">
            <div className="flex-shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center border border-blue-200 dark:border-white/10">
              <Sparkles className="w-7 h-7 text-blue-500 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-1">
                {isCompleted ? t('settings.about.downloadComplete') : t('settings.about.newVersionAvailable').replace('{version}', updateInfo.latestVersion)}
              </h2>
              <p className="text-gray-500 dark:text-white/50 text-sm">
                Aurora Gallery {updateInfo.latestVersion} {t('app.available')}
              </p>
            </div>
          </div>

          {/* 版本信息 */}
          <div className="bg-gray-50 dark:bg-white/5 rounded-xl p-4 mb-5 border border-gray-100 dark:border-white/5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-500 dark:text-white/60 text-sm">{t('settings.about.currentVersion')}</span>
              <span className="text-gray-700 dark:text-white/80 text-sm font-mono">{updateInfo.currentVersion}</span>
            </div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-500 dark:text-white/60 text-sm">{t('settings.about.newVersion')}</span>
              <span className="text-blue-500 dark:text-blue-400 text-sm font-mono font-medium">{updateInfo.latestVersion}</span>
            </div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-500 dark:text-white/60 text-sm">{t('settings.about.publishedAt')}</span>
              <span className="text-gray-700 dark:text-white/80 text-sm">{formatDate(updateInfo.publishedAt, t)}</span>
            </div>
            {updateInfo.releaseName && (
              <div className="pt-3 border-t border-gray-200 dark:border-white/10">
                <span className="text-gray-500 dark:text-white/60 text-sm block mb-1">{t('settings.about.releaseTitle')}</span>
                <span className="text-gray-800 dark:text-white font-medium text-sm">{updateInfo.releaseName}</span>
              </div>
            )}
            {updateInfo.installerSize && !hasDownloadProgress && (
              <div className="pt-3 border-t border-gray-200 dark:border-white/10">
                <span className="text-gray-500 dark:text-white/60 text-sm block mb-1">{t('settings.about.installerSize')}</span>
                <span className="text-gray-800 dark:text-white font-medium text-sm">{formatFileSize(updateInfo.installerSize)}</span>
              </div>
            )}
          </div>

          {/* 下载进度 */}
          {renderProgressBar()}

          {/* 更新说明 */}
          {updateInfo.releaseNotes && !hasDownloadProgress && (
            <div className="mb-6">
              <h3 className="text-gray-700 dark:text-white/80 text-sm font-medium mb-2">{t('settings.about.releaseNotes')}</h3>
              <div className="bg-gray-50 dark:bg-white/5 rounded-xl p-4 border border-gray-100 dark:border-white/5 max-h-40 overflow-y-auto">
                <pre className="text-gray-600 dark:text-white/70 text-sm whitespace-pre-wrap font-sans leading-relaxed">
                  {formatReleaseNotes(updateInfo.releaseNotes, t)}
                </pre>
              </div>
            </div>
          )}

          {/* 按钮区域 */}
          {renderActionButtons()}
        </div>
      </div>
    </div>
  );
};

export default UpdateModal;
