import React from 'react';
import { Clapperboard, CheckCircle2, AlertCircle, Loader2, Download, Pause, Play, X, RotateCcw, Trash2 } from 'lucide-react';
import { AppSettings } from '../../types';
import {
  getFfmpegStatus,
  isFfmpegAvailable,
  invalidateFfmpegAvailability,
  startFfmpegDownloadBridge,
  listenFfmpegDownloadProgress,
  ffmpegDownloadStart,
  ffmpegDownloadPause,
  ffmpegDownloadResume,
  ffmpegDownloadCancel,
  ffmpegDownloadCleanup,
  FfmpegStatus,
  FfmpegDownloadProgress,
} from '../../api/tauri-bridge/ffmpeg';
// 视频 P2：播放缓存（A 类容器 remux 产物）占用与清理
import {
  getVideoRemuxStats,
  clearVideoRemuxCache,
  RemuxStats,
} from '../../api/tauri-bridge/videoRemux';

/**
 * 视频设置面板（2026-10-16）。
 *
 * 指挥官反馈「视频相关功能全挤在常规下有点杂乱」→ 独立分类，三块在此：
 * ① 悬停预览视频（P1.5 配套）；② 视频封面引擎（P1.5-B：ffmpeg 三态 + 下载/重下）；
 * ③ 视频播放缓存（P2：remux 产物占用 + 清理）。
 * 三块均桌面专属（安卓端不显示：无悬停概念 / 不注册 ffmpeg_* 命令 / 无本地 remux）。
 */
interface VideoPanelProps {
  t: (key: string) => string;
  settings: AppSettings;
  isAndroid: boolean;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
}

/** 下载速度格式化（S4 进度行）：B/s → MB/s，<0.1 MB/s 时显示 KB/s */
const formatByteSpeed = (speed: number): string => {
  if (!speed || speed <= 0) return '--';
  if (speed >= 1024 * 1024) return `${(speed / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(speed / 1024))} KB/s`;
};

