import React, { useState, useEffect, useRef } from 'react';
import { BarChart2, Database, MemoryStick, FileText, Timer, RefreshCw, FolderOpen, Trash2 } from 'lucide-react';
import { AppSettings } from '../../types';
import { performanceMonitor } from '../../utils/performanceMonitor';
import { setScrollProfilerEnabled, isScrollProfilerEnabled } from '../../utils/scrollProfiler';
import { getGlobalCacheRoot } from '../../api/tauri-bridge';

// 性能监控面板组件
interface PerformancePanelProps {
  t: (key: string) => string;
  performance: { refreshInterval: number; scrollProfiling?: boolean } | undefined;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
  onShowToast?: (msg: string, duration?: number) => void;
  isAndroid: boolean;
  onOpenClearLogsConfirm: () => void;
}

const PerformancePanel: React.FC<PerformancePanelProps> = ({ t, performance, onUpdateSettingsData, onShowToast, isAndroid, onOpenClearLogsConfirm }) => {
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 获取当前的刷新间隔（毫秒）
  const refreshInterval = performance?.refreshInterval || 5000;

  // 手动刷新性能数据
  const handleRefreshPerformance = () => {
    setRefreshKey(prev => prev + 1);
  };

  // 设置自动刷新定时器
  useEffect(() => {
    // 清除之前的定时器
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
    }

    // 创建新的定时器
    refreshTimerRef.current = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, refreshInterval);

    // 清理函数
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refreshInterval]);

  return (
    <div className="space-y-8 animate-fade-in">
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-6 border-subtle pb-2 flex items-center justify-between">
          <div className="flex items-center">
            <BarChart2 size={20} className="mr-2 text-blue-500" />
            {t('settings.catPerformance')}
          </div>
          <button
            onClick={handleRefreshPerformance}
            className="text-sm flex items-center px-3 py-1 bg-surface hover:bg-surface/70 rounded-full transition-colors text-gray-700 dark:text-gray-200"
          >
            <RefreshCw size={14} className="mr-1 animate-spin-on-hover" />
            {t('settings.performance.refreshNow')}
          </button>
        </h3>

        {/* 性能指标概览 */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          {/* 实时内存使用 */}
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('settings.performance.memoryUsage')}</span>
              </div>
              <div className="flex items-center text-sm">
                <MemoryStick size={14} className="mr-1 text-blue-500" />
                <span className="font-bold text-gray-800 dark:text-white">
                  {(() => {
                    // 使用当前内存值而非平均值
                    const currentMemory = performanceMonitor.getCurrentMemory();
                    return currentMemory ? `${Math.round(currentMemory)} MB` : 'N/A';
                  })()}
                </span>
              </div>
            </div>

            {/* 内存使用历史可视化 */}
            <div className="h-24 bg-black/10 dark:bg-white/10 rounded overflow-hidden relative">
              {(() => {
                // 获取内存历史并确保包含当前内存数据
                let memoryHistory = performanceMonitor.getMemoryHistory();
                const currentMemory = performanceMonitor.getCurrentMemory();

                // 如果没有历史数据但有当前内存数据，创建初始数据点
                if (memoryHistory.length === 0) {
                  if (currentMemory !== null) {
                    memoryHistory = [{ timestamp: Date.now(), memory: currentMemory }];
                  } else {
                    return <div className="flex items-center justify-center h-full text-sm text-gray-500 dark:text-gray-400">暂无历史数据</div>;
                  }
                } else if (currentMemory !== null) {
                  // 确保最新的数据点是当前内存数据
                  const lastPoint = memoryHistory[memoryHistory.length - 1];
                  const currentTime = Date.now();
                  // 如果最后一个数据点是旧的（超过1秒），添加当前内存数据
                  if (currentTime - lastPoint.timestamp > 1000) {
                    memoryHistory = [...memoryHistory, { timestamp: currentTime, memory: currentMemory }];
                  } else {
                    // 否则更新最后一个数据点
                    memoryHistory = [...memoryHistory.slice(0, -1), { timestamp: currentTime, memory: currentMemory }];
                  }
                }

                // 获取最大值和最小值，添加一些余量以确保曲线不会贴边
                const allMemoryValues = memoryHistory.map(item => item.memory);
                const maxMemory = Math.max(...allMemoryValues) * 1.1; // 增加10%的余量
                const minMemory = Math.max(0, Math.min(...allMemoryValues) * 0.9); // 减少10%的余量，最低为0
                const range = maxMemory - minMemory || 1;

                // 创建SVG路径
                let pathData = '';
                if (memoryHistory.length > 1) {
                  pathData = memoryHistory.map((item, index) => {
                    const x = (index / (memoryHistory.length - 1)) * 200;
                    const y = 100 - ((item.memory - minMemory) / range) * 100;
                    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
                  }).join(' ');
                } else if (memoryHistory.length === 1) {
                  // 只有一个数据点，绘制一个点
                  const y = 100 - ((memoryHistory[0].memory - minMemory) / range) * 100;
                  pathData = `M 100 ${y}`;
                }

                return (
                  <svg className="w-full h-full" viewBox="0 0 200 100" preserveAspectRatio="none">
                    {/* 背景网格 */}
                    <g opacity="0.2">
                      <line x1="0" y1="25" x2="200" y2="25" stroke="currentColor" strokeWidth="0.5" />
                      <line x1="0" y1="50" x2="200" y2="50" stroke="currentColor" strokeWidth="0.5" />
                      <line x1="0" y1="75" x2="200" y2="75" stroke="currentColor" strokeWidth="0.5" />
                    </g>

                    {/* 内存使用曲线 */}
                    {pathData && (
                      <path
                        d={pathData}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}

                    {/* 填充区域 */}
                    {pathData && memoryHistory.length > 1 && (
                      <path
                        d={`${pathData} L 200 100 L 0 100 Z`}
                        fill="#3b82f6"
                        opacity="0.2"
                      />
                    )}

                    {/* 当前值标记 */}
                    {memoryHistory.length > 0 && (
                      <circle
                        cx={memoryHistory.length > 1 ? 200 : 100}
                        cy={100 - ((memoryHistory[memoryHistory.length - 1].memory - minMemory) / range) * 100}
                        r="4"
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>
                );
              })()}
            </div>
          </div>

          {/* 缩略图缓存命中率 */}
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('settings.performance.cacheHitRate')}</span>
              </div>
              <div className="flex items-center text-sm">
                <Database size={14} className="mr-1 text-blue-500" />
                <span className="font-bold text-gray-800 dark:text-white">
                  {(() => {
                    const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                    const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                    const total = hitCount + missCount;
                    return total > 0 ? `${Math.round((hitCount / total) * 100)}%` : '0%';
                  })()}
                </span>
              </div>
            </div>

            {/* 缓存命中率可视化 */}
            <div className="h-10 bg-black/10 dark:bg-white/10 rounded overflow-hidden flex">
              {(() => {
                const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                const total = hitCount + missCount;
                const hitRate = total > 0 ? (hitCount / total) * 100 : 0;
                return (
                  <>
                    <div
                      className="h-full bg-green-500 transition-all duration-300 ease-out"
                      style={{ width: `${hitRate}%` }}
                    />
                    <div
                      className="h-full bg-red-500 transition-all duration-300 ease-out"
                      style={{ width: `${100 - hitRate}%` }}
                    />
                  </>
                );
              })()}
            </div>
          </div>
        </div>

        {/* 性能指标详细数据 */}
        <div className="space-y-6">
          {/* 缩略图加载性能 */}
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <h4 className="text-md font-semibold text-gray-800 dark:text-white mb-3 flex items-center">
              <FileText size={16} className="mr-2 text-blue-500" />
              {t('settings.performance.thumbnailLoading')}
            </h4>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.average')}</span>
                <span className="text-lg font-bold text-gray-800 dark:text-white">
                  {performanceMonitor.getAggregated('getThumbnail') ?
                    `${Math.round(performanceMonitor.getAggregated('getThumbnail')?.average || 0)} ms` :
                    '0 ms'}
                </span>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.min')}</span>
                <span className="text-lg font-bold text-gray-800 dark:text-white">
                  {performanceMonitor.getAggregated('getThumbnail') ?
                    `${Math.round(performanceMonitor.getAggregated('getThumbnail')?.min || 0)} ms` :
                    '0 ms'}
                </span>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.max')}</span>
                <span className="text-lg font-bold text-gray-800 dark:text-white">
                  {performanceMonitor.getAggregated('getThumbnail') ?
                    `${Math.round(performanceMonitor.getAggregated('getThumbnail')?.max || 0)} ms` :
                    '0 ms'}
                </span>
              </div>
            </div>

            {/* 缓存命中率 */}
            <div className="mt-4">
              <div className="flex justify-between items-center text-sm mb-1">
                <span className="text-gray-600 dark:text-gray-400">{t('settings.performance.cacheHitRate')}</span>
                <span className="font-medium text-gray-800 dark:text-white">
                  {(() => {
                    const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                    const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                    const total = hitCount + missCount;
                    return total > 0 ? `${Math.round((hitCount / total) * 100)}%` : '0%';
                  })()}
                </span>
              </div>
              <div className="h-2 bg-black/10 dark:bg-white/10 rounded overflow-hidden">
                {(() => {
                  const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                  const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                  const total = hitCount + missCount;
                  const hitRate = total > 0 ? (hitCount / total) * 100 : 0;
                  return (
                    <>
                      <div
                        className="h-full bg-green-500 transition-all duration-300 ease-out"
                        style={{ width: `${hitRate}%` }}
                      />
                      <div
                        className="h-full bg-red-500 transition-all duration-300 ease-out"
                        style={{ width: `${100 - hitRate}%` }}
                      />
                    </>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* 文件扫描性能 */}
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <h4 className="text-md font-semibold text-gray-800 dark:text-white mb-3 flex items-center">
              <Timer size={16} className="mr-2 text-blue-500" />
              {t('settings.performance.fileScanning')}
            </h4>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.average')}</span>
                <span className="text-lg font-bold text-gray-800 dark:text-white">
                  {performanceMonitor.getAggregated('scanDirectory') ?
                    `${Math.round(performanceMonitor.getAggregated('scanDirectory')?.average || 0)} ms` :
                    '0 ms'}
                </span>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.min')}</span>
                <span className="text-lg font-bold text-gray-800 dark:text-white">
                  {performanceMonitor.getAggregated('scanDirectory') ?
                    `${Math.round(performanceMonitor.getAggregated('scanDirectory')?.min || 0)} ms` :
                    '0 ms'}
                </span>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.max')}</span>
                <span className="text-lg font-bold text-gray-800 dark:text-white">
                  {performanceMonitor.getAggregated('scanDirectory') ?
                    `${Math.round(performanceMonitor.getAggregated('scanDirectory')?.max || 0)} ms` :
                    '0 ms'}
                </span>
              </div>
            </div>

            {/* 扫描文件总数 */}
            <div className="mt-4">
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600 dark:text-gray-400">{t('settings.performance.filesScanned')}</span>
                <span className="font-bold text-gray-800 dark:text-white">
                  {(() => {
                    const scanMetrics = performanceMonitor.getMetrics(undefined, 'filesScanned');
                    if (scanMetrics.length > 0) {
                      // 显示最近一次扫描的文件数，而不是累计数
                      const latestMetric = scanMetrics.reduce((latest, current) =>
                        current.timestamp > latest.timestamp ? current : latest
                      );
                      return latestMetric.value;
                    }
                    return 0;
                  })()}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 性能监控控制 */}
        <div className="mt-8 space-y-4">
          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.performance.enabled')}</span>
            <button
              onClick={() => {
                const currentConfig = performanceMonitor.getConfig();
                performanceMonitor.updateConfig({ enabled: !currentConfig.enabled });
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${performanceMonitor.getConfig().enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${performanceMonitor.getConfig().enabled ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.performance.memoryMonitoring')}</span>
            <button
              onClick={() => {
                const currentConfig = performanceMonitor.getConfig();
                performanceMonitor.updateConfig({ enableMemoryMonitoring: !currentConfig.enableMemoryMonitoring });
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${performanceMonitor.getConfig().enableMemoryMonitoring ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${performanceMonitor.getConfig().enableMemoryMonitoring ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>

          {/* 滚动性能记录卡片 */}
          <div className="bg-surface rounded-xl p-4 border border-subtle mt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-md font-semibold text-gray-800 dark:text-white flex items-center">
                <BarChart2 size={16} className="mr-2 text-blue-500" />
                {t('settings.performance.scrollProfiling')}
              </h4>
              <button
                onClick={() => {
                  const newValue = !(performance?.scrollProfiling ?? isScrollProfilerEnabled());
                  onUpdateSettingsData({
                    performance: {
                      refreshInterval: performance?.refreshInterval || 5000,
                      scrollProfiling: newValue
                    }
                  });
                  setScrollProfilerEnabled(newValue);
                  onShowToast?.(newValue
                    ? t('settings.performance.scrollProfilingEnabledToast')
                    : t('settings.performance.scrollProfilingDisabledToast'));
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${(performance?.scrollProfiling ?? isScrollProfilerEnabled()) ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${(performance?.scrollProfiling ?? isScrollProfilerEnabled()) ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">{t('settings.performance.scrollProfilingDesc')}</p>

            {/* 打开目录 / 清空日志 */}
            <div className="flex space-x-3">
              <button
                onClick={() => {
                  const cacheRoot = getGlobalCacheRoot();
                  if (!cacheRoot) {
                    onShowToast?.(t('settings.performance.clearLogsEmpty'));
                    return;
                  }
                  const norm = cacheRoot.replace(/[\\/]+$/, '');
                  const sep = norm.includes('\\') ? '\\' : '/';
                  const parent = norm.lastIndexOf(sep) > 0 ? norm.slice(0, norm.lastIndexOf(sep)) : norm;
                  const logDir = `${parent}${sep}scroll-perf`;
                  import('../../api/tauri-bridge').then(({ openPath, ensureDirectory }) => {
                    // 目录不存在时先创建，保证能打开
                    ensureDirectory(logDir)
                      .then(() => openPath(logDir))
                      .catch(() => {
                        openPath(logDir).catch(() => {
                          onShowToast?.(t('settings.performance.clearLogsEmpty'));
                        });
                      });
                  });
                }}
                className="flex-1 px-4 py-2 bg-panel hover:bg-panel/70 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-subtle text-sm flex items-center justify-center"
              >
                <FolderOpen size={14} className="mr-2" />
                {t('settings.performance.openLogDir')}
              </button>
              <button
                onClick={onOpenClearLogsConfirm}
                className="flex-1 px-4 py-2 bg-panel hover:bg-panel/70 text-red-500 dark:text-red-400 rounded-lg transition-colors border border-subtle text-sm flex items-center justify-center"
              >
                <Trash2 size={14} className="mr-2" />
                {t('settings.performance.clearLogs')}
              </button>
            </div>
          </div>

          <div className="space-y-4 pt-4">
            <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.performance.refreshInterval')}</span>
              <select
                value={refreshInterval / 1000}
                onChange={(e) => {
                  const newInterval = parseInt(e.target.value) * 1000;
                  onUpdateSettingsData({
                    performance: {
                      ...performance,
                      refreshInterval: newInterval
                    }
                  });
                }}
                className="bg-panel rounded px-2 py-1 text-sm outline-none text-gray-800 dark:text-gray-200"
              >
                <option value="1">1秒</option>
                <option value="5">5秒</option>
                <option value="10">10秒</option>
                <option value="30">30秒</option>
                <option value="60">1分钟</option>
              </select>
            </div>

            {/* 清除数据按钮 */}
            <div className="flex space-x-3">
              <button
                onClick={() => performanceMonitor.clearMetrics()}
                className="flex-1 px-4 py-2 bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-subtle text-sm flex items-center justify-center"
              >
                <RefreshCw size={14} className="mr-2" />
                {t('settings.performance.clearData')}
              </button>
            </div>

          </div>
        </div>
      </section>
    </div>
  );
};

export default PerformancePanel;
