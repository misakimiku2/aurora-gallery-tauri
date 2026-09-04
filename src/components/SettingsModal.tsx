import React, { useState, useEffect, useRef } from 'react';
import { Settings, Sliders, Database, Brain, BarChart2, Trash2, Info, Sparkles, Wifi } from 'lucide-react';
import { AppState, AppSettings, UpdateInfo, DownloadProgress } from '../types';
import { isAndroidPlatform } from '../utils/androidPlatform';
import { useAutoScrollbar } from '../hooks/useAutoScrollbar';
import { deleteFile, getGlobalCacheRoot } from '../api/tauri-bridge';
import { LanSharePanel } from './settings/LanSharePanel';
import { ConfirmModal } from './modals/ConfirmModal';
import AboutPanel from './settings/AboutPanel';
import AIVisionPanel from './settings/AIVisionPanel';
import PerformancePanel from './settings/PerformancePanel';
import GeneralPanel from './settings/GeneralPanel';
import StoragePanel from './settings/StoragePanel';
import AISettingsPanel from './settings/AISettingsPanel';

interface SettingsModalProps {
  state: AppState;
  onClose: () => void;
  onUpdateSettings: (updates: Partial<AppState>) => void;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
  onUpdatePath: (type: 'resource') => void;
  t: (key: string) => string;
  onUpdateAIConnectionStatus: (status: 'checking' | 'connected' | 'disconnected') => void;
  onClipEnabledChange?: (enabled: boolean) => void;
  clipLoading?: boolean;
  updateInfo?: UpdateInfo | null;
  onCheckUpdate?: () => void;
  isCheckingUpdate?: boolean;
  downloadProgress?: DownloadProgress | null;
  onInstallUpdate?: () => void;
  onOpenDownloadFolder?: () => void;
  onShowToast?: (msg: string, duration?: number) => void;
  onClipSearchDisabled?: () => void;
  onRefresh?: () => void;
  onNavigateToFile?: (filePath: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ state, onClose, onUpdateSettings, onUpdateSettingsData, onUpdatePath, onUpdateAIConnectionStatus, onClipEnabledChange, clipLoading, t, updateInfo, onCheckUpdate, isCheckingUpdate, downloadProgress, onInstallUpdate, onOpenDownloadFolder, onShowToast, onClipSearchDisabled, onRefresh, onNavigateToFile }) => {
  const [isAndroid, setIsAndroid] = useState(false);
  // 设置面板滚动条：滚动中显示、停止滚动后淡出，悬停滚动条区域时显示并放大（样式见 index.css）
  const settingsScrollRef = useRef<HTMLDivElement | null>(null);
  useAutoScrollbar(settingsScrollRef);
  // 清空日志确认弹窗
  const [showClearLogsConfirm, setShowClearLogsConfirm] = useState(false);

  useEffect(() => {
    isAndroidPlatform().then(setIsAndroid);
  }, []);


    return (
    /* 半透明 + 毛玻璃遮罩。底层在 App 打开设置时会显示「打开瞬间的主界面静态截图」
       （z-295，原实时网格已 content-visibility:hidden），因此这里 blur 到的是静态画面，
       观感与原始实时毛玻璃一致，且无实时合成开销。截图不可用（非 Windows/失败）时
       App 会回退为实时网格，本遮罩同样适用。 */
    <div className="fixed inset-0 z-[300] bg-black/50 flex items-center justify-center p-8 backdrop-blur-sm">
      <div className="bg-content rounded-xl w-[900px] h-[calc(100vh-200px)] min-h-[400px] shadow-2xl flex overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>

        <div className="w-64 bg-panel flex flex-col">
          {/* ... (Sidebar buttons, same as before) ... */}
          <div className="p-6">
            <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center">
              <Settings size={24} className="mr-2 text-blue-500" /> {t('settings.title')}
            </h2>
          </div>
          <div className="flex-1 px-4 space-y-1">
            <button
              onClick={() => onUpdateSettings({ settingsCategory: 'general' })}
              className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'general' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
              style={isAndroid ? { height: '55px', fontWeight: 700 } : undefined}
            >
              <Sliders size={18} className="mr-3" /> {t('settings.catGeneral')}
            </button>
            <button
              onClick={() => onUpdateSettings({ settingsCategory: 'storage' })}
              className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'storage' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
              style={isAndroid ? { height: '55px', fontWeight: 700 } : undefined}
            >
              <Database size={18} className="mr-3" /> {t('settings.catStorage')}
            </button>
            <button
              onClick={() => onUpdateSettings({ settingsCategory: 'ai' })}
              className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'ai' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
              style={isAndroid ? { height: '55px', fontWeight: 700 } : undefined}
            >
              <Brain size={18} className="mr-3" /> {t('settings.catAi')}
            </button>
            {!isAndroid && (
              <button
                onClick={() => onUpdateSettings({ settingsCategory: 'aiVision' })}
                className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'aiVision' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
              >
                <Sparkles size={18} className="mr-3" /> AI视觉
              </button>
            )}
            {!isAndroid && (
            <button
              onClick={() => onUpdateSettings({ settingsCategory: 'performance' })}
              className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'performance' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
            >
              <BarChart2 size={18} className="mr-3" /> {t('settings.catPerformance')}
            </button>
            )}
            <button
              onClick={() => onUpdateSettings({ settingsCategory: 'lanShare' })}
              className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'lanShare' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
              style={isAndroid ? { height: '55px', fontWeight: 700 } : undefined}
            >
              <Wifi size={18} className="mr-3" /> {t('settings.catLanShare') || '局域网共享'}
            </button>
            <button
              onClick={() => onUpdateSettings({ settingsCategory: 'about' })}
              className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'about' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-surface'}`}
              style={isAndroid ? { height: '55px', fontWeight: 700 } : undefined}
            >
              <Info size={18} className="mr-3" /> {t('settings.catAbout')}
            </button>
          </div>
          <div className="p-4">
            <button
              onClick={onClose}
              className="w-full py-2 bg-surface hover:bg-surface/70 rounded-lg text-sm text-gray-800 dark:text-gray-200 transition-colors"
            >
              {t('viewer.done')}
            </button>
          </div>
        </div>

        <div id="settings-scroll" ref={settingsScrollRef} className={`flex-1 overflow-y-auto p-8 ${isAndroid ? '' : 'custom-scrollbar'}`} style={isAndroid ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}>
          {isAndroid && <style dangerouslySetInnerHTML={{ __html: '#settings-scroll::-webkit-scrollbar{display:none;width:0!important;height:0!important}' }} />}
          {state.settingsCategory === 'general' && (
            <GeneralPanel
              t={t}
              settings={state.settings}
              isAndroid={isAndroid}
              onUpdateSettingsData={onUpdateSettingsData}
            />
          )}

          {state.settingsCategory === 'storage' && (
            <StoragePanel
              t={t}
              state={state}
              settings={state.settings}
              isAndroid={isAndroid}
              onUpdateSettings={onUpdateSettings}
              onUpdatePath={onUpdatePath}
              onClose={onClose}
              onShowToast={onShowToast}
              onRefresh={onRefresh}
              onNavigateToFile={onNavigateToFile}
            />
          )}
          {state.settingsCategory === 'ai' && (
            <AISettingsPanel
              t={t}
              ai={state.settings.ai}
              connectionStatus={state.aiConnectionStatus}
              isAndroid={isAndroid}
              onUpdateSettingsData={onUpdateSettingsData}
              onUpdateAIConnectionStatus={onUpdateAIConnectionStatus}
            />
          )}
          {!isAndroid && state.settingsCategory === 'aiVision' && (
            <AIVisionPanel
              t={t}
              settings={state.settings.clip}
              onUpdateSettings={(clipSettings) => onUpdateSettingsData({ clip: clipSettings })}
              onShowToast={onShowToast}
              onEnabledChange={onClipEnabledChange}
              onClipSearchDisabled={onClipSearchDisabled}
              clipLoading={clipLoading}
              onRefresh={onRefresh}
              language={state.settings.language}
            />
          )}

          {state.settingsCategory === 'performance' && (
            <PerformancePanel
              t={t}
              performance={state.settings.performance}
              onUpdateSettingsData={onUpdateSettingsData}
              onShowToast={onShowToast}
              isAndroid={isAndroid}
              onOpenClearLogsConfirm={() => setShowClearLogsConfirm(true)}
            />
          )}

          {state.settingsCategory === 'lanShare' && (
            <LanSharePanel
              t={t}
              settings={state.settings.lanShare || {
                enabled: false,
                port: 8080,
                accessCode: '',
                allowEdit: false,
                allowUpload: false,
              }}
              onUpdateSettings={(lanShareSettings) => {
                onUpdateSettingsData({ lanShare: lanShareSettings });
              }}
              rootPath={state.settings.paths.resourceRoot}
            />
          )}

          {state.settingsCategory === 'about' && (
            <AboutPanel
              t={t}
              onCheckUpdate={onCheckUpdate || (() => { })}
              updateInfo={updateInfo || null}
              isChecking={isCheckingUpdate || false}
              downloadProgress={downloadProgress}
              onInstallUpdate={onInstallUpdate}
              onOpenDownloadFolder={onOpenDownloadFolder}
            />
          )}
        </div>
      </div>

      {/* 清空日志确认弹窗 */}
      {showClearLogsConfirm && (
        <div className="fixed inset-0 z-[300] bg-black/50 flex items-center justify-center p-4">
          <ConfirmModal
            title={t('settings.performance.clearLogs')}
            message={t('settings.performance.clearLogsConfirm')}
            confirmText={t('settings.performance.clearLogs')}
            confirmIcon={Trash2}
            onClose={() => setShowClearLogsConfirm(false)}
            onConfirm={() => {
              setShowClearLogsConfirm(false);
              const cacheRoot = getGlobalCacheRoot();
              if (!cacheRoot) {
                onShowToast?.(t('settings.performance.clearLogsEmpty'));
                return;
              }
              const norm = cacheRoot.replace(/[\\/]+$/, '');
              const sep = norm.includes('\\') ? '\\' : '/';
              const parent = norm.lastIndexOf(sep) > 0 ? norm.slice(0, norm.lastIndexOf(sep)) : norm;
              const logDir = `${parent}${sep}scroll-perf`;
              deleteFile(logDir)
                .then(() => onShowToast?.(t('settings.performance.clearLogsSuccess')))
                .catch(() => onShowToast?.(t('settings.performance.clearLogsEmpty')));
            }}
            t={t}
          />
        </div>
      )}
    </div>
  );
};
