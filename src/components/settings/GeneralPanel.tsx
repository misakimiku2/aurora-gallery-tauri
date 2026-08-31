import React from 'react';
import { Globe, Palette, Sun, Moon, Monitor, Check, LayoutGrid, Grid, List, LayoutTemplate, Type, Calendar, HardDrive, ArrowUp, ArrowDown, Layers } from 'lucide-react';
import { AppSettings, LayoutMode, SortOption, SortDirection, GroupByOption } from '../../types';
import { Folder3DIcon } from '../Folder3DIcon';
import { isDebugLogEnabled, setDebugLogEnabled } from '../../utils/debugLog';

// 通用设置 + 外观设置面板组件
interface GeneralPanelProps {
  t: (key: string) => string;
  settings: AppSettings;
  isAndroid: boolean;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
}

// 默认布局设置的默认值，用于缺省时展开
const DEFAULT_LAYOUT = { layoutMode: 'grid' as LayoutMode, sortBy: 'name' as SortOption, sortDirection: 'asc' as SortDirection, groupBy: 'none' as GroupByOption };

const GeneralPanel: React.FC<GeneralPanelProps> = ({ t, settings, isAndroid, onUpdateSettingsData }) => {
  return (
    <div className="space-y-8 animate-fade-in">
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-subtle pb-2">{t('settings.catGeneral')}</h3>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.language')}</label>
            <div className="flex space-x-3">
              {['zh', 'en'].map(lang => (
                <button
                  key={lang}
                  onClick={() => onUpdateSettingsData({ language: lang as any })}
                  className={`px-4 py-2 rounded border text-sm flex items-center ${settings.language === lang ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-subtle'}`}
                >
                  <Globe size={14} className="mr-2" />
                  {lang === 'zh' ? '中文' : 'English'}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-surface rounded-lg p-4 border border-subtle">
            {!isAndroid && (
              <div className="flex items-center justify-between mb-3" style={isAndroid ? { height: '55px' } : undefined}>
                <div>
                  <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.autoStart')}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.autoStartDesc')}</div>
                </div>
                <button
                  onClick={() => {
                    const newValue = !settings.autoStart;
                    onUpdateSettingsData({ autoStart: newValue });
                  }}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.autoStart ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.autoStart ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            )}

            <div className={`flex items-center justify-between ${!isAndroid ? 'mb-3 pt-3 border-subtle' : ''}`} style={isAndroid ? { height: '55px' } : undefined}>
              <div>
                <div className="font-bold text-gray-800 dark:text-gray-200">{isAndroid ? t('settings.animateOnSelect') : t('settings.animateOnHover')}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{isAndroid ? t('settings.animateOnSelectDesc') : t('settings.animateOnHoverDesc')}</div>
              </div>
              <button
                onClick={() => {
                  const newValue = !settings.animateOnHover;
                  onUpdateSettingsData({ animateOnHover: newValue });
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.animateOnHover ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.animateOnHover ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className={`flex items-center justify-between ${!isAndroid ? 'mb-3 pt-3 border-subtle' : ''}`} style={isAndroid ? { height: '55px' } : undefined}>
              <div>
                <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.autoExtractPalette')}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.autoExtractPaletteDesc')}</div>
              </div>
              <button
                onClick={() => {
                  const newValue = !settings.autoExtractPalette;
                  onUpdateSettingsData({ autoExtractPalette: newValue });
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.autoExtractPalette ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.autoExtractPalette ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* 调试日志开关（临时）：安卓端「性能」分类入口是隐藏的，所以放在通用页，
                两边都能直接开关，不用重启。 */}
            <div className={`pt-3 border-subtle`} style={isAndroid ? { minHeight: '55px' } : undefined}>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-bold text-gray-800 dark:text-gray-200">
                    {t('settings.debugLogs') || '调试日志（console.log）'}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                    {t('settings.debugLogsDesc') || '真机量帧率时关掉：每条 console.log 都要经调试通道序列化，高频手势期间会占主线程。'}
                  </div>
                </div>
                <button
                  onClick={() => {
                    const newValue = !(settings.performance?.debugLogs ?? isDebugLogEnabled());
                    setDebugLogEnabled(newValue);
                    onUpdateSettingsData({
                      performance: {
                        ...(settings.performance || { refreshInterval: 5000 }),
                        debugLogs: newValue,
                      },
                    });
                    // 开启时这条能被看到，正好验证开关生效
                    console.log(`[debugLog] console.log ${newValue ? 'ENABLED' : 'DISABLED'}`);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors ${(settings.performance?.debugLogs ?? isDebugLogEnabled()) ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${(settings.performance?.debugLogs ?? isDebugLogEnabled()) ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>

            {!isAndroid && (
              <div className="pt-3 border-subtle">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-800 dark:text-gray-200">{t('settings.exitAction')}</span>
                  <select
                    value={settings.exitAction || 'ask'}
                    onChange={(e) => onUpdateSettingsData({ exitAction: e.target.value as any })}
                    className="bg-panel rounded px-2 py-1 text-sm outline-none text-gray-800 dark:text-gray-200"
                  >
                    <option value="ask">{t('settings.exitActionAsk')}</option>
                    <option value="minimize">{t('settings.exitActionMinimize')}</option>
                    <option value="exit">{t('settings.exitActionExit')}</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mt-10 pt-2">
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Palette size={20} className="mr-2 text-blue-500" /> {t('settings.catAppearance')}</h3>
        <div>
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-4">{t('settings.theme')}</label>
          <div className="grid grid-cols-3 gap-4">
            {['light', 'dark', 'system'].map(mode => (
              <button
                key={mode}
                onClick={() => onUpdateSettingsData({ theme: mode as any })}
                className={`relative rounded-lg border-2 p-1 overflow-hidden group ${settings.theme === mode ? 'border-blue-500' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'}`}
              >
                <div className={`h-24 rounded flex items-center justify-center mb-2 ${mode === 'light' ? 'bg-white border border-gray-200' : mode === 'dark' ? 'bg-gray-900 border border-gray-700' : 'bg-gradient-to-br from-gray-200 to-gray-800'}`}>
                  {mode === 'light' && <Sun size={24} className="text-gray-400" />}
                  {mode === 'dark' && <Moon size={24} className="text-gray-500" />}
                  {mode === 'system' && <Monitor size={24} className="text-gray-300" />}
                </div>
                <div className="text-center text-xs font-medium text-gray-600 dark:text-gray-400 py-1">
                  {mode === 'light' ? t('settings.themeLight') : mode === 'dark' ? t('settings.themeDark') : t('settings.themeSystem')}
                </div>
                {settings.theme === mode && (
                  <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5">
                    <Check size={12} strokeWidth={3} />
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* 文件夹图标样式：直接渲染真实的 Folder3DIcon 组件，与文件网格中的样式
            （含经典版 hover 摊牌动画、简洁版三图瓷砖）完全一致，放大预览 */}
        <div className="mt-6">
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-4">{t('settings.folderIconStyle') || '文件夹图标'}</label>
          <div className="grid grid-cols-2 gap-4 max-w-lg">
            {([
              { id: 'classic', label: t('settings.folderIconStyleClassic') || '经典' },
              { id: 'tiles', label: t('settings.folderIconStyleTiles') || '简洁' },
            ] as const).map(opt => {
              const current = settings.folderIconStyle || 'classic';
              const isSelected = current === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => onUpdateSettingsData({ folderIconStyle: opt.id })}
                  className={`relative rounded-lg border-2 p-1 overflow-hidden group ${isSelected ? 'border-blue-500' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'}`}
                >
                  <div className="h-40 rounded flex items-center justify-center mb-2 bg-surface border border-subtle">
                    <div className="w-32 h-32">
                      <Folder3DIcon variant={opt.id} />
                    </div>
                  </div>
                  <div className="text-center text-xs font-medium text-gray-600 dark:text-gray-400 py-1">
                    {opt.label}
                  </div>
                  {isSelected && (
                    <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5">
                      <Check size={12} strokeWidth={3} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mt-10 pt-2">
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><LayoutGrid size={20} className="mr-2 text-blue-500" /> {t('settings.defaultLayout') || '默认布局设置'}</h3>
        <div className="space-y-6">
          {/* Layout Mode Selection */}
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultLayoutMode') || '默认视图模式'}</label>
            <div className="grid grid-cols-4 gap-3">
              {[
                { id: 'grid', label: t('layout.grid') || '网格', icon: Grid },
                { id: 'adaptive', label: t('layout.adaptive') || '自适应', icon: LayoutGrid },
                { id: 'list', label: t('layout.list') || '列表', icon: List },
                { id: 'masonry', label: t('layout.masonry') || '瀑布流', icon: LayoutTemplate }
              ].map(mode => {
                const Icon = mode.icon;
                const isSelected = settings.defaultLayoutSettings?.layoutMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    onClick={() => onUpdateSettingsData({
                      defaultLayoutSettings: {
                        ...(settings.defaultLayoutSettings || DEFAULT_LAYOUT),
                        layoutMode: mode.id as LayoutMode
                      }
                    })}
                    className={`flex flex-col items-center p-3 rounded-lg border-2 transition-all ${isSelected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-subtle hover:border-gray-300 dark:hover:border-gray-600'
                      }`}
                  >
                    <Icon size={24} className={`mb-2 ${isSelected ? 'text-blue-500' : 'text-gray-400'}`} />
                    <span className={`text-xs font-medium ${isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                      {mode.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sort Options */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultSortBy') || '默认排序方式'}</label>
              <div className="space-y-2">
                {[
                  { id: 'name', label: t('sort.name') || '名称', icon: Type },
                  { id: 'date', label: t('sort.date') || '日期', icon: Calendar },
                  { id: 'size', label: t('sort.size') || '大小', icon: HardDrive }
                ].map(sort => {
                  const Icon = sort.icon;
                  const isSelected = settings.defaultLayoutSettings?.sortBy === sort.id;
                  return (
                    <button
                      key={sort.id}
                      onClick={() => onUpdateSettingsData({
                        defaultLayoutSettings: {
                          ...(settings.defaultLayoutSettings || DEFAULT_LAYOUT),
                          sortBy: sort.id as SortOption
                        }
                      })}
                      className={`w-full flex items-center px-3 py-2 rounded-lg border transition-all ${isSelected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                        : 'border-subtle hover:border-gray-300 dark:hover:border-gray-600 text-gray-700 dark:text-gray-300'
                        }`}
                    >
                      <Icon size={16} className="mr-2" />
                      <span className="text-sm">{sort.label}</span>
                      {isSelected && <Check size={14} className="ml-auto text-blue-500" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultSortDirection') || '默认排序方向'}</label>
              <div className="space-y-2">
                {[
                  { id: 'asc', label: t('sort.ascending') || '升序', icon: ArrowUp },
                  { id: 'desc', label: t('sort.descending') || '降序', icon: ArrowDown }
                ].map(dir => {
                  const Icon = dir.icon;
                  const isSelected = settings.defaultLayoutSettings?.sortDirection === dir.id;
                  return (
                    <button
                      key={dir.id}
                      onClick={() => onUpdateSettingsData({
                        defaultLayoutSettings: {
                          ...(settings.defaultLayoutSettings || DEFAULT_LAYOUT),
                          sortDirection: dir.id as SortDirection
                        }
                      })}
                      className={`w-full flex items-center px-3 py-2 rounded-lg border transition-all ${isSelected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                        : 'border-subtle hover:border-gray-300 dark:hover:border-gray-600 text-gray-700 dark:text-gray-300'
                        }`}
                    >
                      <Icon size={16} className="mr-2" />
                      <span className="text-sm">{dir.label}</span>
                      {isSelected && <Check size={14} className="ml-auto text-blue-500" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Group By Option */}
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultGroupBy') || '默认分组方式'}</label>
            <div className="grid grid-cols-4 gap-3">
              {[
                { id: 'none', label: t('groupBy.none') || '不分组', icon: Layers },
                { id: 'type', label: t('groupBy.type') || '按类型', icon: Grid },
                { id: 'date', label: t('groupBy.date') || '按日期', icon: Calendar },
                { id: 'size', label: t('groupBy.size') || '按大小', icon: HardDrive }
              ].map(group => {
                const Icon = group.icon;
                const isSelected = settings.defaultLayoutSettings?.groupBy === group.id;
                return (
                  <button
                    key={group.id}
                    onClick={() => onUpdateSettingsData({
                      defaultLayoutSettings: {
                        ...(settings.defaultLayoutSettings || DEFAULT_LAYOUT),
                        groupBy: group.id as GroupByOption
                      }
                    })}
                    className={`flex flex-col items-center p-3 rounded-lg border-2 transition-all ${isSelected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-subtle hover:border-gray-300 dark:hover:border-gray-600'
                      }`}
                  >
                    <Icon size={20} className={`mb-2 ${isSelected ? 'text-blue-500' : 'text-gray-400'}`} />
                    <span className={`text-xs font-medium text-center ${isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                      {group.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

    </div>
  );
};

export default GeneralPanel;
