import React, { useMemo } from 'react';
import { Wifi, WifiOff, Loader2, ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { isAndroidPlatformCached } from '../../api/tauri-bridge';
import { FileNode, FileType } from '../../types';

interface NetworkSectionProps {
  onNavigateHome: () => void;
  onToggleExpand: () => void;
  onNavigateFolder: (folderId: string) => void;
  onOpenSettings: () => void;
  expanded: boolean;
  connected: boolean;
  loading?: boolean;
  isSelected?: boolean;
  lanRoots: string[];
  files: Record<string, FileNode>;
  currentFolderId?: string;
  listHeight?: number;
  t: (key: string) => string;
}

const NetworkSection: React.FC<NetworkSectionProps> = React.memo(
  ({
    onNavigateHome,
    onToggleExpand,
    onNavigateFolder,
    onOpenSettings,
    expanded,
    connected,
    loading = false,
    isSelected = false,
    lanRoots,
    files,
    currentFolderId,
    listHeight,
    t,
  }) => {
    const isAndroid = isAndroidPlatformCached();
    const iconSize = isAndroid ? 18 : 14;
    const textClass = isAndroid ? 'text-sm' : 'text-xs';
    const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
    const chevronMr = isAndroid ? 'mr-1.5' : 'mr-1';

    const title = t('sidebar.network.title') || '网络';
    const disconnectedHint = t('sidebar.network.disconnected') || '未连接';
    const loadingHint = t('sidebar.network.loading') || '加载中...';
    const noFoldersHint = t('sidebar.noFolders') || '暂无文件夹';

    const rootNodes = useMemo(() => {
      return (lanRoots || [])
        .map(id => files[id])
        .filter((f): f is FileNode => !!f && f.type === FileType.FOLDER);
    }, [lanRoots, files]);

    const handleHeaderClick = (e: React.MouseEvent) => {
      if (loading) return;
      if ((e.target as HTMLElement).closest('.expand-icon')) {
        e.stopPropagation();
        onToggleExpand();
      } else if (connected) {
        onNavigateHome();
      } else {
        onOpenSettings();
      }
    };

    return (
      <div className={`select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 ${expanded ? 'flex-initial' : 'flex-none'}`}>
        <div
          className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative mt-1 ${
            isSelected
              ? 'text-white rounded-lg'
              : 'hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg'
          }`}
          style={{
            height: isAndroid ? '55px' : '40px',
            minHeight: isAndroid ? '55px' : '40px',
            flexShrink: 0,
            margin: '0 10px',
            ...(isSelected ? { backgroundColor: '#3b82f6' } : {}),
          }}
          onClick={handleHeaderClick}
        >
          <div className={`expand-icon p-1 ${chevronMr} hover:bg-black/10 dark:hover:bg-white/10 rounded`}>
            {expanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />}
          </div>
          <div className="flex items-center flex-1 min-w-0">
            {loading ? (
              <Loader2
                size={iconSize}
                className={`${iconMr} ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'} animate-spin`}
              />
            ) : connected ? (
              <Wifi
                size={iconSize}
                className={`${iconMr} ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`}
              />
            ) : (
              <WifiOff
                size={iconSize}
                className={`${iconMr} text-gray-400 dark:text-gray-500`}
              />
            )}
            <span
              className={`font-bold ${textClass} uppercase tracking-wider transition-colors truncate ${
                isSelected
                  ? 'text-white'
                  : connected
                  ? 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'
                  : 'text-gray-400 dark:text-gray-500'
              }`}
            >
              {title}
            </span>
          </div>
          {loading ? (
            <span className={`text-xs shrink-0 ${isSelected ? 'text-white/80' : 'text-blue-500 dark:text-blue-400'}`}>
              {loadingHint}
            </span>
          ) : !connected ? (
            <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
              {disconnectedHint}
            </span>
          ) : null}
        </div>

        {expanded && connected && (
          <div
            className={`py-1 min-h-0 overflow-y-auto ${isAndroid ? 'no-scrollbar' : 'scrollbar-thin'}`}
            style={{
              maxHeight: listHeight ? `${Math.max(200, listHeight - 180)}px` : '300px',
            }}
          >
            {rootNodes.length === 0 ? (
              <div className="px-10 py-4 text-xs text-gray-400 italic">
                {loading ? loadingHint : noFoldersHint}
              </div>
            ) : (
              rootNodes.map(node => {
                const isCurrent = node.id === currentFolderId;
                return (
                  <div
                    key={node.id}
                    className={`flex items-center px-2 cursor-pointer transition-colors border border-transparent ${
                      isCurrent
                        ? 'bg-blue-600 text-white rounded-lg'
                        : 'hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg'
                    }`}
                    style={{ paddingLeft: '20px', ...(isAndroid ? { height: '35px' } : {}), margin: '0 10px' }}
                    onClick={() => onNavigateFolder(node.id)}
                  >
                    <div className="w-[14px] mr-1" />
                    <Folder
                      size={16}
                      className={`mr-2 ${isCurrent ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`}
                    />
                    <span className="truncate flex-1">{node.name}</span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }
);

export default NetworkSection;