/** 字节数格式化：B / KB / MB（1 位小数），进度行「已下载 / 总大小」用 */
const formatBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const VideoPanel: React.FC<VideoPanelProps> = ({ t, settings, isAndroid, onUpdateSettingsData }) => {
  // 视频封面引擎状态（P1.5-B S1）：桌面端查询一次 ffmpeg 三态。
  // ffmpegStatus === null 仅在 invoke 失败（异常）时出现；正常未安装拿到 available:false。
  const [ffmpegStatus, setFfmpegStatus] = React.useState<FfmpegStatus | null>(null);
  const [ffmpegChecked, setFfmpegChecked] = React.useState(false);
  // S4：下载进度（事件驱动）；failed 时保留 error 展示，completed 时清空并刷新状态。
  const [dlProgress, setDlProgress] = React.useState<FfmpegDownloadProgress | null>(null);
  // 回退 latest 源的「来源未校验」告警（completed 事件携带，S5 再决定展示形态）
  const [dlWarning, setDlWarning] = React.useState<string | null>(null);
  const [startingDownload, setStartingDownload] = React.useState(false);
  const refreshFfmpegStatus = React.useCallback(() => {
    getFfmpegStatus().then((s) => {
      setFfmpegStatus(s);
      setFfmpegChecked(true);
    });
  }, []);
  React.useEffect(() => {
    if (isAndroid) return;
    // 全局进度桥（幂等）：面板开过一次后，面板关闭时左侧面板仍显示下载进度条
    startFfmpegDownloadBridge();
    refreshFfmpegStatus();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenFfmpegDownloadProgress((p) => {
      if (p.status === 'completed') {
        // 下载完成：失效可用性缓存（getVideoCover 分诊用），重新探测状态
        invalidateFfmpegAvailability();
        isFfmpegAvailable();
        setDlWarning(p.warning ?? null);
        setDlProgress(null);
        refreshFfmpegStatus();
      } else {
        setDlProgress(p);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isAndroid, refreshFfmpegStatus]);

  // 视频 P2：播放缓存（remux 产物）占用与清理
  const [remuxStats, setRemuxStats] = React.useState<RemuxStats | null>(null);
  const [clearingCache, setClearingCache] = React.useState(false);
  const refreshRemuxStats = React.useCallback(() => {
    getVideoRemuxStats().then((s) => setRemuxStats(s));
  }, []);
  React.useEffect(() => {
    if (isAndroid) return;
    refreshRemuxStats();
  }, [isAndroid, refreshRemuxStats]);

  const clearVideoCache = async () => {
    setClearingCache(true);
    try {
      const s = await clearVideoRemuxCache();
      setRemuxStats(s);
    } finally {
      setClearingCache(false);
    }
  };

  const startFfmpegDownload = async () => {
    setStartingDownload(true);
    setDlWarning(null);
    // 进度/失败经事件驱动（Rust 侧失败也 emit failed）；invoke 本身阻塞到任务结束
    try {
      await ffmpegDownloadStart();
    } catch {
      // 错误细节已在 failed 事件里（dlProgress.error）
    } finally {
      setStartingDownload(false);
      refreshFfmpegStatus();
    }
  };

  // S5：重新下载（两段式确认——第一次点进入确认态，3 秒内再点才执行清理）。
  // cleanup 删整个 ffmpeg 目录（含已装 exe，~268MB），误触代价高，故不做单击直删。
  const [confirmCleanup, setConfirmCleanup] = React.useState(false);
  React.useEffect(() => {
    if (!confirmCleanup) return;
    const timer = setTimeout(() => setConfirmCleanup(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmCleanup]);

  const doFfmpegCleanup = async () => {
    if (!confirmCleanup) {
      setConfirmCleanup(true);
      return;
    }
    setConfirmCleanup(false);
    try {
      await ffmpegDownloadCleanup();
    } catch {
      // 目录不存在等情况静默（状态刷新自然恢复）
    }
    invalidateFfmpegAvailability();
    isFfmpegAvailable();
    refreshFfmpegStatus();
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center">
          <Clapperboard size={20} className="mr-2 text-blue-500" /> {t('settings.catVideo')}
        </h3>
        <div className="space-y-6">
          {/* 视频悬停预览（P1.5 配套）。安卓端无鼠标悬停概念，不显示这一项。 */}
          {!isAndroid && (
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.hoverPlayVideos')}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.hoverPlayVideosDesc')}</div>
              </div>
              <button
                onClick={() => {
                  onUpdateSettingsData({ hoverPlayVideos: !settings.hoverPlayVideos });
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.hoverPlayVideos ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.hoverPlayVideos ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          )}

          {/* FFmpeg 组件（P1.5-B S1 三态 + S4 下载入口）。
              定位是通用媒体组件（不止视频封面），安卓端不注册 ffmpeg_* 命令，不显示。 */}
          {!isAndroid && (
            <div className="pt-3 border-subtle">
              <div className="flex items-center justify-between">
                <div className="min-w-0 pr-4">
                  <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.ffmpegComponent')}</div>
                  <div
                    className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate"
                    title={
                      ffmpegStatus?.available
                        ? [ffmpegStatus.version, ffmpegStatus.path].filter(Boolean).join('\n')
                        : (dlProgress?.error ?? dlWarning ?? undefined)
                    }
                  >
                    {dlProgress && dlProgress.status !== 'failed'
                      ? dlProgress.status === 'downloading'
                        ? `${t('settings.ffmpegDownloading')} ${dlProgress.progress}% · ${formatBytes(dlProgress.downloaded)} / ${formatBytes(dlProgress.total)} · ${formatByteSpeed(dlProgress.speed)}`
                        : dlProgress.status === 'paused'
                          ? `${t('settings.ffmpegPaused')} ${dlProgress.progress}% · ${formatBytes(dlProgress.downloaded)} / ${formatBytes(dlProgress.total)}`
                          : dlProgress.status === 'verifying'
                            ? t('settings.ffmpegVerifying')
                            : t('settings.ffmpegExtracting')
                      : dlProgress?.status === 'failed'
                        ? `${t('settings.ffmpegFailed')}: ${dlProgress.error ?? ''}`
                        : !ffmpegChecked || ffmpegStatus === null
                          ? t('settings.ffmpegUnknown')
                          : ffmpegStatus.available
                            ? `${t('settings.ffmpegReady')} · ${ffmpegStatus.version ?? ''}`
                            : t('settings.ffmpegMissing')}
                  </div>
                  {/* S5：来源未校验警示（latest 回退）。两个来源：本次会话的 completed
                      事件（dlWarning）/ 持久化的 install-info.json（installSource，
                      重启后仍在）。下载进行中不显示（进度态有其他展示）。 */}
                  {(ffmpegStatus?.installSource === 'latest' || (!!dlWarning && !!ffmpegStatus?.available)) && !dlProgress && (
                    <div className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-start">
                      <AlertCircle size={12} className="mr-1 mt-0.5 flex-shrink-0" />
                      <span>{t('settings.ffmpegUnverifiedSource')}</span>
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0 flex items-center gap-1.5">
                  {!ffmpegChecked || ffmpegStatus === null ? (
                    <Loader2 size={18} className="animate-spin text-gray-400" />
                  ) : ffmpegStatus.available ? (
                    ffmpegStatus.installSource === 'latest'
                      ? <AlertCircle size={18} className="text-amber-500" />
                      : ffmpegStatus.source === 'downloaded'
                        ? <CheckCircle2 size={18} className="text-green-500" />
                        : <Clapperboard size={18} className="text-blue-500" />
                  ) : (
                    <AlertCircle size={18} className="text-amber-500" />
                  )}
                  {/* 未安装（且不在下载中）→ 下载按钮（S4） */}
                  {ffmpegChecked && ffmpegStatus && !ffmpegStatus.available && !dlProgress && (
                    <button
                      onClick={startFfmpegDownload}
                      disabled={startingDownload}
                      className="px-2.5 py-1.5 rounded border border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-xs font-bold flex items-center disabled:opacity-50"
                    >
                      {startingDownload ? <Loader2 size={12} className="animate-spin mr-1" /> : <Download size={12} className="mr-1" />}
                      {t('settings.ffmpegDownload')}
                    </button>
                  )}
                  {/* 已安装 → 重新下载入口（S5，两段式确认） */}
                  {ffmpegChecked && ffmpegStatus?.available && !dlProgress && (
                    <button
                      onClick={doFfmpegCleanup}
                      className={`px-2 py-1 rounded border text-xs flex items-center transition-colors ${
                        confirmCleanup
                          ? 'border-red-500 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 font-bold'
                          : 'border-subtle text-gray-500 dark:text-gray-400 hover:bg-surface'
                      }`}
                      title={confirmCleanup ? t('settings.ffmpegConfirmCleanup') : t('settings.ffmpegRedownloadTip')}
                    >
                      <RotateCcw size={11} className="mr-1" />
                      {confirmCleanup ? t('settings.ffmpegConfirmCleanup') : t('settings.ffmpegRedownload')}
                    </button>
                  )}
                </div>
              </div>

              {/* 下载进度条 + 控制（S4） */}
              {dlProgress && dlProgress.status !== 'failed' && (
                <div className="mt-2">
                  <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${dlProgress.status === 'paused' ? 'bg-amber-500' : 'bg-blue-500'}`}
                      style={{ width: `${Math.max(dlProgress.progress, 2)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-end gap-1.5 mt-1.5">
                    {(dlProgress.status === 'downloading' || dlProgress.status === 'paused') && (
                      <>
                        {dlProgress.status === 'downloading' ? (
                          <button
                            onClick={() => { ffmpegDownloadPause().catch(() => {}); }}
                            className="px-2 py-1 rounded border border-subtle text-xs text-gray-600 dark:text-gray-300 hover:bg-surface flex items-center"
                          >
                            <Pause size={11} className="mr-1" />{t('settings.ffmpegPause')}
                          </button>
                        ) : (
                          <button
                            onClick={() => { ffmpegDownloadResume().catch(() => {}); }}
                            className="px-2 py-1 rounded border border-subtle text-xs text-gray-600 dark:text-gray-300 hover:bg-surface flex items-center"
                          >
                            <Play size={11} className="mr-1" />{t('settings.ffmpegResume')}
                          </button>
                        )}
                        <button
                          onClick={() => { ffmpegDownloadCancel().catch(() => {}); }}
                          className="px-2 py-1 rounded border border-subtle text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center"
                        >
                          <X size={11} className="mr-1" />{t('settings.ffmpegCancel')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 视频播放缓存（P2，2026-10-15）：mkv/avi 等 A 类容器的 remux 产物。
              产物与原视频等大，靠 LRU 上限（后端 4GB）自动淘汰，这里给一个手动出口。 */}
          {!isAndroid && (
            <div className="pt-3 border-subtle">
              <div className="flex items-center justify-between">
                <div className="min-w-0 pr-4">
                  <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.videoPlaybackCache')}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {remuxStats === null
                      ? t('settings.videoCacheUnknown')
                      : `${t('settings.videoCacheUsage')} ${formatBytes(remuxStats.bytes)} · ${remuxStats.files} ${t('settings.videoCacheFiles')} · ${t('settings.videoCacheLimit')} ${formatBytes(remuxStats.limit_bytes)}`}
                  </div>
                </div>
                <button
                  onClick={clearVideoCache}
                  disabled={clearingCache || remuxStats === null}
                  className="px-2.5 py-1.5 rounded border border-subtle text-xs text-gray-600 dark:text-gray-300 hover:bg-surface flex items-center disabled:opacity-50"
                  title={t('settings.videoCacheClearTip')}
                >
                  {clearingCache ? <Loader2 size={12} className="animate-spin mr-1" /> : <Trash2 size={12} className="mr-1" />}
                  {t('settings.videoCacheClear')}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default VideoPanel;
