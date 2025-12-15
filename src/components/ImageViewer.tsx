import React, { useEffect, useRef, useState, useMemo } from 'react';
import { FileNode, SlideshowConfig, SearchScope } from '../types';
import { 
  X, ChevronLeft, ChevronRight, Search, Sidebar, PanelRight, 
  RotateCw, RotateCcw, Maximize, Minimize, ArrowLeft, ArrowRight, 
  Play, Square, Settings, Sliders, Globe, FileText, Tag, Folder as FolderIcon, ChevronDown, Loader2,
  Copy, ExternalLink, Image as ImageIcon, Save, Brain, Move, Trash2, FolderOpen
} from 'lucide-react';

interface ViewerProps {
  file: FileNode;
  prevFile?: FileNode; // Optional now, mostly legacy or direct neighbor specific
  nextFile?: FileNode; // Optional now
  sortedFileIds?: string[]; // New: Full list for calculating neighbors
  files: Record<string, FileNode>;
  layout: { isSidebarVisible: boolean; isMetadataVisible: boolean };
  slideshowConfig: SlideshowConfig;
  activeChannel?: 'original' | 'r' | 'g' | 'b' | 'l'; 
  onLayoutToggle: (part: 'sidebar' | 'metadata') => void;
  onClose: () => void; 
  onNext: (random?: boolean) => void;
  onPrev: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onDelete: (id: string) => void;
  onViewInExplorer: (id: string) => void;
  onCopyToFolder: (fileId: string) => void;
  onMoveToFolder: (fileId: string) => void;
  onNavigateToFolder: (folderId: string) => void;
  searchQuery: string;
  onSearch: (query: string) => void; 
  searchScope: SearchScope;
  onSearchScopeChange: (scope: SearchScope) => void;
  onUpdateSlideshowConfig: (config: SlideshowConfig) => void;
  onPasteTags: (targetId: string) => void; 
  onEditTags: () => void;
  onCopyTags: () => void;
  onAIAnalysis: (fileId: string) => void;
  isAISearchEnabled: boolean;
  onToggleAISearch: () => void;
  t: (key: string) => string;
}

interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
}

