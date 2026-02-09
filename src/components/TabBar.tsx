﻿﻿﻿import React, { useRef, useEffect, useState } from 'react';
import { TabState, Topic, Person } from '../types';
import { X, Plus, Tag, Image as ImageIcon, Filter, Folder, Book, Film, Layout, User, Minus, Square, Minimize2, Scan, Pin } from 'lucide-react';
import { isTauriEnvironment } from '../utils/environment';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string;
  files: Record<string, any>;
  topics: Record<string, Topic>;
  people: Record<string, Person>;
  onSwitchTab: (id: string) => void;
  onCloseTab: (e: React.MouseEvent, id: string) => void;
  onNewTab: () => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onCloseWindow: () => void;
  t: (key: string) => string;
  showWindowControls?: boolean;
  isReferenceMode?: boolean;
  onHoverChange?: (isHovering: boolean) => void;
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  files,
  topics,
  people,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  onContextMenu,
  onCloseWindow,
  t,
  showWindowControls = true,
  isReferenceMode = false,
  onHoverChange
}) => {
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [showControls, setShowControls] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [isHoveringTabBar, setIsHoveringTabBar] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isUltraCompact = windowWidth < 260;

  useEffect(() => {
    // Only show custom window controls on Linux for Tauri.
    // Windows uses titleBarOverlay (native controls), macOS uses traffic lights.
    if (isTauriEnvironment()) {
      const platform = (window as any).__TAURI__?.os?.platform || 'linux';
      if (platform === 'linux') {
        setShowControls(true);
      } else {
        setShowControls(false);
      }
    } else {
      // Not Tauri (web mode), usually don't show window controls as browser has its own.
      setShowControls(false);
    }
  }, []);

  useEffect(() => {
    // Listen for window maximize state changes in Tauri
    if (isTauriEnvironment()) {
      const checkMaximizeState = async () => {
        try {
          const window = getCurrentWindow();
          const isMaximizedState = await window.isMaximized();
          setIsMaximized(isMaximizedState);
        } catch (error) {
          console.error('Failed to check maximize state:', error);
        }
      };

      // Initial check
      checkMaximizeState();

      // Set up event listener for window resize to check maximize state
      const handleResize = () => {
        checkMaximizeState();
        setWindowWidth(window.innerWidth);
      };

      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    } else {
      // For non-Tauri environment, still track window width
      const handleResize = () => {
        setWindowWidth(window.innerWidth);
      };
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
  }, []);

  // Sync always on top state with reference mode
  useEffect(() => {
    setIsAlwaysOnTop(isReferenceMode);
  }, [isReferenceMode]);

  const handleTabWheel = (e: React.WheelEvent) => {
    if (tabBarRef.current) {
      tabBarRef.current.scrollLeft += e.deltaY;
    }
  };

  const getTabTitle = (tab: TabState) => {
    if (tab.viewMode === 'tags-overview') return t('sidebar.allTags');

    if (tab.viewMode === 'topics-overview') {
      // If a specific topic is active, show its name; otherwise show generic Topics label
      if (tab.activeTopicId) return topics?.[tab.activeTopicId]?.name || t('sidebar.topics');
      return t('sidebar.topics');
    }

    if (tab.viewMode === 'people-overview') {
      if (tab.activePersonId) return people?.[tab.activePersonId]?.name || t('context.allPeople');
      return t('context.allPeople');
    }

    if (tab.isCompareMode) return tab.sessionName || "画布01";

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

    if (tab.viewMode === 'topics-overview') return <Layout size={12} className="mr-1 text-pink-500 dark:text-pink-400" />;

    if (tab.viewMode === 'people-overview') return <User size={12} className="mr-1 text-purple-500 dark:text-purple-400" />;

    if (tab.isCompareMode) return <Scan size={12} className="mr-1 text-blue-500" />;

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

  // Tauri window control functions
  const handleMinimize = async () => {
    try {
      const window = getCurrentWindow();
      await window.minimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximize = async () => {
    try {
      const window = getCurrentWindow();
      await window.toggleMaximize();
      // Update local state after toggle
      const newState = await window.isMaximized();
      setIsMaximized(newState);
    } catch (error) {
      console.error('Failed to toggle maximize window:', error);
    }
  };

  const handleClose = async () => {
    // Call the onCloseWindow callback instead of directly closing the window
    onCloseWindow();
  };

  const handleAlwaysOnTop = async () => {
    try {
      const window = getCurrentWindow();
      const newState = !isAlwaysOnTop;
      await window.setAlwaysOnTop(newState);
      setIsAlwaysOnTop(newState);
    } catch (error) {
      console.error('Failed to toggle always on top:', error);
    }
  };

  // Handle mouse enter/leave for reference mode hover detection
  const handleMouseEnter = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setIsHoveringTabBar(true);
    onHoverChange?.(true);
  };

  const handleMouseLeave = () => {
    hideTimeoutRef.current = setTimeout(() => {
      setIsHoveringTabBar(false);
      onHoverChange?.(false);
    }, 300);
  };

  // Handle manual drag start for Tauri (needed when transform animation breaks WebkitAppRegion)
  const handleDragStart = async (e: React.MouseEvent) => {
    if (isTauriEnvironment()) {
      // Only start dragging if clicking on the drag area (not on interactive elements)
      const target = e.target as HTMLElement;
      if (target.closest('[data-no-drag]') || target.closest('button') || target.closest('.no-drag')) {
        return;
      }
      try {
        const window = getCurrentWindow();
        await window.startDragging();
      } catch (error) {
        console.error('Failed to start dragging:', error);
      }
    }
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  const shouldShowTabBar = !isReferenceMode || isHoveringTabBar;

  return (
    <div
      className={`flex flex-col z-[200] transition-transform duration-200 ease-out ${
        isReferenceMode ? 'absolute top-0 left-0 right-0' : 'relative'
      } ${
        shouldShowTabBar ? 'translate-y-0' : '-translate-y-full'
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleDragStart}
    >
      {/* Hover detection area - visible only in reference mode when tabbar is hidden */}
      {isReferenceMode && !isHoveringTabBar && (
        <div
          className="absolute -bottom-4 left-0 right-0 h-4 cursor-pointer"
          onMouseEnter={handleMouseEnter}
          style={{ WebkitAppRegion: 'no-drag' } as any}
        />
      )}
      <div
        className="flex items-center bg-gray-200 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-800 h-[41px] select-none w-full"
        style={{ WebkitAppRegion: 'drag' } as any}
      >
        {/* Ultra compact mode: only show close button */}
        {isUltraCompact && isReferenceMode ? (
          <div className="flex items-center justify-between w-full px-2">
            <div className="flex items-center">
              {(() => {
                const activeTab = tabs.find(tab => tab.id === activeTabId);
                if (!activeTab) return null;
                return (
                  <div
                    className="flex items-center h-7 px-2 rounded text-xs bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 font-bold"
                    title={getTabTitle(activeTab)}
                  >
                    {getTabIcon(activeTab)}
                  </div>
                );
              })()}
            </div>
            <button
              onClick={handleClose}
              className="p-1.5 text-gray-500 hover:bg-red-500 hover:text-white rounded transition-colors"
              title={t('window.close')}
              style={{ WebkitAppRegion: 'no-drag' } as any}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <div
              ref={tabBarRef}
              onWheel={handleTabWheel}
              className="flex items-end overflow-x-auto no-scrollbar flex-1 h-full pt-2 px-2 gap-1"
            >
            {/* In reference mode, only show the active tab */}
            {isReferenceMode ? (
              // Reference mode: show only active tab without close button
              // Wrap in a no-drag container to allow dragging on the empty space around the tab
              (() => {
                const activeTab = tabs.find(tab => tab.id === activeTabId);
                if (!activeTab) return null;
                return (
                  <div className="flex items-end h-full pt-2 px-2 gap-1" data-no-drag>
                    <div
                      key={activeTab.id}
                      className={`group relative flex items-center rounded-t-lg text-xs cursor-default select-none transition-all duration-200 bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 font-bold shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-10 -mb-px ${
                        isUltraCompact ? 'min-w-[32px] h-7 px-2' : 'min-w-[80px] max-w-[160px] h-9 px-4'
                      }`}
                      title={getTabTitle(activeTab)}
                    >
                      {getTabIcon(activeTab)}
                      {!isUltraCompact && <span className="truncate flex-1 ml-1">{getTabTitle(activeTab)}</span>}
                    </div>
                  </div>
                );
              })()
            ) : (
              // Normal mode: show all tabs
              <>
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    onClick={() => onSwitchTab(tab.id)}
                    className={`
                        group relative flex items-center min-w-[80px] max-w-[160px] h-9 px-4 rounded-t-lg text-xs cursor-pointer select-none transition-all duration-200
                        ${tab.id === activeTabId
                        ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 font-bold shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-10 -mb-px'
                        : 'bg-transparent text-gray-500 dark:text-gray-300 dark:bg-gray-900 hover:bg-gray-300 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 mt-1'
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
              </>
            )}
            </div>

            {/* Window Controls - Only shown on platforms needing custom controls (Linux) and when allowed */}
            {showControls && showWindowControls && (
              <div className="flex items-center h-full px-2 gap-1 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <button
                  onClick={handleAlwaysOnTop}
                  className={`p-2 rounded transition-all duration-200 ${
                    isAlwaysOnTop
                      ? 'text-gray-700 bg-gray-400/50 dark:text-gray-200 dark:bg-gray-700/50'
                      : 'text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800'
                  }`}
                  title={t('window.alwaysOnTop')}
                >
                  <Pin size={14} className={`transition-transform duration-200 ${isAlwaysOnTop ? 'rotate-45 fill-blue-500 text-blue-500' : ''}`} />
                </button>
                <button
                  onClick={handleMinimize}
                  className="p-2 text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800 rounded transition-colors"
                  title={t('window.minimize')}
                >
                  <Minus size={14} />
                </button>
                <button
                  onClick={handleMaximize}
                  className="p-2 text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800 rounded transition-colors"
                  title={isMaximized ? t('window.restore') : t('window.maximize')}
                >
                  {isMaximized ? <Minimize2 size={14} /> : <Square size={12} />}
                </button>
                <button
                  onClick={handleClose}
                  className="p-2 text-gray-500 hover:bg-red-500 hover:text-white rounded transition-colors"
                  title={t('window.close')}
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Spacer for Native Controls on Windows (approx 140px) if we want to push tabs away, but native controls overlay on top anyway.
                  Keeping the area empty is enough. */}
            {!showControls && isTauriEnvironment() && showWindowControls && (
              <div className="w-[140px] h-full shrink-0"></div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
