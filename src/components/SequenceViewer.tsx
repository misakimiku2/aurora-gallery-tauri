
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { FileNode, FileType } from '../types';
import { 
  X, ChevronLeft, ChevronRight, Play, Pause, Film, Sidebar, PanelRight, 
  Settings, Repeat, Repeat1, Clock, FileText, Info, Minimize, Maximize, Trash2, AlertTriangle, Loader2
} from 'lucide-react';

interface SequenceViewerProps {
  file: FileNode;
  folder: FileNode;
  files: Record<string, FileNode>;
  sortedFileIds: string[];
  onClose: () => void;
  onNavigate: (id: string) => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  onDelete?: (id: string) => void;
  t: (key: string) => string;
}

export const SequenceViewer: React.FC<SequenceViewerProps> = ({
  file,
  folder,
  files,
  sortedFileIds,
  onClose,
  onNavigate,
  isSidebarOpen,
  onToggleSidebar,
  onDelete,
  t
}) => {
  // Config state
  const [fps, setFps] = useState(24);
  const [isLooping, setIsLooping] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showDetails, setShowDetails] = useState(true);

  // Zoom & Pan State
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // UI State
  const [contextMenu, setContextMenu] = useState<{ visible: boolean, x: number, y: number }>({ visible: false, x: 0, y: 0 });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [currentImageUrl, setCurrentImageUrl] = useState<string>('');

  // Context menu close handlers
  useEffect(() => {
    // 只有当菜单可见时才添加事件监听器
    if (!contextMenu.visible) return;

    const handleClick = () => {
      setContextMenu({ ...contextMenu, visible: false });
    };

    const handleWheel = () => {
      setContextMenu({ ...contextMenu, visible: false });
    };

    // 在下一个事件循环中添加事件监听器，确保能捕获到菜单显示后的点击事件
    const timer = setTimeout(() => {
      // 使用 capture 阶段确保能捕获到所有点击和滚动事件
      document.addEventListener('mousedown', handleClick, true);
      document.addEventListener('wheel', handleWheel, true);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('wheel', handleWheel, true);
    };
  }, [contextMenu.visible, contextMenu]);

  // Filter valid images from the provided list
  const validFileIds = useMemo(() => {
      return sortedFileIds.filter(id => files[id]?.type === FileType.IMAGE);
  }, [sortedFileIds, files]);

  const currentIndex = validFileIds.indexOf(file.id);
  const totalFrames = validFileIds.length;
  const currentFile = files[validFileIds[currentIndex]];

  // Calculate ticks for progress bar based on FPS pattern
  // Pattern: Major at start and multiples of FPS (1, 24, 48...), Minor at half FPS (12, 36...)
  // User requested "1, 12, 24" for 24fps. 
  // Let's interpret as: Frame 1 (Major), Frame 12 (Minor), Frame 24 (Major)
  const ticks = useMemo(() => {
    if (totalFrames <= 1) return [];
    
    const result: { index: number; type: 'major' | 'minor'; label: number }[] = [];
    const halfFps = Math.floor(fps / 2);

    for (let i = 0; i < totalFrames; i++) {
        const frameNum = i + 1;
        let type: 'major' | 'minor' | null = null;

        // Force first frame
        if (i === 0) {
            type = 'major';
        }
        // Multiples of FPS (24, 48...) - End of seconds
        else if (frameNum % fps === 0) {
            type = 'major';
        }
        // Half FPS points (12, 36...) - Middle of seconds
        else if (frameNum % fps === halfFps && frameNum % fps !== 0) { // check !== 0 for low fps edge cases
            type = 'minor';
        }

        // Avoid too many ticks if total frames is huge, maybe throttle? 
        // For now, adhere to logic but simple spacing check could be added if needed.
        if (type) {
            result.push({ index: i, type, label: frameNum });
        }
    }
    
    return result;
  }, [totalFrames, fps]);

  // Playback Loop
  useEffect(() => {
    let intervalId: ReturnType<typeof setTimeout>;

    if (isPlaying) {
      intervalId = setInterval(() => {
        const nextIndex = currentIndex + 1;
        
        if (nextIndex >= totalFrames) {
          if (isLooping) {
            onNavigate(validFileIds[0]);
          } else {
            setIsPlaying(false);
          }
        } else {
          onNavigate(validFileIds[nextIndex]);
        }
      }, 1000 / fps);
    }

    return () => clearInterval(intervalId);
  }, [isPlaying, fps, isLooping, currentIndex, totalFrames, validFileIds, onNavigate]);

  // Load current image as base64
  useEffect(() => {
    const loadImage = async () => {
      if (!currentFile?.path) {
        setCurrentImageUrl('');
        return;
      }
      
      try {
        const { readFileAsBase64 } = await import('../api/tauri-bridge');
        const dataUrl = await readFileAsBase64(currentFile.path);
        if (dataUrl) {
          setCurrentImageUrl(dataUrl);
        } else {
          setCurrentImageUrl('');
        }
      } catch (error) {
        console.error('Failed to load image:', error);
        setCurrentImageUrl('');
      }
    };
    
    loadImage();
  }, [currentFile?.path, currentFile?.id]);

  // Preloading - Note: Disabled in Tauri as file.url is not a usable URL
  // useEffect(() => {
  //   if (!isPlaying) return;
  //   const preloadCount = 5;
  //   for (let i = 1; i <= preloadCount; i++) {
  //     const nextIdx = (currentIndex + i) % totalFrames;
  //     const nextFile = files[validFileIds[nextIdx]];
  //     if (nextFile?.url) {
  //       const img = new Image();
  //       img.src = nextFile.url;
  //     }
  //   }
  // }, [currentIndex, isPlaying, totalFrames, validFileIds, files]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      }
      if (e.key === 'ArrowRight') {
        const nextIndex = (currentIndex + 1) % totalFrames;
        onNavigate(validFileIds[nextIndex]);
        setIsPlaying(false);
      }
      if (e.key === 'ArrowLeft') {
        const prevIndex = (currentIndex - 1 + totalFrames) % totalFrames;
        onNavigate(validFileIds[prevIndex]);
        setIsPlaying(false);
      }
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, totalFrames, validFileIds, onNavigate, onClose, isPlaying]);

  // Zoom Handler
  const handleWheel = (e: React.WheelEvent) => {
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
        return Math.max(0.1, Math.min(newScale, 8));
    });
  };

  // Pan Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      e.preventDefault();
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleReset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleOriginal = () => setScale(1);

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newIndex = parseInt(e.target.value);
    onNavigate(validFileIds[newIndex]);
    if (isPlaying) setIsPlaying(false);
  };

  const handlePrev = () => {
    const prevIndex = (currentIndex - 1 + totalFrames) % totalFrames;
    onNavigate(validFileIds[prevIndex]);
    setIsPlaying(false);
  };

  const handleNext = () => {
    const nextIndex = (currentIndex + 1) % totalFrames;
    onNavigate(validFileIds[nextIndex]);
    setIsPlaying(false);
  };

  const togglePlay = () => setIsPlaying(prev => !prev);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY });
  };

  const handleDeleteRequest = () => {
    setContextMenu({ ...contextMenu, visible: false });
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = () => {
    if (onDelete && currentFile) {
      onDelete(currentFile.id);
    }
    setShowDeleteConfirm(false);
  };

  return (
    <div 
        className={`fixed top-10 right-0 bottom-0 z-[45] bg-gray-50 dark:bg-gray-950 flex text-gray-900 dark:text-gray-100 overflow-hidden font-sans transition-all duration-300 ${isSidebarOpen ? 'left-64' : 'left-0'}`}
        onClick={() => setContextMenu({ ...contextMenu, visible: false })}
    >
      
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative h-full">
        {/* Header */}
        <div className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-4 shrink-0 z-20 shadow-sm transition-colors">
           <div className="flex items-center space-x-3 overflow-hidden">
              <button 
                onClick={onToggleSidebar} 
                className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${isSidebarOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}
                title={t('viewer.toggleSidebar')}
              >
                <Sidebar size={20} />
              </button>
              <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>
              <Film className="text-purple-500" size={20} />
              <span className="font-bold text-lg truncate">{folder.name}</span>
              <span className="text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full whitespace-nowrap border border-gray-200 dark:border-gray-700">
                 {currentFile?.name}
              </span>
           </div>
           
           <div className="flex items-center space-x-2">
              {/* Zoom Controls */}
              <div className="flex items-center space-x-2 mr-4 w-32 hidden lg:flex">
                <Minimize size={14} className="text-gray-500" />
                <input 
                  type="range" 
                  min="0.1" 
                  max="8" 
                  step="0.1" 
                  value={scale}
                  onChange={(e) => setScale(parseFloat(e.target.value))}
                  className="flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
                />
                <Maximize size={14} className="text-gray-500" />
              </div>

              <button onClick={handleOriginal} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('sequence.original')}>
                 <span className="text-xs font-bold">1:1</span>
              </button>
              <button onClick={handleReset} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title={t('sequence.fit')}>
                <Maximize size={18} />
              </button>
              <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>

              <button 
                onClick={() => setShowDetails(!showDetails)} 
                className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${showDetails ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}
                title={t('viewer.toggleMeta')}
              >
                <PanelRight size={20} />
              </button>
              <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>
              <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400">
                  <X size={24} />
              </button>
           </div>
        </div>

        {/* Viewer Canvas */}
        <div 
            className="flex-1 relative flex items-center justify-center bg-gray-200 dark:bg-[#121212] overflow-hidden p-4 cursor-grab active:cursor-grabbing"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onContextMenu={handleContextMenu}
        >
           {currentFile && currentImageUrl ? (
               <img 
                 src={currentImageUrl} 
                 className="max-h-full max-w-full object-contain shadow-lg pointer-events-none transition-transform duration-75"
                 style={{
                    transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                    transition: isDragging ? 'none' : 'transform 0.1s linear'
                 }}
                 alt="Frame"
                 draggable={false}
               />
           ) : currentFile ? (
               <div className="flex items-center justify-center">
                 <Loader2 className="animate-spin text-gray-400" size={32} />
               </div>
           ) : null}
        </div>

        {/* Bottom Control Bar */}
        <div className="h-28 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 flex items-center px-4 shrink-0 z-20">
            {/* Step Controls */}
            <div className="flex items-center space-x-2 mr-4 mb-2">
                <button onClick={handlePrev} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full text-gray-600 dark:text-gray-300" title={t('sequence.prev')}>
                    <ChevronLeft size={24} />
                </button>
                <button 
                    onClick={togglePlay} 
                    className="w-14 h-14 flex items-center justify-center bg-purple-600 hover:bg-purple-500 text-white rounded-full shadow-md transition-colors"
                    title={isPlaying ? t('sequence.pause') : t('sequence.play')}
                >
                    {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" className="ml-1" />}
                </button>
                <button onClick={handleNext} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full text-gray-600 dark:text-gray-300" title={t('sequence.next')}>
                    <ChevronRight size={24} />
                </button>
            </div>

            {/* Timeline Scrubbing */}
            <div className="flex-1 flex flex-col justify-center px-6 relative h-16 mt-2">
                <div className="relative w-full h-full flex items-center">
                    
                    {/* Ticks and Labels Layer */}
                    <div className="absolute left-0 right-0 h-10 pointer-events-none -mt-6">
                        {ticks.map(tick => {
                            const leftPct = (tick.index / Math.max(1, totalFrames - 1)) * 100;
                            const isMajor = tick.type === 'major';
                            return (
                                <div 
                                    key={tick.index} 
                                    className="absolute bottom-0 flex flex-col items-center justify-end transform -translate-x-1/2 transition-opacity"
                                    style={{ left: `${leftPct}%` }}
                                >
                                    {/* Label */}
                                    <span className={`font-mono mb-1 select-none ${
                                        isMajor 
                                            ? 'text-sm font-bold text-gray-900 dark:text-gray-100' 
                                            : 'text-[10px] font-medium text-gray-400 dark:text-gray-500'
                                    }`}>
                                        {tick.label}
                                    </span>
                                    {/* Tick Mark */}
                                    <div className={`w-px ${
                                        isMajor 
                                            ? 'h-3 bg-gray-800 dark:bg-gray-200' 
                                            : 'h-2 bg-gray-300 dark:bg-gray-700'
                                    }`}></div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Track Line */}
                    <div className="absolute left-0 right-0 top-1/2 mt-4 h-1 bg-gray-200 dark:bg-gray-800 rounded-full pointer-events-none">
                         {/* Progress Fill */}
                         <div 
                            className="h-full bg-purple-500/50 rounded-full" 
                            style={{ width: `${(currentIndex / Math.max(1, totalFrames - 1)) * 100}%` }}
                         />
                    </div>

                    {/* Actual Input */}
                    <input 
                        type="range" 
                        min="0" 
                        max={Math.max(0, totalFrames - 1)} 
                        value={currentIndex} 
                        onChange={handleScrub}
                        className="w-full h-12 bg-transparent appearance-none cursor-pointer relative z-10 focus:outline-none translate-y-2
                        [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-0.5 [&::-webkit-slider-thumb]:h-0 [&::-webkit-slider-thumb]:bg-transparent"
                    />
                    
                    {/* Current Position Thumb Visual */}
                    <div 
                        className="absolute top-1/2 mt-4 w-4 h-4 bg-purple-600 rounded-full shadow border-2 border-white dark:border-gray-900 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20 transition-transform duration-75"
                        style={{ left: `${(currentIndex / Math.max(1, totalFrames - 1)) * 100}%` }}
                    ></div>
                </div>
            </div>

            {/* Frame Info */}
            <div className="flex flex-col items-center justify-center w-24 font-mono text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 py-1.5 px-3 rounded-md border border-gray-200 dark:border-gray-700 ml-4 mb-1">
                <span className="font-bold text-lg text-purple-600 dark:text-purple-400 leading-none">{currentIndex + 1}</span>
                <span className="text-[10px] text-gray-400 mt-0.5">/ {totalFrames}</span>
            </div>
        </div>
      </div>

      {/* Right Settings Panel */}
      <div className={`bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 flex flex-col shrink-0 transition-all duration-300 ${showDetails ? 'w-72 opacity-100 overflow-hidden' : 'w-0 opacity-0 overflow-hidden border-l-0'}`}>
         
         {/* Settings Header */}
         <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
            <h2 className="text-purple-500 font-bold text-xs uppercase tracking-wider mb-1 flex items-center">
               <Settings size={12} className="mr-1.5"/> {t('sequence.settings')}
            </h2>
         </div>

         <div className="flex-1 overflow-y-auto p-4 space-y-6">
             {/* FPS Control */}
             <div>
                 <div className="flex items-center text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider font-semibold mb-2">
                     <Clock size={12} className="mr-1.5" /> {t('sequence.fps')}
                 </div>
                 <div className="flex flex-wrap gap-2">
                     {[12, 24, 30, 60].map(val => (
                         <button
                            key={val}
                            onClick={() => setFps(val)}
                            className={`flex-1 py-1.5 px-3 rounded text-xs font-bold border transition-all ${
                                fps === val 
                                ? 'bg-purple-100 dark:bg-purple-900/30 border-purple-500 text-purple-600 dark:text-purple-300' 
                                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-purple-300'
                            }`}
                         >
                             {val} FPS
                         </button>
                     ))}
                 </div>
                 <div className="mt-2 flex items-center bg-gray-100 dark:bg-gray-800 p-2 rounded border border-transparent focus-within:border-purple-500 transition-colors">
                     <input 
                        type="number" 
                        value={fps} 
                        onChange={e => setFps(Math.max(1, parseInt(e.target.value) || 24))} 
                        className="w-16 bg-transparent text-sm font-bold text-center outline-none border-b border-gray-300 dark:border-gray-600 focus:border-purple-500 text-gray-800 dark:text-gray-200"
                     />
                     <span className="text-xs text-gray-500 ml-2">Custom FPS</span>
                 </div>
             </div>

             {/* Loop Mode */}
             <div>
                 <div className="flex items-center text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider font-semibold mb-2">
                     <Repeat size={12} className="mr-1.5" /> {t('sequence.loop')}
                 </div>
                 <div className="flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg border border-gray-200 dark:border-gray-700">
                     <button
                        onClick={() => setIsLooping(false)}
                        className={`flex-1 py-2 px-3 rounded text-xs font-medium flex items-center justify-center transition-all ${
                            !isLooping 
                            ? 'bg-white dark:bg-gray-700 shadow-sm text-gray-900 dark:text-white' 
                            : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                     >
                         <Repeat1 size={14} className="mr-1.5" /> {t('sequence.playOnce')}
                     </button>
                     <button
                        onClick={() => setIsLooping(true)}
                        className={`flex-1 py-2 px-3 rounded text-xs font-medium flex items-center justify-center transition-all ${
                            isLooping 
                            ? 'bg-white dark:bg-gray-700 shadow-sm text-gray-900 dark:text-white' 
                            : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                     >
                         <Repeat size={14} className="mr-1.5" /> {t('sequence.loop')}
                     </button>
                 </div>
             </div>

             {/* Folder Description */}
             <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
                 <div className="flex items-center text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider font-semibold mb-2">
                     <Info size={12} className="mr-1.5" /> {t('sequence.folderInfo')}
                 </div>
                 <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                     <h3 className="font-bold text-sm text-gray-800 dark:text-gray-200 mb-1">{folder.name}</h3>
                     {folder.description ? (
                         <p className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                             {folder.description}
                         </p>
                     ) : (
                         <p className="text-xs text-gray-400 italic">
                             {t('meta.description')}...
                         </p>
                     )}
                 </div>
             </div>
         </div>
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div 
          className="fixed bg-white dark:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[200px] z-[60] animate-zoom-in"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { togglePlay(); setContextMenu({...contextMenu, visible: false}); }}>
                {isPlaying ? <Pause size={14} className="mr-2"/> : <Play size={14} className="mr-2"/>} 
                {isPlaying ? t('sequence.pause') : t('sequence.play')}
            </div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleNext(); setContextMenu({...contextMenu, visible: false}); }}>
                <ChevronRight size={14} className="mr-2"/> {t('sequence.next')}
            </div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handlePrev(); setContextMenu({...contextMenu, visible: false}); }}>
                <ChevronLeft size={14} className="mr-2"/> {t('sequence.prev')}
            </div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleOriginal(); setContextMenu({...contextMenu, visible: false}); }}>
                <Maximize size={14} className="mr-2"/> {t('sequence.original')}
            </div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleReset(); setContextMenu({...contextMenu, visible: false}); }}>
                <Minimize size={14} className="mr-2"/> {t('sequence.fit')}
            </div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className="px-4 py-2 hover:bg-red-600 hover:text-white text-red-500 dark:text-red-400 cursor-pointer flex items-center" onClick={handleDeleteRequest}>
                <Trash2 size={14} className="mr-2"/> {t('context.delete')}
            </div>
        </div>
      )}

      {/* Context Menu Backdrop */}
      {contextMenu.visible && (
          <div className="fixed inset-0 z-[59]" onClick={() => setContextMenu({...contextMenu, visible: false})}></div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
          <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
              <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in">
                  <div className="flex items-center mb-4 text-orange-500">
                      <AlertTriangle className="mr-2" />
                      <h3 className="font-bold text-lg">{t('context.delete')}?</h3>
                  </div>
                  <p className="mb-6 text-gray-700 dark:text-gray-300 text-sm">
                      {t('sequence.deleteWarning')}
                  </p>
                  <div className="flex justify-end space-x-3">
                      <button 
                          onClick={() => setShowDeleteConfirm(false)} 
                          className="px-4 py-2 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                      >
                          {t('settings.cancel')}
                      </button>
                      <button 
                          onClick={handleDeleteConfirm} 
                          className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex items-center text-sm font-medium"
                      >
                          <Trash2 size={16} className="mr-2"/>
                          {t('sequence.confirmDelete')}
                      </button>
                  </div>
              </div>
          </div>
      )}

    </div>
  );
};