export const ImageViewer: React.FC<ViewerProps> = ({ 
  file, 
  prevFile: legacyPrev,
  nextFile: legacyNext,
  sortedFileIds,
  files,
  onClose, 
  onNext, 
  onPrev, 
  onDelete,
  layout,
  onLayoutToggle,
  onNavigateBack,
  onNavigateForward,
  canGoBack,
  canGoForward,
  searchQuery,
  onSearch,
  searchScope,
  onSearchScopeChange,
  slideshowConfig,
  onUpdateSlideshowConfig,
  activeChannel = 'original',
  onPasteTags,
  onEditTags,
  onCopyTags,
  onViewInExplorer,
  onCopyToFolder,
  onMoveToFolder,
  onNavigateToFolder,
  onAIAnalysis,
  isAISearchEnabled,
  onToggleAISearch,
  t
}) => {
  // 如果 file 不存在，关闭查看器
  if (!file) {
    onClose();
    return null;
  }
  
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scopeBtnRef = useRef<HTMLButtonElement>(null);
  
  const [scale, setScale] = useState(1); 
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false });
  const [slideshowActive, setSlideshowActive] = useState(false);
  const [showSlideshowSettings, setShowSlideshowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [scopeMenuPos, setScopeMenuPos] = useState({ top: 0, left: 0 });
  
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [animationClass, setAnimationClass] = useState('animate-zoom-in');
  const lastFileIdRef = useRef(file.id);
  const [isLoaded, setIsLoaded] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>('');

  // Load full image as base64 data URL
  useEffect(() => {
    const loadImage = async () => {
      if (!file.path) {
        setImageUrl('');
        return;
      }
      
      try {
        const { readFileAsBase64 } = await import('../api/tauri-bridge');
        const dataUrl = await readFileAsBase64(file.path);
        if (dataUrl) {
          setImageUrl(dataUrl);
          setIsLoaded(false); // Reset loaded state when image changes
        } else {
          setImageUrl('');
        }
      } catch (error) {
        console.error('Failed to load image:', error);
        setImageUrl('');
      }
    };
    
    loadImage();
  }, [file.path, file.id]);

  // --- Calculate Preload Nodes ---
  const preloadImages = useMemo(() => {
      if (!sortedFileIds || sortedFileIds.length === 0) return [];
      
      const currentIdx = sortedFileIds.indexOf(file.id);
      if (currentIdx === -1) return [];

      const getNeighbor = (offset: number) => {
          const idx = (currentIdx + offset + sortedFileIds.length) % sortedFileIds.length;
          return files[sortedFileIds[idx]];
      };

      // Preload previous 2 and next 2 (only if they have paths)
      const nodes = [
          getNeighbor(-2),
          getNeighbor(-1),
          getNeighbor(1),
          getNeighbor(2)
      ].filter(node => node && node.path && node.id !== file.id);

      return nodes;
  }, [file.id, sortedFileIds, files]);
  // ------------------------------

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // Context menu close handlers
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenu.visible) {
        // 检查点击目标是否在菜单内部，如果不是则关闭菜单
        const menuElement = document.querySelector('.fixed.bg-white.dark\\:bg-\\[\\#2d3748\\].border.border-gray-200.dark\\:border-gray-700.rounded-md.shadow-xl.text-sm.py-1.text-gray-800.dark\\:text-gray-200.min-w-\\[220px\\].z-\\[60\\]');
        if (!menuElement || !menuElement.contains(e.target as Node)) {
          setContextMenu({ ...contextMenu, visible: false });
        }
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (contextMenu.visible) {
        setContextMenu({ ...contextMenu, visible: false });
      }
    };

    // 使用冒泡阶段，避免影响菜单内部点击
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('wheel', handleWheel, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('wheel', handleWheel, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const handleResize = () => setScopeMenuOpen(false);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (lastFileIdRef.current !== file.id) {
      if (slideshowActive) {
         if (slideshowConfig.transition === 'fade') setAnimationClass('animate-fade-in');
         else if (slideshowConfig.transition === 'slide') setAnimationClass('animate-slide-left');
         else setAnimationClass('');
      } else {
         if (!animationClass) setAnimationClass('animate-zoom-in');
      }

      setRotation(0);
      setPosition({ x: 0, y: 0 });
      setScale(1); 
      setIsLoaded(false); 
      lastFileIdRef.current = file.id;
    }
  }, [file.id, slideshowActive, slideshowConfig]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || slideshowActive) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const ZOOM_SPEED = 0.1;
      const direction = Math.sign(e.deltaY);

      setScale(currentScale => {
          let newScale = currentScale;
          if (direction < 0) {
              newScale = currentScale * (1 + ZOOM_SPEED);
          } else {
              newScale = currentScale / (1 + ZOOM_SPEED);
          }
          return Math.max(0.01, Math.min(newScale, 8));
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [slideshowActive]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setTimeout>;
    if (slideshowActive) {
      intervalId = setInterval(() => {
        onNext(slideshowConfig.isRandom);
      }, slideshowConfig.interval);
    }
    return () => clearInterval(intervalId);
  }, [slideshowActive, onNext, slideshowConfig]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await rootRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleSearchSubmit = () => {
    onSearch(localQuery);
  };

  const toggleScopeMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!scopeMenuOpen && scopeBtnRef.current) {
       const rect = scopeBtnRef.current.getBoundingClientRect();
       setScopeMenuPos({ top: rect.bottom + 8, left: rect.left });
    }
    setScopeMenuOpen(!scopeMenuOpen);
  };

  const handleCopyImage = async () => {
      try {
          if (!file.path) return;
          
          // Read file as base64 and convert to blob
          const { readFileAsBase64 } = await import('../api/tauri-bridge');
          const dataUrl = await readFileAsBase64(file.path);
          if (!dataUrl) return;
          
          // Convert data URL to blob
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          await navigator.clipboard.write([
              new ClipboardItem({
                  [blob.type]: blob
              })
          ]);
      } catch (err) {
          console.error('Failed to copy image: ', err);
      }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSearch && document.activeElement === searchInputRef.current) {
        if (e.key === 'Enter') handleSearchSubmit();
        return;
      }

      if (e.key === 'ArrowRight') handleNext();
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'Escape') {
        if (showSearch) setShowSearch(false);
        else if (showSlideshowSettings) setShowSlideshowSettings(false);
        else if (slideshowActive) setSlideshowActive(false);
        else onClose();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, slideshowActive, showSlideshowSettings, showSearch, localQuery]); 

  const handleNext = () => {
    setAnimationClass('animate-slide-left');
    onNext();
  };

  const handlePrev = () => {
    setAnimationClass('animate-slide-right');
    onPrev();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (slideshowActive) return;
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (slideshowActive) return;
    if (!isDragging) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
  };

  const toggleSlideshow = () => {
    if (!slideshowActive) {
      setSlideshowActive(true);
      if (!document.fullscreenElement) {
         rootRef.current?.requestFullscreen().then(() => setIsFullscreen(true));
      }
      setContextMenu({ ...contextMenu, visible: false });
    } else {
      setSlideshowActive(false);
      setContextMenu({ ...contextMenu, visible: false });
    }
  };

  const rotate = (deg: number) => setRotation(r => r + deg);
  
  const handleReset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setRotation(0);
  };
  
  const handleFitWindow = () => handleReset();

  const handleOriginalSize = () => {
      if (!imgRef.current || !containerRef.current) return;
      const { naturalWidth, naturalHeight } = imgRef.current;
      const { width: containerWidth, height: containerHeight } = containerRef.current.getBoundingClientRect();
      
      if (!naturalWidth || !naturalHeight) return;

      const scaleX = containerWidth / naturalWidth;
      const scaleY = containerHeight / naturalHeight;
      const fitScale = Math.min(scaleX, scaleY);
      
      // Calculate new scale. 
      // If fitScale < 1 (image larger than window), we scale UP by 1/fitScale to reach 1.0 (original size).
      // If fitScale > 1 (image smaller than window), we scale DOWN.
      const newScale = 1 / fitScale;
      
      setScale(newScale);
      setPosition({ x: 0, y: 0 });
  };

  const getScopeIcon = () => {
    switch (searchScope) {
      case 'file': return <FileText size={14} />;
      case 'tag': return <Tag size={14} />;
      case 'folder': return <FolderIcon size={14} />;
      default: return <Globe size={14} />;
    }
  };

  const filterStyle = activeChannel === 'original' ? {} : { filter: `url(#channel-${activeChannel})` };

  return (
    <div 
      ref={rootRef}
      className={`flex-1 flex flex-col h-full relative select-none overflow-hidden transition-colors duration-300 ${slideshowActive ? 'bg-black' : 'bg-gray-50 dark:bg-gray-900'}`}
      onClick={() => setContextMenu({ ...contextMenu, visible: false })}
    >
      {/* Background Preloading of 4 neighbors - Note: Preloading disabled in Tauri as file.url is not a usable URL */}
      {/* <div className="hidden">
         {preloadImages.map(node => (
             node?.url && <img key={node.id} src={node.url} alt="preload" />
         ))}
      </div> */}

      <div className={`h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between z-20 shrink-0 transition-all duration-300 ${(isFullscreen && slideshowActive) || slideshowActive ? '-translate-y-full absolute w-full top-0 opacity-0 pointer-events-none' : ''}`}>
        
        <div className="flex items-center space-x-2 flex-1">
          <button 
            onClick={() => onLayoutToggle('sidebar')}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layout.isSidebarVisible ? 'text-gray-500 dark:text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}
            title={t('viewer.toggleSidebar')}
          >
            <Sidebar size={18} />
          </button>
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-2"></div>
          <button 
            onClick={onNavigateBack} disabled={!canGoBack}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-500 dark:text-gray-400"
            title={t('viewer.back')}
          >
            <ArrowLeft size={18} />
          </button>
          <button 
            onClick={onNavigateForward} disabled={!canGoForward}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-500 dark:text-gray-400"
            title={t('viewer.forward')}
          >
            <ArrowRight size={18} />
          </button>
          
          {/* Search Box moved to left side, after forward button */}
          {showSearch && (
            <div className="relative ml-4 flex-1 max-w-[672px] animate-fade-in">
              <div className={`flex items-center bg-gray-100 dark:bg-gray-800 rounded-full px-3 py-1.5 transition-all border ${isAISearchEnabled ? 'border-purple-500 shadow-sm shadow-purple-500/20' : localQuery ? 'border-blue-500 shadow-sm' : 'border-transparent'}`}>
                 <div className="relative">
                   <button 
                     ref={scopeBtnRef}
                     type="button"
                     onClick={toggleScopeMenu}
                     className="flex items-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mr-2 pr-2 border-r border-gray-300 dark:border-gray-700"
                   >
                     {getScopeIcon()}
                     <ChevronDown size={12} className="ml-1 opacity-70"/>
                   </button>
                 </div>
                <Search size={16} className={`mr-2 ${isAISearchEnabled ? 'text-purple-500' : 'text-gray-400'}`} />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={localQuery}
                  onChange={(e) => setLocalQuery(e.target.value)}
                  placeholder={isAISearchEnabled ? t('settings.aiSmartSearch') : t('search.placeholder')}
                  className="bg-transparent border-none flex-1 focus:outline-none text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearchSubmit(); }}
                />
                <div className="flex items-center space-x-1 ml-2">
                  {localQuery && (
                    <button onClick={() => { setLocalQuery(''); onSearch(''); }} className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400">
                      <X size={14} />
                    </button>
                  )}
                  <button 
                    onClick={onToggleAISearch}
                    className={`p-1.5 rounded-full transition-colors ${isAISearchEnabled ? 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300' : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400'}`}
                    title={t('settings.aiSmartSearch')}
                  >
                    <Brain size={16} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200 flex justify-center">
          {!showSearch && (
            <span>{file.name}</span>
          )}
        </div>

        <div className="flex items-center space-x-2 justify-end">
          <div className="flex items-center space-x-2 mr-4 w-32 hidden min-[1580px]:flex">
            <Minimize size={14} className="text-gray-500" />
            <input 
              type="range" 
              min="0.01" 
              max="8" 
              step="0.01" 
              value={scale}
              onChange={(e) => {
                setScale(parseFloat(e.target.value));
              }}
              className="flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
            />
            <Maximize size={14} className="text-gray-500" />
          </div>

          <button onClick={handleOriginalSize} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('viewer.original')}>
             <span className="text-xs font-bold">1:1</span>
          </button>
          <button onClick={handleReset} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title={t('viewer.fit')}>
            <Maximize size={18} />
          </button>
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1 hidden sm:block"></div>
          <button onClick={() => rotate(-90)} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('viewer.rotateLeft')}>
            <RotateCcw size={18} />
          </button>
          <button onClick={() => rotate(90)} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('viewer.rotateRight')}>
            <RotateCw size={18} />
          </button>
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>
          
          <button 
            onClick={() => setShowSearch(!showSearch)} 
            className={`p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${showSearch || localQuery ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`} 
            title={t('viewer.search')}
          >
            <Search size={18} />
          </button>
          
          <button 
            onClick={() => onLayoutToggle('metadata')}
            className={`p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${layout.isMetadataVisible ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}
            title={t('viewer.toggleMeta')}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </div>

      <div 
        ref={containerRef}
        className={`flex-1 overflow-hidden relative cursor-grab active:cursor-grabbing transition-colors duration-300 ${slideshowActive ? 'bg-black cursor-none' : 'bg-gray-200 dark:bg-gray-900'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
        style={slideshowActive ? { cursor: 'none' } : {}}
      >
        {!isLoaded && (
           <div className="absolute inset-0 flex items-center justify-center z-0">
               <Loader2 className="animate-spin text-gray-400 dark:text-gray-600" size={48} />
           </div>
        )}

        <div className={`w-full h-full flex items-center justify-center pointer-events-none ${animationClass}`}>
           {imageUrl ? (
             <img 
               ref={imgRef}
               key={file.id} 
               src={imageUrl} 
               alt={file.name}
               className={`max-w-none transition-opacity duration-300 ${isLoaded ? 'opacity-100' : 'opacity-0'} ${slideshowActive && slideshowConfig.enableZoom ? 'animate-ken-burns' : ''}`}
               onLoad={() => setIsLoaded(true)}
               loading="eager"
               decoding="async"
               style={{
                 width: '100%',
                 height: '100%',
                 objectFit: 'contain',
                 transform: slideshowActive && slideshowConfig.enableZoom ? undefined : `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                 transition: isDragging ? 'none' : (slideshowActive ? undefined : 'transform 0.1s linear'),
                 pointerEvents: slideshowActive ? 'none' : 'auto',
                 transformOrigin: 'center center',
                 ...filterStyle
               }}
               draggable={false}
             />
           ) : (
             <div className="flex items-center justify-center">
               <Loader2 className="animate-spin text-gray-400" size={32} />
             </div>
           )}
        </div>

        {!slideshowActive && (
          <>
            <div className="absolute inset-y-0 left-0 w-24 flex items-center justify-start pl-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r from-black/30 to-transparent z-10 pointer-events-auto">
              <button 
                onClick={(e) => { e.stopPropagation(); handlePrev(); }}
                className="p-3 rounded-full bg-black/50 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transform transition-transform active:scale-95"
              >
                <ChevronLeft size={32} />
              </button>
            </div>
            <div className="absolute inset-y-0 right-0 w-24 flex items-center justify-end pr-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-l from-black/30 to-transparent z-10 pointer-events-auto">
              <button 
                onClick={(e) => { e.stopPropagation(); handleNext(); }}
                className="p-3 rounded-full bg-black/50 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transform transition-transform active:scale-95"
              >
                <ChevronRight size={32} />
              </button>
            </div>
          </>
        )}
      </div>

      {contextMenu.visible && (
        <div 
          className="fixed bg-white dark:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[220px] z-[60] max-h-[80vh] overflow-y-auto animate-zoom-in"
          style={{ 
            top: contextMenu.y + 350 > window.innerHeight ? 'auto' : contextMenu.y,
            bottom: contextMenu.y + 350 > window.innerHeight ? window.innerHeight - contextMenu.y : 'auto',
            left: Math.min(contextMenu.x, window.innerWidth - 240)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleOriginalSize(); setContextMenu({...contextMenu, visible: false}); }}>
             <Maximize size={14} className="mr-2 opacity-70"/> {t('viewer.original')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleFitWindow(); setContextMenu({...contextMenu, visible: false}); }}>
             <Minimize size={14} className="mr-2 opacity-70"/> {t('viewer.fit')}
          </div>
          
          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>

          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { onViewInExplorer(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <ExternalLink size={14} className="mr-2 opacity-70"/> {t('context.viewInExplorer')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { if(file.parentId) onNavigateToFolder(file.parentId); setContextMenu({...contextMenu, visible: false}); }}>
             <FolderOpen size={14} className="mr-2 opacity-70"/> {t('context.openFolder')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>

          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { onCopyTags(); setContextMenu({...contextMenu, visible: false}); }}>
             <Tag size={14} className="mr-2 opacity-70"/> {t('context.copyTag')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { onPasteTags(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Tag size={14} className="mr-2 opacity-70"/> {t('context.pasteTag')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>

          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { onCopyToFolder(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Copy size={14} className="mr-2 opacity-70"/> {t('context.copyTo')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { onMoveToFolder(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Move size={14} className="mr-2 opacity-70"/> {t('context.moveTo')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
          
          <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => { onAIAnalysis(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Brain size={14} className="mr-2 opacity-70"/> {t('context.aiAnalyze')}
          </div>
          
          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
          
          <div 
            className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between"
            onClick={() => { setShowSlideshowSettings(true); setContextMenu({...contextMenu, visible: false}); }}
          >
            <div className="flex items-center">
                <Settings size={14} className="mr-2"/>
                {t('context.slideshowSettings')}
            </div>
          </div>
          <div 
            className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between"
            onClick={toggleSlideshow}
          >
            <div className="flex items-center">
                {slideshowActive ? <Square size={14} className="mr-2"/> : <Play size={14} className="mr-2"/>}
                {slideshowActive ? t('context.stopSlideshow') : t('context.startSlideshow')}
            </div>
          </div>
          
          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
          
          <div className="px-4 py-2 hover:bg-red-600 hover:text-white text-red-500 dark:text-red-400 cursor-pointer flex items-center" onClick={() => { onDelete(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Trash2 size={14} className="mr-2 opacity-70"/> {t('context.delete')}
          </div>
        </div>
      )}

      {scopeMenuOpen && (
        <>
           <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); setScopeMenuOpen(false); }}></div>
           <div 
              className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-[61] overflow-hidden py-1 text-left w-36 animate-fade-in"
              style={{ top: scopeMenuPos.top, left: scopeMenuPos.left }}
           >
              {[
                 { id: 'all', icon: Globe, label: t('search.scopeAll') },
                 { id: 'file', icon: FileText, label: t('search.scopeFile') },
                 { id: 'tag', icon: Tag, label: t('search.scopeTag') },
                 { id: 'folder', icon: FolderIcon, label: t('search.scopeFolder') }
              ].map((opt) => (
                 <button
                    key={opt.id}
                    type="button"
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      onSearchScopeChange(opt.id as SearchScope); 
                      setScopeMenuOpen(false); 
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center hover:bg-blue-50 dark:hover:bg-blue-900/20 ${searchScope === opt.id ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-700 dark:text-gray-300'}`}
                 >
                    <opt.icon size={14} className="mr-2"/> {opt.label}
                 </button>
              ))}
           </div>
        </>
      )}

      {showSlideshowSettings && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg w-80 shadow-2xl p-4 animate-zoom-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 border-b border-gray-200 dark:border-gray-700 pb-2">
              <h3 className="font-bold text-gray-800 dark:text-gray-200 flex items-center"><Sliders size={16} className="mr-2"/> {t('context.slideshowSettings')}</h3>
              <button onClick={() => setShowSlideshowSettings(false)} className="text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white"><X size={18}/></button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('viewer.slideshowInterval')} ({slideshowConfig.interval / 1000}s)</label>
                <input 
                  type="range" 
                  min="1000" 
                  max="10000" 
                  step="500"
                  value={slideshowConfig.interval}
                  onChange={(e) => onUpdateSlideshowConfig({ ...slideshowConfig, interval: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('viewer.transition')}</label>
                <select 
                  value={slideshowConfig.transition}
                  onChange={(e) => onUpdateSlideshowConfig({ ...slideshowConfig, transition: e.target.value as any })}
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                >
                  <option value="none">{t('viewer.none')}</option>
                  <option value="fade">{t('viewer.fade')}</option>
                  <option value="slide">{t('viewer.slide')}</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('viewer.enableZoom')}</span>
                <button 
                  onClick={() => onUpdateSlideshowConfig({ ...slideshowConfig, enableZoom: !slideshowConfig.enableZoom })}
                  className={`w-10 h-5 rounded-full relative transition-colors ${slideshowConfig.enableZoom ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-600'}`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${slideshowConfig.enableZoom ? 'left-6' : 'left-1'}`}></div>
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('viewer.random')}</span>
                <button 
                  onClick={() => onUpdateSlideshowConfig({ ...slideshowConfig, isRandom: !slideshowConfig.isRandom })}
                  className={`w-10 h-5 rounded-full relative transition-colors ${slideshowConfig.isRandom ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-600'}`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${slideshowConfig.isRandom ? 'left-6' : 'left-1'}`}></div>
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-2">
               <button 
                onClick={toggleSlideshow}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-1.5 rounded text-sm flex items-center"
              >
                <Play size={12} className="mr-1"/> {t('context.startSlideshow')}
              </button>
              <button 
                onClick={() => setShowSlideshowSettings(false)}
                className="bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-white px-4 py-1.5 rounded text-sm"
              >
                {t('viewer.done')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};