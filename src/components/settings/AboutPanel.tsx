import React, { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Info, Code2, Check, Download, FolderOpen, RefreshCw, ExternalLink, Github, Shield, Heart } from 'lucide-react';
import { UpdateInfo, DownloadProgress } from '../../types';
import { AuroraLogo } from '../Logo';
import { openExternalLink, getLogDir, openPath } from '../../api/tauri-bridge';

// 关于面板组件
interface AboutPanelProps {
  t: (key: string) => string;
  onCheckUpdate: () => void;
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  downloadProgress?: DownloadProgress | null;
  onInstallUpdate?: () => void;
  onOpenDownloadFolder?: () => void;
}

const AboutPanel: React.FC<AboutPanelProps> = ({ t, onCheckUpdate, updateInfo, isChecking, downloadProgress, onInstallUpdate, onOpenDownloadFolder }) => {
  const [appVersion, setAppVersion] = useState<string>('');
  const tauriVersion = '2.0';
  const reactVersion = '18.2.0';

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'));
  }, []);

  const handleOpenLink = (url: string) => {
    openExternalLink(url);
  };

  const handleOpenLogFolder = async () => {
    const logDir = await getLogDir();
    if (logDir) {
      openPath(logDir, true);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* 软件信息卡片 */}
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-subtle pb-2 flex items-center">
          <Info size={20} className="mr-2 text-blue-500" />
          {t('settings.catAbout')}
        </h3>

        <div className="bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-2xl p-8 border border-subtle">
          <div className="flex items-center gap-6">
            <AuroraLogo size={115} className="rounded-2xl" />
            <div>
              <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-1">Aurora Gallery</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mb-2">{t('settings.about.tagline')}</p>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 bg-blue-500/20 text-blue-400 text-xs font-medium rounded-full">
                  v{appVersion || '...'}
                </span>
                <span className="px-2.5 py-1 bg-green-500/20 text-green-600 dark:text-green-400 text-xs font-medium rounded-full">
                  {t('settings.about.stable')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 版本信息 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <Code2 size={16} className="mr-2" />
          {t('settings.about.versions')}
        </h4>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('settings.about.appVersion')}</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-white">{appVersion || '...'}</div>
          </div>
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Tauri</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-white">{tauriVersion}</div>
          </div>
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">React</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-white">{reactVersion}</div>
          </div>
        </div>
      </section>

      {/* 检查更新 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <RefreshCw size={16} className="mr-2" />
          {t('settings.about.update')}
        </h4>
        <div className="bg-surface rounded-xl p-6 border border-subtle">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white mb-1">
                {t('settings.about.currentVersion')}: {appVersion || '...'}
                {/* 下载完成时显示新版本号 */}
                {downloadProgress?.state === 'completed' && (
                  <span className="ml-2 text-green-500">
                    → {updateInfo?.latestVersion || t('settings.about.newVersion')}
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {downloadProgress?.state === 'completed'
                  ? t('settings.about.downloadComplete')
                  : updateInfo?.hasUpdate
                    ? t('settings.about.newVersionAvailable').replace('{version}', updateInfo.latestVersion)
                    : t('settings.about.upToDate')
                }
              </div>
            </div>
            {/* 下载完成时显示安装按钮，否则显示检查更新按钮 */}
            {downloadProgress?.state === 'completed' ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={onInstallUpdate}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  <Check size={16} />
                  {t('settings.about.installNow')}
                </button>
                <button
                  onClick={onOpenDownloadFolder}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-white/80 rounded-lg text-sm font-medium transition-colors"
                  title={t('settings.about.openFolder')}
                >
                  <FolderOpen size={16} />
                </button>
              </div>
            ) : (
              <button
                onClick={onCheckUpdate}
                disabled={isChecking}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <RefreshCw size={16} className={isChecking ? 'animate-spin' : ''} />
                {isChecking ? t('settings.about.checking') : t('settings.about.checkUpdate')}
              </button>
            )}
          </div>

          {/* 有更新但未下载完成时显示更新信息 */}
          {updateInfo?.hasUpdate && downloadProgress?.state !== 'completed' && (
            <div className="mt-4 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-blue-400 mb-1">
                    {t('settings.about.newVersion')}: {updateInfo.latestVersion}
                  </div>
                  {updateInfo?.publishedAt && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('settings.about.publishedAt')}: {new Date(updateInfo.publishedAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                {/* 根据下载状态显示不同按钮 */}
                {downloadProgress && downloadProgress.state !== 'idle' ? (
                  // 下载中/暂停/错误/准备中：显示查看下载进度按钮
                  <button
                    onClick={() => {
                      // 打开更新弹窗查看进度
                      window.dispatchEvent(new CustomEvent('open-update-modal'));
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors"
                  >
                    <Download size={14} />
                    {downloadProgress.state === 'downloading'
                      ? t('settings.about.downloading')
                      : downloadProgress.state === 'paused'
                        ? t('settings.about.paused')
                        : downloadProgress.state === 'error'
                          ? t('settings.about.downloadFailed')
                          : t('settings.about.preparing')}
                  </button>
                ) : (
                  // 未开始下载：显示下载按钮
                  <button
                    onClick={() => handleOpenLink(updateInfo.downloadUrl)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors"
                  >
                    <Download size={14} />
                    {t('settings.about.download')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 诊断 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <FolderOpen size={16} className="mr-2" />
          诊断
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleOpenLogFolder}
            className="flex items-center gap-3 p-4 bg-surface rounded-xl border border-subtle hover:border-blue-500/50 hover:bg-blue-500/5 transition-all text-left"
            title="打开应用日志文件夹，遇到问题时可将里面的日志文件发给开发者"
          >
            <FolderOpen size={20} className="text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white">打开日志文件夹</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">错误记录保存在这里</div>
            </div>
          </button>
        </div>
      </section>

      {/* 链接 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <ExternalLink size={16} className="mr-2" />
          {t('settings.about.links')}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => handleOpenLink('https://github.com/misakimiku2/aurora-gallery-tauri')}
            className="flex items-center gap-3 p-4 bg-surface rounded-xl border border-subtle hover:border-blue-500/50 hover:bg-blue-500/5 transition-all text-left"
          >
            <Github size={20} className="text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white">GitHub</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.about.viewSource')}</div>
            </div>
          </button>
          <button
            onClick={() => handleOpenLink('https://github.com/misakimiku2/aurora-gallery-tauri/issues')}
            className="flex items-center gap-3 p-4 bg-surface rounded-xl border border-subtle hover:border-blue-500/50 hover:bg-blue-500/5 transition-all text-left"
          >
            <Shield size={20} className="text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white">{t('settings.about.issues')}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.about.reportBug')}</div>
            </div>
          </button>
        </div>
      </section>

      {/* 致谢 */}
      <section>
        <div className="flex items-center justify-center gap-1 text-xs text-gray-500 dark:text-gray-400 pt-4 border-t border-subtle">
          <span>{t('settings.about.madeWith')}</span>
          <Heart size={12} className="text-red-500 fill-red-500" />
          <span>{t('settings.about.by')}</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">MISAKIMIKU</span>
        </div>
      </section>
    </div>
  );
};

export default AboutPanel;
