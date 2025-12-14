import React, { useRef, useEffect, useState } from 'react';
import { TabState } from '../types';
import { X, Plus, Tag, Image as ImageIcon, Filter, Folder, Book, Film, Minus, Square } from 'lucide-react';

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string;
  files: Record<string, any>;
  onSwitchTab: (id: string) => void;
  onCloseTab: (e: React.MouseEvent, id: string) => void;
  onNewTab: () => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  t: (key: string) => string;
  showWindowControls?: boolean;
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  files,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  onContextMenu,
  t,
  showWindowControls = true
}) => {
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [showControls, setShowControls] = useState(false);

  useEffect(() => {
    // Only show custom window controls on Linux or if not in Electron.
    // Windows uses titleBarOverlay (native controls), macOS uses traffic lights.
    if (window.electron) {
        // @ts-ignore
        const platform = window.electron.platform;
        if (platform === 'linux') {
            setShowControls(true);
        } else {
            setShowControls(false);
        }
    } else {
        // Not electron (web mode), usually don't show window controls or show them if PWA?
        // For now, hide them in web mode as browser has its own.
        setShowControls(false);
    }
  }, []);

  const handleTabWheel = (e: React.WheelEvent) => {
    if (tabBarRef.current) {
      tabBarRef.current.scrollLeft += e.deltaY;
    }
  };

  const getTabTitle = (tab: TabState) => {
    if (tab.viewMode === 'tags-overview') return t('sidebar.allTags');
    
    // Check if viewing a file inside a Book or Sequence folder
    if (tab.viewingFileId) {
        const file = files[tab.viewingFileId];
        if (file && file.parentId) {
            const parent = files[file.parentId];
            if (parent?.category === 'book' || parent?.category === 'sequence') {
                return parent.name;
            }
        }
        return file?.name || t('app.viewing');
    }
    
    if (tab.activeTags.length > 0) return `${tab.activeTags.length} ${t('app.filters')}`;
    return files[tab.folderId]?.name || t('app.folder');
  };

  const getTabIcon = (tab: TabState) => {
    if (tab.viewMode === 'tags-overview') return <Tag size={12} className="mr-1 text-purple-500" />;
    
    if (tab.viewingFileId) {
        const file = files[tab.viewingFileId];
        if (file && file.parentId) {
            const parent = files[file.parentId];
            if (parent?.category === 'book') {
                return <Book size={12} className="mr-1 text-amber-500" />;
            }
            if (parent?.category === 'sequence') {
                return <Film size={12} className="mr-1 text-purple-500" />;
            }
        }
        return <ImageIcon size={12} className="mr-1 text-green-500" />;
    }
    
    if (tab.activeTags.length > 0) return <Filter size={12} className="mr-1 text-amber-500" />;
    return <Folder size={12} className="mr-1 text-blue-500" />;
  };

  return (
    <div className="flex items-center bg-gray-200 dark:bg-black border-b border-gray-300 dark:border-gray-800 h-[41px] select-none w-full" style={{ WebkitAppRegion: 'drag' } as any}>
        <div
          ref={tabBarRef}
          onWheel={handleTabWheel}
          className="flex items-end overflow-x-auto no-scrollbar flex-1 h-full pt-2 px-2 gap-1"
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => onSwitchTab(tab.id)}
              className={`
                group relative flex items-center min-w-[80px] max-w-[160px] h-9 px-4 rounded-t-lg text-xs cursor-pointer select-none transition-all duration-200
                ${tab.id === activeTabId
                  ? 'bg-white dark:bg-gray-950 text-blue-600 dark:text-blue-400 font-bold shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-10 -mb-px'
                  : 'bg-transparent text-gray-500 dark:text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 mt-1'
                }
              `}
              title={getTabTitle(tab)}
              onMouseDown={(e) => {
                if (e.button === 1) onCloseTab(e, tab.id);
              }}
              onContextMenu={(e) => onContextMenu(e, tab.id)}
              style={{ WebkitAppRegion: 'no-drag' } as any}
            >
              {getTabIcon(tab)}
              <span className="truncate flex-1">{getTabTitle(tab)}</span>
              <button
                onClick={(e) => onCloseTab(e, tab.id)}
                className={`ml-1 p-0.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 opacity-0 group-hover:opacity-100 ${tabs.length === 1 ? 'hidden' : ''}`}
              >
                <X size={10} />
              </button>
            </div>
          ))}
          <button
            onClick={onNewTab}
            className="p-1.5 rounded hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-500 mb-1 transition-colors"
            title={t('context.newTab')}
            style={{ WebkitAppRegion: 'no-drag' } as any}
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Window Controls - Only shown on platforms needing custom controls (Linux) and when allowed */}
        {showControls && showWindowControls && (
            <div className="flex items-center h-full px-2 gap-1 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <button 
                    onClick={() => window.electron?.minimize()} 
                    className="p-2 text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800 rounded transition-colors"
                    title="Minimize"
                >
                    <Minus size={14} />
                </button>
                <button 
                    onClick={() => window.electron?.maximize()} 
                    className="p-2 text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800 rounded transition-colors"
                    title="Maximize / Restore"
                >
                    <Square size={12} />
                </button>
                <button 
                    onClick={() => window.electron?.close()} 
                    className="p-2 text-gray-500 hover:bg-red-500 hover:text-white rounded transition-colors"
                    title="Close"
                >
                    <X size={14} />
                </button>
            </div>
        )}
        
        {/* Spacer for Native Controls on Windows (approx 140px) if we want to push tabs away, but native controls overlay on top anyway. 
            Keeping the area empty is enough. */}
        {!showControls && window.electron && showWindowControls && (
             <div className="w-[140px] h-full shrink-0"></div>
        )}
    </div>
  );
};