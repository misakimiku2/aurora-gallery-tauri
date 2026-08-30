
import React, { useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { LayoutMode, FileNode, FileType, TabState, Person, GroupByOption, FileGroup, Topic, SortOption, SortDirection } from '../types';
import { getFolderPreviewImages, formatSize } from '../utils/mockFileSystem';
import { Image as ImageIcon, Check, Folder, Tag, User, ChevronDown, Book, Film } from 'lucide-react';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { PullToRefreshIndicator } from './PullToRefreshIndicator';
import md5 from 'md5';
import { startDragToExternal, setGlobalScrollState } from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useLayout, LayoutItem, GetFileNode } from './useLayoutHook';
import { PersonGrid } from './PersonGrid';
import { TagsList, TagIndexBar } from './TagsList';
import { performanceMonitor } from '../utils/performanceMonitor';
import { getGlobalCache, getThumbnailPathCache } from '../utils/thumbnailCache';
import { getThumbnailPrefetcher } from '../utils/thumbnailPrefetch';
import { getFolderThumbnailPrefetcher } from '../utils/folderThumbnailPrefetch';
import { throttle, debounce } from '../utils/debounce';
import { useInView } from '../hooks/useInView';
import { usePinchZoom } from '../hooks/usePinchZoom';
import { Folder3DIcon } from './Folder3DIcon';
import { ImageThumbnail } from './ImageThumbnail';
import { FolderThumbnail } from './FolderThumbnail';
import { InlineRenameInput } from './InlineRenameInput';
import { FileListItem } from './FileListItem';
import { CircularProgressOverlay } from './CircularProgressOverlay';
import MarqueeText from './MarqueeText';
import { lanNavStep, lanNavActive, lanNavId } from '../utils/lanNavTrace';
import { scrollProfiler } from '../utils/scrollProfiler';
import { nearestAndroidLevelIndex, getAndroidThumbnailPresets } from '../utils/androidThumbnailSizes';
import { onMultiTouch } from '../utils/touchGestureGuard';
import EmptyFolderPlaceholder from './EmptyFolderPlaceholder';

const sortKeys = (keys: string[]) => keys.sort((a, b) => {
    if (a === '#') return -1;
    if (b === '#') return 1;
    return a.localeCompare(b);
});

const FileCard = React.memo(({
  file,
  getFileNode,
  isSelected,
  renamingId,
  layoutMode,
  hoverPlayingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onSetHoverPlayingId,
  style,
  settings,
  resourceRoot,
  cachePath,
  selectedFileIds,
  onDragStart,
  onDragEnd,
  thumbnailSize,
  setIsDraggingInternal,
  setDraggedFilePaths,
  onFileLongPress,
  onShowContextMenuForFile,
  isAndroidSelectionMode,
  onAndroidRangeSelect
}: any) => {
  const [isDragging, setIsDragging] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const contextMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuTriggeredRef = useRef(false);
  const rangeSelectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rangeSelectTriggeredRef = useRef(false);
  const animShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showContextMenuAnim, setShowContextMenuAnim] = useState(false);
  const [contextMenuAnimPos, setContextMenuAnimPos] = useState({ x: 0, y: 0 });

  const androidDevice = (resourceRoot || settings?.paths?.resourceRoot) === 'android_media_store';

  const clearAllTimers = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (contextMenuTimerRef.current) {
      clearTimeout(contextMenuTimerRef.current);
      contextMenuTimerRef.current = null;
    }
    if (rangeSelectTimerRef.current) {
      clearTimeout(rangeSelectTimerRef.current);
      rangeSelectTimerRef.current = null;
    }
    if (animShowTimerRef.current) {
      clearTimeout(animShowTimerRef.current);
      animShowTimerRef.current = null;
    }
    setShowContextMenuAnim(false);
  }, []);

  // 多指守护：第二根手指落下（双指捏合）时立即取消本卡片的长按等定时器
  useEffect(() => {
    if (!androidDevice) return undefined;
    return onMultiTouch(clearAllTimers);
  }, [androidDevice, clearAllTimers]);

  if (!file) return null;

  // Extract layout positioning
  const { x, y, width, height } = style || { x: 0, y: 0, width: 200, height: 200 };
  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  const isAndroid = effectiveResourceRoot === 'android_media_store';

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    
    // 未选中的文件在拖拽前先选中它
    if (!isSelected) {
      onFileClick(e, file.id);
    }
    
    // 确定拖拽文件：已多选时拖拽全部选中文件，否则只拖拽当前文件
    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
      ? selectedFileIds 
      : [file.id];
    
    // 获取要拖拽文件的实际路径
    const filePaths = filesToDrag.map((fileId: string) => getFileNode(fileId)?.path || '').filter(Boolean);
    
    // 标记为内部拖拽
    if (setIsDraggingInternal && setDraggedFilePaths) {
      setIsDraggingInternal(true);
      setDraggedFilePaths(filePaths);
    }
    
    // 设置拖拽数据
    try {
      // 1. 使用 JSON 格式传递内部拖拽数据
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        internalDrag: true // 标记为内部拖拽
      }));
      
      // 2. 使用 text/uri-list 格式传递（供外部程序识别）
      const uriList = filePaths.map((path: string) => `file://${path.replace(/\\/g, '/')}`).join('\n');
      e.dataTransfer.setData('text/uri-list', uriList);
      
      // 3. 使用纯文本格式传递（用于显示拖拽数量）
      const textData = `${filesToDrag.length} file${filesToDrag.length > 1 ? 's' : ''} selected`;
      e.dataTransfer.setData('text/plain', textData);
      
      // 设置拖拽效果
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (error) {
      // Error handling for drag data setup
    }
    
    // 创建拖拽预览图片
    // 主缩略图尺寸范围：100px-480px
    // 拖拽缩略图大小范围：100px-380px
    // 线性映射：dragThumbSize = 100 + (mainThumbSize - 100) * (280 / 380)
    const mainThumbSize = thumbnailSize; // 主缩略图尺寸
    const minMainSize = 100;
    const maxMainSize = 480;
    const minDragSize = 100;
    const maxDragSize = 380;
    
    // 按比例映射计算拖拽缩略图尺寸
    const dragThumbSize = Math.min(maxDragSize, Math.max(minDragSize, 
        minDragSize + (mainThumbSize - minMainSize) * ((maxDragSize - minDragSize) / (maxMainSize - minMainSize))
    ));
    
    // 拖拽时动态创建 DOM 元素作为拖拽预览
    // 使用 DOM 元素绘制拖拽预览（兼容性更好）
    const dragImageContainer = document.createElement('div');
    dragImageContainer.style.position = 'absolute';
    dragImageContainer.style.left = '-9999px';
    dragImageContainer.style.top = '-9999px';
    dragImageContainer.style.pointerEvents = 'none';
    dragImageContainer.style.zIndex = '9999';
    dragImageContainer.style.width = `${dragThumbSize}px`;
    dragImageContainer.style.height = `${dragThumbSize}px`;
    dragImageContainer.style.display = 'flex';
    dragImageContainer.style.alignItems = 'center';
    dragImageContainer.style.justifyContent = 'center';
    dragImageContainer.style.borderRadius = '8px';
    dragImageContainer.style.background = 'transparent';
    dragImageContainer.style.boxShadow = 'none';
    dragImageContainer.style.padding = '0px';
    
    // 获取全局缓存
    const cache = getGlobalCache();
    
    // 创建缩略图容器
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.position = 'relative';
    thumbnailsContainer.style.width = '100%';
    thumbnailsContainer.style.height = '100%';
    thumbnailsContainer.style.display = 'flex';
    thumbnailsContainer.style.alignItems = 'center';
    thumbnailsContainer.style.justifyContent = 'center';
    
    // 最多预览 3 张图片
    const previewCount = Math.min(filesToDrag.length, 3);
    
    // 确定拖拽文件的预览列表（只显示部分文件）
    // 1. 优先显示当前拖拽的文件
    // 2. 再显示其他选中的文件（最多 3 个）
    const previewFiles: string[] = [];
    
    // 确保当前拖拽文件在预览中
    previewFiles.push(file.id);
    
    // 补充其他选中的文件直到达到预览上限
    for (const fileId of filesToDrag) {
      if (fileId !== file.id && previewFiles.length < previewCount) {
        previewFiles.push(fileId);
      }
    }
    
    // 为每个预览文件创建缩略图
    for (let i = 0; i < previewFiles.length; i++) {
      const draggedFileId = previewFiles[i];
      const draggedFile = getFileNode(draggedFileId);
      if (!draggedFile) continue;
      
      // 获取缓存缩略图
      const cachedThumb = draggedFile.type === FileType.IMAGE ? cache.get(draggedFile.path) : null;
      
      // 计算单个缩略图尺寸（基于拖拽缩略图大小）
      // 单个缩略图尺寸约为拖拽图的 75%~90%，确保内部完整显示图片
      const singleThumbSize = dragThumbSize * 0.9; // 单个缩略图大小为主拖拽图的 90%
      
      // 创建缩略图元素
      const thumbElement = document.createElement('div');
      thumbElement.style.position = 'absolute';
      thumbElement.style.width = `${singleThumbSize}px`;
      thumbElement.style.height = `${singleThumbSize}px`;
      thumbElement.style.borderRadius = '8px';
      thumbElement.style.background = 'transparent';
      thumbElement.style.border = '2px solid rgba(255, 255, 255, 0.4)';
      thumbElement.style.display = 'flex';
      thumbElement.style.alignItems = 'center';
      thumbElement.style.justifyContent = 'center';
      thumbElement.style.overflow = 'hidden';
      
      // 设置 z-index 确保拖拽文件显示在最前
      thumbElement.style.zIndex = `${previewCount - i}`;
      
      // 设置位置偏移与旋转（使用 CSS 变换）
      const rotation = i === 0 ? 0 : (i === 1 ? -8 : 8);
      // 偏移量随缩略图尺寸缩放
      const offsetScale = singleThumbSize / 150; // 以 150px 为标准缩放比例
      const offsetX = i === 0 ? 0 : (i === 1 ? -10 * offsetScale : 10 * offsetScale);
      const offsetY = i * 12 * offsetScale;
      thumbElement.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`;
      
      // 有缓存缩略图时填充图片
      if (cachedThumb) {
        // 使用缓存图片 URL
        const img = document.createElement('img');
        img.src = cachedThumb;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.objectPosition = 'center';
        img.draggable = false;
        thumbElement.appendChild(img);
      } else {
        // 无缓存时使用占位图
        if (draggedFile.type === FileType.IMAGE) {
          // 图片占位??
          thumbElement.innerHTML = `<div style="font-size: 32px;">????/div>`;
        } else if (draggedFile.type === FileType.FOLDER) {
          const folderColor = draggedFile.category === 'book' ? '#f59e0b' : 
                             draggedFile.category === 'sequence' ? '#a855f7' : 
                             '#3b82f6';
          const folderFrontColor = draggedFile.category === 'book' ? '#d97706' : 
                                  draggedFile.category === 'sequence' ? '#9333ea' : 
                                  '#2563eb';
          const innerIconPath = draggedFile.category === 'book' 
            ? 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20' 
            : (draggedFile.category === 'sequence' 
               ? 'M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2' 
               : 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z');
          
          thumbElement.innerHTML = `
            <div style="width: 100%; height: 100%; position: relative;">
              <!-- Back Plate -->
              <svg viewBox="0 0 100 100" style="position: absolute; width: 100%; height: 100%; fill: ${folderColor}; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));" preserveAspectRatio="none">
                <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" />
              </svg>
              
              <!-- Front Plate -->
              <div style="position: absolute; left: 0; right: 0; bottom: 0; height: 60%; transform: perspective(800px) rotateX(-10deg);">
                <svg viewBox="0 0 100 65" style="width: 100%; height: 100%; fill: ${folderFrontColor}; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.15));" preserveAspectRatio="none">
                  <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" />
                </svg>
                
                <!-- Folder Icon -->
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0.5; mix-blend-mode: overlay;">
                  <svg viewBox="0 0 24 24" style="width: 32px; height: 32px; fill: white; stroke: white; stroke-width: 1.5;" preserveAspectRatio="xMidYMid meet">
                    <path d="${innerIconPath}" />
                  </svg>
                </div>
              </div>
            </div>
          `;
        } else {
          // 其他类型文件的占位图
          thumbElement.innerHTML = `<div style="font-size: 32px;">??</div>`;
        }
      }
      
      thumbnailsContainer.appendChild(thumbElement);
    }
    
    // 拖拽文件超过 3 个时显示数量徽标
    if (filesToDrag.length > 3) {
      const count = filesToDrag.length - 3;
      const countBadge = document.createElement('div');
      countBadge.style.position = 'absolute';
      // 徽标位置随拖拽图尺寸缩放
      const badgeSize = 40 * (dragThumbSize / 200); // 以 200px 为基准：40px 徽标随尺寸缩放
      countBadge.style.right = `${12 * (dragThumbSize / 200)}px`;
      countBadge.style.bottom = `${12 * (dragThumbSize / 200)}px`;
      countBadge.style.width = `${badgeSize}px`;
      countBadge.style.height = `${badgeSize}px`;
      countBadge.style.borderRadius = '50%';
      countBadge.style.background = '#2563eb';
      countBadge.style.color = 'white';
      countBadge.style.display = 'flex';
      countBadge.style.alignItems = 'center';
      countBadge.style.justifyContent = 'center';
      countBadge.style.font = `bold ${14 * (dragThumbSize / 200)}px Arial, sans-serif`;
      countBadge.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
      countBadge.textContent = `+${count}`;
      thumbnailsContainer.appendChild(countBadge);
    }
    
    // 将预览容器挂载到页面
    dragImageContainer.appendChild(thumbnailsContainer);
    document.body.appendChild(dragImageContainer);
    
    // 设置拖拽预览图
    try {
      // 拖拽图片偏移为中心，使鼠标指针位于图片中心
      const dragOffset = dragThumbSize / 2;
      e.dataTransfer.setDragImage(dragImageContainer, dragOffset, dragOffset);
    } catch (error) {
      // Error handling for drag image setup
    }
    
    // 设置拖拽效果为 move（内部拖拽）
    e.dataTransfer.effectAllowed = 'move';
    
    // 获取要拖拽文件的实际路径
    const draggedFiles = filesToDrag.map((fileId: string) => getFileNode(fileId)).filter((Boolean as unknown) as (file: FileNode | undefined) => file is FileNode);
    const draggedFilePaths = draggedFiles.map((file: FileNode) => file.path);
    
    // 标记为内部拖拽
    if (setIsDraggingInternal) {
      setIsDraggingInternal(true);
    }
    
    // 设置拖拽文件路径
    if (setDraggedFilePaths) {
      setDraggedFilePaths(draggedFilePaths);
    }
    
    try {
      // 使用 JSON 格式传递内部拖拽数据
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        // 标记为内部拖拽
        internalDrag: true
      }));
      
      // 提供外部拖拽数据（供外部程序使用）
      // 外部拖拽场景无需额外设置
    } catch (error) {
      console.error('Drag data setup error:', error);
    }
    
    // 通知父组件拖拽开始
    if (onDragStart) {
      onDragStart(filesToDrag);
    }
    
    // 拖拽结束后清理临时元素
    const cleanupDragImage = () => {
      if (dragImageContainer.parentNode) {
        dragImageContainer.parentNode.removeChild(dragImageContainer);
      }
      document.removeEventListener('dragend', cleanupDragImage);
      document.removeEventListener('dragleave', cleanupDragImage);
    };
    
    document.addEventListener('dragend', cleanupDragImage);
    document.addEventListener('dragleave', cleanupDragImage);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragging(false);
    
    // 清除内部拖拽状态
    if (setIsDraggingInternal) {
      setIsDraggingInternal(false);
    }
    
    if (onDragEnd) {
      onDragEnd();
    }
  };

  return (
    <div
        data-id={file.id}
        className={`
            file-item group cursor-pointer flex flex-col items-center rounded-xl
            ${isSelected ? 'z-10' : 'z-0 hover:scale-[1.01]'}
            ${isDragging ? 'opacity-50 scale-95 drop-shadow-lg' : ''}
        `}
        style={{
            position: 'absolute',
            transform: `translate(${x}px, ${y}px)`,
            width: `${width}px`,
            height: `${height}px`,
            transition: isDragging ? 'none' : 'transform 300ms ease-out',
            ...(!isAndroid && {
              contentVisibility: 'auto' as const,
              containIntrinsicSize: `${width}px ${height}px`
            })
        }}
        draggable={!isAndroid && renamingId !== file.id}
        onDragStart={isAndroid ? undefined : handleDragStart}
        onDragEnd={isAndroid ? undefined : handleDragEnd}
        onMouseDown={isAndroid ? undefined : async (e) => {
            if (e.button === 0) {
                e.stopPropagation();
                
                // 按住 Alt 键时启动外部拖拽（拖到外部应用）
                if (e.altKey && isTauriEnvironment()) {
                    e.preventDefault();
                    
                    // 获取要拖拽的文件
                    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
                        ? selectedFileIds 
                        : [file.id];
                    
                    // 获取要拖拽文件的实际路径
                    const filePaths = filesToDrag
                        .map((fileId: string) => getFileNode(fileId)?.path || '')
                        .filter(Boolean);
                    
                    if (filePaths.length > 0) {
                        setIsDragging(true);
                        
                        // 同步内部拖拽状态
                        if (setIsDraggingInternal) {
                            setIsDraggingInternal(true);
                        }
                        
                        // 获取缩略图路径（供外部拖拽使用）
                        const pathCache = getThumbnailPathCache();
                        const thumbnailPaths = filePaths
                            .slice(0, 3)
                            .map((fp: string) => pathCache.get(fp))
                            .filter((p: string | undefined): p is string => !!p);
                        
                        // 计算缓存目录
                        const cacheDir = effectiveResourceRoot 
                            ? `${effectiveResourceRoot}${effectiveResourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache`
                            : undefined;
                        
                        try {
                            await startDragToExternal(filePaths, thumbnailPaths, cacheDir, () => {
                                setIsDragging(false);
                                if (setIsDraggingInternal) {
                                    setIsDraggingInternal(false);
                                }
                            });
                        } catch (error) {
                            console.error('External drag failed:', error);
                            setIsDragging(false);
                            if (setIsDraggingInternal) {
                                setIsDraggingInternal(false);
                            }
                        }
                    }
                }
            }
        }}
        onClick={(e) => {
            e.stopPropagation();
            if (isAndroid && longPressTriggeredRef.current) {
              longPressTriggeredRef.current = false;
              return;
            }
            if (isAndroid && contextMenuTriggeredRef.current) {
              contextMenuTriggeredRef.current = false;
              return;
            }
            if (isAndroid && rangeSelectTriggeredRef.current) {
              rangeSelectTriggeredRef.current = false;
              return;
            }
            onFileClick(e, file.id);
        }}
        onDoubleClick={isAndroid && selectedFileIds && selectedFileIds.length > 0 ? undefined : ((e) => {
            e.stopPropagation();
            onFileDoubleClick(file.id);
        })}
        onContextMenu={isAndroid ? undefined : ((e: React.MouseEvent) => onContextMenu(e, file.id))}
        onTouchStart={isAndroid ? ((e: React.TouchEvent) => {
            // 多指（双指捏合）不进入长按/选择逻辑
            if (e.touches.length > 1) {
                clearAllTimers();
                return;
            }
            longPressTriggeredRef.current = false;
            contextMenuTriggeredRef.current = false;
            rangeSelectTriggeredRef.current = false;
            const touchX = e.touches[0].clientX;
            const touchY = e.touches[0].clientY;
            touchStartPosRef.current = { x: touchX, y: touchY };
            if (isSelected && selectedFileIds && selectedFileIds.length > 0) {
                animShowTimerRef.current = setTimeout(() => {
                    setContextMenuAnimPos({ x: touchX, y: touchY });
                    setShowContextMenuAnim(true);
                }, 150);
                contextMenuTimerRef.current = setTimeout(() => {
                    contextMenuTriggeredRef.current = true;
                    if (onShowContextMenuForFile) {
                        onShowContextMenuForFile(file.id, touchX, touchY);
                    }
                    requestAnimationFrame(() => {
                        setShowContextMenuAnim(false);
                    });
                }, 500);
            } else if (isAndroidSelectionMode && !isSelected) {
                animShowTimerRef.current = setTimeout(() => {
                    setContextMenuAnimPos({ x: touchX, y: touchY });
                    setShowContextMenuAnim(true);
                }, 150);
                rangeSelectTimerRef.current = setTimeout(() => {
                    rangeSelectTriggeredRef.current = true;
                    if (onAndroidRangeSelect) {
                        onAndroidRangeSelect(file.id);
                    }
                    requestAnimationFrame(() => {
                        setShowContextMenuAnim(false);
                    });
                }, 500);
            } else {
                longPressTimerRef.current = setTimeout(() => {
                    longPressTriggeredRef.current = true;
                    if (onFileLongPress) onFileLongPress(file.id);
                }, 500);
            }
        }) : undefined}
        onTouchMove={isAndroid ? ((e: React.TouchEvent) => {
            if (!touchStartPosRef.current) return;
            const dx = Math.abs(e.touches[0].clientX - touchStartPosRef.current.x);
            const dy = Math.abs(e.touches[0].clientY - touchStartPosRef.current.y);
            if (dx > 10 || dy > 10) {
                if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current);
                    longPressTimerRef.current = null;
                }
                if (contextMenuTimerRef.current) {
                    clearTimeout(contextMenuTimerRef.current);
                    contextMenuTimerRef.current = null;
                }
                if (rangeSelectTimerRef.current) {
                    clearTimeout(rangeSelectTimerRef.current);
                    rangeSelectTimerRef.current = null;
                }
                if (animShowTimerRef.current) {
                    clearTimeout(animShowTimerRef.current);
                    animShowTimerRef.current = null;
                }
                setShowContextMenuAnim(false);
            }
        }) : undefined}
        onTouchEnd={isAndroid ? (() => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
            }
            if (contextMenuTimerRef.current) {
                clearTimeout(contextMenuTimerRef.current);
                contextMenuTimerRef.current = null;
            }
            if (rangeSelectTimerRef.current) {
                clearTimeout(rangeSelectTimerRef.current);
                rangeSelectTimerRef.current = null;
            }
            if (animShowTimerRef.current) {
                clearTimeout(animShowTimerRef.current);
                animShowTimerRef.current = null;
            }
            setShowContextMenuAnim(false);
        }) : undefined}
        onMouseEnter={!isAndroid ? (() => {
            const fileName = file.name;
            const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
            const isAnimationFormat = (file.meta?.format === 'gif' || file.meta?.format === 'webp') || (fileExt === 'gif' || fileExt === 'webp');
            
            if (settings?.animateOnHover && isAnimationFormat) {
                onSetHoverPlayingId(file.id);
            }
        }) : undefined}
        onMouseLeave={!isAndroid ? (() => {
            onSetHoverPlayingId(null);
        }) : undefined}>
        <div
            className={`
                w-full flex-1 rounded-xl overflow-hidden relative transition-shadow transition-transform duration-300
                ${isSelected ? 'bg-blue-100 dark:bg-blue-500/10 shadow-[0_4px_6px_-1px_rgba(59,130,246,0.2)] dark:shadow-[0_4px_6px_-1px_rgba(59,130,246,0.3)] after:absolute after:inset-0 after:rounded-xl after:border-[3px] after:border-blue-400 dark:after:border-blue-500 after:pointer-events-none after:z-10' : isDragging ? 'border-2 border-dashed border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'bg-surface'}
            `}
            style={{ height: height ? (height - 40) : '100%' }}
        >
            {file.type === FileType.FOLDER ? (
            <FolderThumbnail file={file} getFileNode={getFileNode} mode={layoutMode} resourceRoot={effectiveResourceRoot} cachePath={effectiveCachePath} folderIconStyle={settings?.folderIconStyle} />
            ) : (
            <ImageThumbnail
                src={''}
                alt={file.name}
                isSelected={isSelected}
                filePath={file.path}
                modified={file.updatedAt}
                size={file.size}
                isHovering={(() => {
                    if (isAndroid) {
                        if (!settings?.animateOnHover || !isAndroidSelectionMode || !isSelected) return false;
                        const ext = file.name.substring(file.name.lastIndexOf('.') + 1).toLowerCase();
                        const isAnim = (file.meta?.format === 'gif' || file.meta?.format === 'webp') || (ext === 'gif' || ext === 'webp');
                        return isAnim;
                    }
                    return hoverPlayingId === file.id;
                })()}
                fileMeta={file.meta}
                resourceRoot={effectiveResourceRoot}
                cachePath={effectiveCachePath}
                mediaStoreId={file.mediaStoreId}
            />
            )}

            <div className={`absolute top-2 left-2 z-20 transition-opacity duration-200 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                {isSelected ? (
                    <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center border-2 border-white shadow-lg ring-2 ring-blue-400/50">
                    <Check size={14} className="text-white" strokeWidth={3} />
                    </div>
                ) : (
                    <div className="w-5 h-5 bg-black/30 hover:bg-black/50 rounded-full border border-white/50 backdrop-blur-sm"></div>
                )}
            </div>

            <div className="absolute bottom-1 right-1 flex space-x-1 pointer-events-none">
            {file.type === FileType.IMAGE && (file.meta?.format === 'gif' || file.meta?.format === 'webp') && (
                <span className="text-[9px] font-bold bg-black/60 text-white px-1 rounded shadow-sm">{file.meta.format.toUpperCase()}</span>
            )}
            </div>
        </div>
        
        <div className="mt-1.5 w-full text-center px-1 h-8 flex flex-col justify-start leading-tight">
            {renamingId === file.id ? (
            <InlineRenameInput
                defaultValue={file.name}
                onCommit={(val: string) => onRenameSubmit(val, file.id)}
                onCancel={onRenameCancel}
            />
            ) : (
            <div
                className={`inline-block max-w-full self-center text-center px-2 py-0.5 rounded-md text-xs font-semibold leading-tight transition-colors duration-300 ${
                    isSelected
                    ? 'bg-[#2563EB] text-white'
                    : 'text-gray-700 dark:text-gray-300'
                }`}
                onDoubleClick={(e) => {
                e.stopPropagation();
                onStartRename(file.id);
                }}
            >
                <MarqueeText active={isSelected} title={file.name}>{file.name}</MarqueeText>
                {file.type === FileType.IMAGE && (
                <div className={`text-[9px] font-normal truncate mt-0.5 ${isSelected ? 'text-white/90' : 'text-gray-400 dark:text-gray-500'}`}>
                  {file.meta ? `${file.meta.width || 0}x${file.meta.height || 0}` : ''}
                </div>
                )}
            </div>
        )}
        </div>
        {isAndroid && showContextMenuAnim && (
            <CircularProgressOverlay
                x={contextMenuAnimPos.x}
                y={contextMenuAnimPos.y}
                duration={350}
            />
        )}
    </div>
  );
});

const GroupContent = React.memo(({
  group,
  getFileNode,
  activeTab,
  renamingId,
  thumbnailSize,
  hoverPlayingId,
  handleFileClick,
  handleFileDoubleClick,
  handleContextMenu,
  handleStartRename,
  handleRenameSubmit,
  handleRenameCancel,
  handleSetHoverPlayingId,
  settings,
  containerRect,
  scrollTop, // 接收父级滚动位置
  t,
  resourceRoot,
  cachePath,
  onDragStart,
  onDragEnd,
  setIsDraggingInternal,
  setDraggedFilePaths,
  onFileLongPress,
  onShowContextMenuForFile,
  isAndroidSelectionMode,
  onAndroidRangeSelect
}: any) => {
  const groupRef = useRef<HTMLDivElement>(null);
  const [offsetTop, setOffsetTop] = useState(0);

  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  
  // Calculate layout for this group
  const { layout, totalHeight } = useLayout(
    group.fileIds,
    getFileNode,
    activeTab.layoutMode,
    containerRect.width,
    thumbnailSize,
    'browser'
  );

  // 测量分组相对于容器顶部的偏移，用于内部虚拟滚动过滤
  useLayoutEffect(() => {
      if (groupRef.current) {
          setOffsetTop(groupRef.current.offsetTop);
      }
  }, [layout, containerRect.width]);

  // 根据全局滚动位置，动态计算当前分组内容中可见的项目
  const visibleItems = useMemo(() => {
      const buffer = 400;
      const minY = (scrollTop || 0) - offsetTop - buffer;
      const maxY = (scrollTop || 0) - offsetTop + (containerRect.height || 0) + buffer;
      
      return layout.filter(item => item.y < maxY && item.y + item.height > minY);
  }, [layout, scrollTop, offsetTop, containerRect.height]);

  return (
    <div ref={groupRef}>
      {activeTab.layoutMode === 'list' ? (
        // 列表布局：以前是一次性渲染，现在支持绝对定位虚拟滚动
        <div className="relative w-full overflow-hidden" style={{ height: totalHeight }}>
          {visibleItems.map((item) => {
            const file = getFileNode(item.id);
            if (!file) return null;
            return (
              <div 
                key={file.id} 
                className="absolute"
                style={{ 
                    transform: `translate(${item.x}px, ${item.y}px)`,
                    width: item.width, 
                    height: item.height 
                }}
              >
                  <FileListItem
                      file={file}
                      getFileNode={getFileNode}
                      isSelected={activeTab.selectedFileIds.includes(file.id)}
                      renamingId={renamingId}
                      onFileClick={handleFileClick}
                      onFileDoubleClick={handleFileDoubleClick}
                      onContextMenu={handleContextMenu}
                      onStartRename={handleStartRename}
                      onRenameSubmit={handleRenameSubmit}
                      onRenameCancel={handleRenameCancel}
                      t={t}
                      resourceRoot={effectiveResourceRoot}
                      cachePath={effectiveCachePath}
                      selectedFileIds={activeTab.selectedFileIds}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      thumbnailSize={thumbnailSize}
                      setIsDraggingInternal={setIsDraggingInternal}
                      setDraggedFilePaths={setDraggedFilePaths}
                      onFileLongPress={onFileLongPress}
                      onShowContextMenuForFile={onShowContextMenuForFile}
                      isAndroidSelectionMode={isAndroidSelectionMode}
                      onAndroidRangeSelect={onAndroidRangeSelect}
                  />
              </div>
            );
          })}
        </div>
      ) : (
        // Grid, adaptive, or masonry layout - 使用虚拟滚动过滤
        // No outer padding here because the layout worker already includes internal padding
        <div 
          className="relative" 
          style={{ 
            width: '100%', 
            height: totalHeight 
          }}
        >
          {visibleItems.map((item) => {
            const file = getFileNode(item.id);
            if (!file) return null;
            
            return (
              <FileCard
                key={file.id}
                file={file}
                getFileNode={getFileNode}
                isSelected={activeTab.selectedFileIds.includes(file.id)}
                renamingId={renamingId}
                layoutMode={activeTab.layoutMode}
                hoverPlayingId={hoverPlayingId}
                onFileClick={handleFileClick}
                onFileDoubleClick={handleFileDoubleClick}
                onContextMenu={handleContextMenu}
                onStartRename={handleStartRename}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={handleRenameCancel}
                onSetHoverPlayingId={handleSetHoverPlayingId}
                settings={settings}
                style={item}
                resourceRoot={effectiveResourceRoot}
                cachePath={effectiveCachePath}
                selectedFileIds={activeTab.selectedFileIds}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                thumbnailSize={thumbnailSize}
                setIsDraggingInternal={setIsDraggingInternal}
                setDraggedFilePaths={setDraggedFilePaths}
                onFileLongPress={onFileLongPress}
                onShowContextMenuForFile={onShowContextMenuForFile}
                isAndroidSelectionMode={isAndroidSelectionMode}
                onAndroidRangeSelect={onAndroidRangeSelect}
            />
            );
          })}
        </div>
      )}
    </div>
  );
});

const GroupHeader = React.memo(({ group, collapsed, onToggle }: { group: FileGroup, collapsed: boolean, onToggle: (id: string) => void }) => {
  return (
    <div 
      className="flex items-center py-2 px-4 bg-content/80 backdrop-blur-sm border-b border-subtle cursor-pointer select-none hover:bg-surface transition-colors sticky top-0 z-20"
      onClick={() => onToggle(group.id)}
    >
      <div className={`mr-2 p-1 rounded-full transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}>
        <ChevronDown size={16} className="text-gray-500" />
      </div>
      <span className="font-bold text-sm text-gray-700 dark:text-gray-200">{group.title}</span>
      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 bg-surface px-2 py-0.5 rounded-full">{group.fileIds.length}</span>
    </div>
  );
});

// removed local useLayout
// import { useLayout } from './useLayoutHook';
// interface LayoutItem was imported from useLayoutHook



interface FileGridProps {
  displayFileIds: string[];
  getFileNode: GetFileNode;
  // files 仅在 tags-overview / people-overview 视图下需要（TagsList 用 Object.values 遍历全部）。
  // browser 模式下传 undefined，避免 state.files 引用变化触发 FileGrid 重渲染。
  files?: Record<string, FileNode>;
  activeTab: TabState;
  renamingId: string | null;
  thumbnailSize: number;
  hoverPlayingId: string | null;
  onSetHoverPlayingId: (id: string | null) => void;
  onFileClick: (e: React.MouseEvent, id: string) => void;
  onFileDoubleClick: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onRenameSubmit: (val: string, id: string) => void;
  onRenameCancel: () => void;
  onStartRename: (id: string) => void;
  containerRef?: React.RefObject<HTMLDivElement>;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseMove?: (e: React.MouseEvent) => void;
  onMouseUp?: (e: React.MouseEvent) => void;
  onBackgroundContextMenu?: (e: React.MouseEvent) => void;
  people?: Record<string, Person>;
  topics?: Record<string, Topic>;
  groupedTags?: Record<string, string[]>;
  onPersonClick?: (id: string, e: React.MouseEvent) => void;
  onPersonContextMenu?: (e: React.MouseEvent, id: string) => void;
  onPersonDoubleClick?: (id: string) => void;
  onStartRenamePerson?: (personId: string) => void;
  onTagClick?: (tag: string, e: React.MouseEvent) => void;
  onTagContextMenu?: (e: React.MouseEvent, tag: string) => void;
  onTagDoubleClick?: (tag: string) => void;
  groupedFiles?: FileGroup[];
  groupBy?: GroupByOption;
  collapsedGroups?: Record<string, boolean>;
  onToggleGroup?: (id: string) => void;
  isSelecting?: boolean;
  marqueeOverlayRef?: React.MutableRefObject<HTMLDivElement | null>;
  layoutItemsRef?: React.MutableRefObject<import('../hooks/useMarqueeSelection').LayoutItem[]>;
  t: (key: string) => string;
  onThumbnailSizeChange?: (size: number) => void;
  onUpdateFile?: (id: string, updates: Partial<FileNode>) => void;
  settings?: import('../types').AppSettings;
  resourceRoot?: string;
  cachePath?: string;
  onScrollTopChange?: (scrollTop: number) => void;
  onScroll?: () => void;
  onDragStart?: (ids: string[]) => void;
  onDragEnd?: () => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  isDraggingOver?: boolean;
  dragOverTarget?: string | null;
  // New props for external drag handling
  isDraggingInternal?: boolean;
  setIsDraggingInternal?: (isDragging: boolean) => void;
  setDraggedFilePaths?: (paths: string[]) => void;
  draggedFileIds?: string[];
  isVisible?: boolean;
  onConsumeScrollToItem?: () => void;
  onFileLongPress?: (id: string) => void;
  onShowContextMenuForFile?: (id: string, x: number, y: number) => void;
  isAndroidSelectionMode?: boolean;
  onAndroidRangeSelect?: (id: string) => void;
  // People view sort and group
  personSortBy?: import('../types').PersonSortOption;
  personSortDirection?: import('../types').SortDirection;
  personGroupBy?: import('../types').PersonGroupByOption;
  onRefresh?: () => Promise<void>;
  panelWidthRem?: number;
  // Sort option/direction for file list (used to detect sort changes and avoid
  // FLIP anchor logic jumping to a random place after reordering)
  sortBy?: SortOption;
  sortDirection?: SortDirection;
}

export const FileGrid = React.memo(({
  displayFileIds,
  getFileNode,
  files,
  activeTab,
  renamingId,
  thumbnailSize,
  resourceRoot,
  cachePath,
  hoverPlayingId,
  onSetHoverPlayingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
  onStartRename,
  containerRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onBackgroundContextMenu,
  people,
  topics,
  groupedTags,
  onPersonClick,
  onPersonContextMenu,
  onPersonDoubleClick,
  onStartRenamePerson,
  onTagClick,
  onTagContextMenu,
  onTagDoubleClick,
  groupedFiles = [],
  groupBy = 'none',
  collapsedGroups = {},
  onToggleGroup,
  isSelecting,
  marqueeOverlayRef,
  layoutItemsRef,
  t,
  onThumbnailSizeChange,
  onUpdateFile,
  settings,
  onScrollTopChange,
  onScroll,
  onDragStart,
  onDragEnd,
  onDropOnFolder,
  isDraggingOver,
  dragOverTarget,
  isDraggingInternal,
  setIsDraggingInternal,
  setDraggedFilePaths,
  draggedFileIds,
  isVisible = true,
  onConsumeScrollToItem,
  onFileLongPress,
  onShowContextMenuForFile,
  isAndroidSelectionMode,
  onAndroidRangeSelect,
  // People view sort and group
  personSortBy = 'count',
  personSortDirection = 'desc',
  personGroupBy = 'none',
  onRefresh,
  panelWidthRem,
  sortBy = 'name',
  sortDirection = 'asc',
}: FileGridProps) => {
  // #region agent log
  // Removed debug logs
  // #endregion

  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  const isAndroid = effectiveResourceRoot === 'android_media_store';

  // 渲染计数（供滚动性能记录器统计滚动期间 FileGrid 的重渲染次数）
  const _perfWin = typeof window !== 'undefined' ? (window as any) : undefined;
  if (_perfWin) {
    _perfWin.__AURORA_RENDER_COUNTS__ = _perfWin.__AURORA_RENDER_COUNTS__ || {};
    _perfWin.__AURORA_RENDER_COUNTS__.fileGridRenders = (_perfWin.__AURORA_RENDER_COUNTS__.fileGridRenders || 0) + 1;
  }

  const contentRef = useRef<HTMLDivElement>(null);
  const pullDistanceRef = useRef(0);
  // Track the currently highlighted drop target and debounced RAF for safe DOM mutation
  const dragHoverRef = useRef<HTMLElement | null>(null);
  const dragHighlightRafRef = useRef<number | null>(null);

  // Deferred highlight helper: uses a single debounced RAF to apply dataset changes
  // OUTSIDE the drag event handler, preventing browser drag event re-evaluation cycles.
  const scheduleDragHighlight = (target: HTMLElement | null) => {
      if (dragHighlightRafRef.current !== null) {
          cancelAnimationFrame(dragHighlightRafRef.current);
      }
      dragHighlightRafRef.current = requestAnimationFrame(() => {
          dragHighlightRafRef.current = null;
          const prev = dragHoverRef.current;
          if (prev && prev !== target) {
              delete (prev as HTMLElement).dataset.dropTarget;
          }
          if (target) {
              (target as HTMLElement).dataset.dropTarget = 'true';
          }
          dragHoverRef.current = target;
      });
  };

  const {
    isRefreshing: isPullRefreshing,
    isComplete: isPullComplete,
  } = usePullToRefresh({
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
    contentRef,
    pullDistanceRef,
    onRefresh: onRefresh || (async () => {}),
    enabled: isAndroid,
  });

  const pinchStartSizeRef = useRef(thumbnailSize);
  // 安卓端手势级档位记录：一次捏合手势最多切换一档（小→中→大 逐级）
  const gestureStartLevelRef = useRef(-1);
  const gestureSteppedRef = useRef(false);
  // 捏合期间钉住滚动：快速捏合时第一根手指可能已经触发原生滚动（preventDefault 被忽略），
  // 该 ref 保证手势期间 scrollTop 稳定，避免 FLIP 与滚动赛跑导致动画错乱/硬切。
  const pinchScrollPinRef = useRef<number | null>(null);
  // 宽度 FLIP 的滚动基线钉（与 FoldersOverview 同源修复）：面板展开使内容高度骤降时，
  // React 提交新布局的渲染会触发浏览器把 DOM scrollTop clamp 到新 maxScroll（实测
  // 6723→3823）。FLIP 必须用 clamp 前的真实位置（此 pin）选锚点，否则页面被带到
  // 错误位置（"展开/收起面板后页面跳到中间"）。宽度过渡分支记录，FLIP 消费后清空。
  const widthFlipPinnedScrollRef = useRef<number | null>(null);

  usePinchZoom(containerRef, {
    onPinchStart: useCallback(() => {
      pinchStartSizeRef.current = thumbnailSize;
      gestureStartLevelRef.current = nearestAndroidLevelIndex(thumbnailSize, containerWidthRef.current || 0);
      gestureSteppedRef.current = false;
      pinchScrollPinRef.current = containerRef?.current?.scrollTop ?? 0;
      console.log(`[Pinch-FileGrid] >>> start: thumbSize=${thumbnailSize} startLevelIdx=${gestureStartLevelRef.current} width=${containerWidthRef.current?.toFixed(0)} scroll=${pinchScrollPinRef.current?.toFixed(0)}`);
    }, [thumbnailSize]),
    onPinchZoom: useCallback((totalScale: number) => {
      if (!onThumbnailSizeChange) return;
      if (isAndroid) {
        // 安卓端固定三档，且一次捏合手势只能前进/后退一档
        if (gestureSteppedRef.current) return;
        const startIdx = gestureStartLevelRef.current;
        if (startIdx < 0) return;
        const STEP_THRESHOLD = 1.08;
        let targetIdx = startIdx;
        if (totalScale > STEP_THRESHOLD) targetIdx = startIdx + 1;
        else if (totalScale < 1 / STEP_THRESHOLD) targetIdx = startIdx - 1;
        else return; // 缩放幅度过小，不切换
        if (targetIdx < 0 || targetIdx > 2) return; // 已在最小/最大档
        gestureSteppedRef.current = true;
        const maxLimit = activeTab.viewMode === 'people-overview' ? 450 : 480;
        const minLimit = activeTab.viewMode === 'people-overview' ? 140 : 100;
        const presets = getAndroidThumbnailPresets(containerWidthRef.current || 0);
        console.log(`[Pinch-FileGrid] >>> SWITCH scale=${totalScale.toFixed(2)} startIdx=${startIdx} → targetIdx=${targetIdx} thumbSize=${thumbnailSize}→${presets[targetIdx].toFixed(1)}`);
        onThumbnailSizeChange(Math.max(minLimit, Math.min(maxLimit, presets[targetIdx])));
        return;
      }
      const maxLimit = activeTab.viewMode === 'people-overview' ? 450 : 480;
      const minLimit = activeTab.viewMode === 'people-overview' ? 140 : 100;
      const newSize = Math.max(minLimit, Math.min(maxLimit, Math.round(pinchStartSizeRef.current * totalScale)));
      onThumbnailSizeChange(newSize);
    }, [onThumbnailSizeChange, activeTab.viewMode, isAndroid]),
    onPinchEnd: useCallback(() => {
      pinchScrollPinRef.current = null; // 手势结束，放行滚动
    }, []),
  });

  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const containerWidthRef = useRef(0);
  // 按需虚拟化：记录「已挂载卡片的渲染窗口」[min, max]（含 buffer）。
  // 卡片是绝对定位 + 原生滚动，滚动本身由浏览器合成器处理（React 不参与）。
  // 仅当视口 [scrollTop, scrollTop+height] 越过该窗口边界时才触发重渲染挂载新卡片，
  // 从而把滚动期间的重渲染从「每帧一次」降到「每跨过一个窗口才一次」。
  const renderWindowRef = useRef<{ min: number; max: number }>({ min: -Infinity, max: Infinity });

  const widthDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPanelWidthRemRef = useRef<number | undefined>(undefined);
  // 跟踪 isVisible：ResizeObserver 在容器隐藏时仍会触发（display:none→width=0），
  // 用 ref 在回调内读取最新值，避免把 0 写入 containerWidth 触发不必要的布局重算。
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  // 视图级激活判定：MainContentArea 在 folders-overview / lan-folders-overview 视图下
  // 仍渲染 FileGrid（排在视口下方、被 overflow-hidden 裁剪；isVisible 只看 viewingFileId
  // 不含 viewMode，RO 宽度照常提交以保证切回 browser 时状态正确）。该 ref 供过渡态/
  // FLIP 跳过对用户不可见的重排动画（上轮日志实测：1954 项布局每次面板开合跑 2 轮
  // 完整 FLIP+WAAPI，纯浪费主线程）。
  const isViewActiveRef = useRef(true);
  isViewActiveRef.current = isVisible
    && activeTab.viewMode !== 'folders-overview'
    && activeTab.viewMode !== 'lan-folders-overview';

  const scrollStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 滚动节流 RAF：scroll 事件高频触发，将 scrollTop 状态更新合并到每帧一次，
  // 避免 React 在单个滚动 tick 内因多次 setScrollTop 而重渲染（渲染风暴）。
  const scrollRafRef = useRef<number | null>(null);
  // 滚动条显隐定时器：滚动结束后延迟隐藏滚动条（保留布局空间，仅隐藏 thumb 颜色）
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 过渡冻结定时器：滚动停止后立即移除 anim-freeze（恢复卡片过渡），
  // 与滚动条淡出的 800ms 解耦，避免滚动停止后 hover 过渡被冻结为 0ms。
  const animFreezeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTimeRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  // 文件夹封面预取：视口下方提前 1.2 屏预热缩略图，避免滚动到达时现场解码掉帧
  const lastFolderPrefetchRef = useRef(0);
  const prefetchLayoutRef = useRef<LayoutItem[]>([]);
  const prefetchSortedByYRef = useRef<number[]>([]);
  const getFileNodeRef = useRef(getFileNode);
  getFileNodeRef.current = getFileNode;
  const effectiveResourceRootRef = useRef(effectiveResourceRoot);
  effectiveResourceRootRef.current = effectiveResourceRoot;
  const prevLayoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevScrollTopForFlipRef = useRef(0);
  // Track previous sort option/direction to detect sort changes and bypass the
  // FLIP anchor logic (which would otherwise preserve an anchor's screen
  // position and jump to a random place after the items reorder).
  const prevSortByRef = useRef<SortOption>(sortBy);
  const prevSortDirectionRef = useRef<SortDirection>(sortDirection);
  // Timestamp of the last sort-change reset; used by the sort-reset window in the
  // FLIP effect to skip the anchor logic while layout recompute is still settling.
  const lastSortResetTimeRef = useRef(0);
  // Layout transition tracking: increases buffer so cards in the NEW viewport
  // are mounted before the FLIP WAAPI animation runs.
  const [isLayoutTransitioning, setIsLayoutTransitioning] = useState(false);
  const isLayoutTransitioningRef = useRef(false);
  const prevThumbnailSizeRef = useRef(thumbnailSize);
  const prevContainerWidthRef = useRef(containerRect.width);
  // 最近一次提交给布局的宽度（RO 提交去抖基线）：面板预测宽度与 RO 实测存在 ~1px
  // 亚像素/舍入偏差（取整后可能跨界），若据此二次提交会触发第二次布局重算，
  // 即"面板展开完后布局抖一下"。容忍 <2px 偏差，真实变化（数百 px）不受影响。
  const committedWidthRef = useRef(0);
  const transitionBufferRef = useRef(400);
  const transitionResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipDebugLogRef = useRef(0);
  // FLIP 动画参数（按触发源区分）：
  // - 宽度变化（面板开合）：与面板 width 300ms ease-out 对齐——WAAPI 时长 = 面板剩余
  //   时间（300ms - 管线延迟），easing 与面板一致，两者同起同止、进度互相同步，
  //   消除"卡片 WAAPI(240ms 前置曲线) 跑得比面板 ease-out 尾段快"的脱节。
  // - thumbnailSize 变化（捏合）：保持 240ms 快节奏。
  const flipAnimParamsRef = useRef<{ duration: number; easing: string; startedAt: number; syncToPanel: boolean }>(
    { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', startedAt: 0, syncToPanel: false }
  );
  // Two-phase FLIP: when scrollDelta is large, phase 0 expands buffer + updates scrollTop
  // (mounts cards at new viewport), phase 1 runs the WAAPI animation.
  const [flipPhase, setFlipPhase] = useState(0);
  const pendingFlipDataRef = useRef<{ oldScrollTop: number; newScrollTop: number } | null>(null);

  const throttledOnScrollTopChange = useMemo(() => 
    onScrollTopChange ? throttle(onScrollTopChange, 100) : undefined
  , [onScrollTopChange]);
  // 滚动位置保存：滚动停止 300ms 后才更新 activeTab.scrollTop（App 状态）。
  // 滚动期间不触发 App 重渲染，消除滚动中 onScrollTopChange 每 100ms 引发
  // FileGrid 重渲染的第二个来源（与按需虚拟化配合，滚动时 React 几乎完全静止）。
  const debouncedOnScrollTopChange = useMemo(() => 
    onScrollTopChange ? debounce(onScrollTopChange, 300) : undefined
  , [onScrollTopChange]);

  const handleTagClickStable = useCallback((tag: string, e: React.MouseEvent) => {
      onTagClick?.(tag, e);
  }, [onTagClick]);
  
  const handleTagDoubleClickStable = useCallback((tag: string) => {
      onTagDoubleClick?.(tag);
  }, [onTagDoubleClick]);
  
  const handleTagContextMenuStable = useCallback((e: React.MouseEvent, tag: string) => {
      onTagContextMenu?.(e, tag);
  }, [onTagContextMenu]);
  
  const handleFileClick = useCallback((e: React.MouseEvent, id: string) => {
      onFileClick(e, id);
  }, [onFileClick]);
  
  const handleFileDoubleClick = useCallback((id: string) => {
      onFileDoubleClick(id);
  }, [onFileDoubleClick]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
      onContextMenu(e, id);
  }, [onContextMenu]);
  
  const handleRenameSubmit = useCallback((val: string, id: string) => {
      onRenameSubmit(val, id);
  }, [onRenameSubmit]);
  
  const handleRenameCancel = useCallback(() => {
      onRenameCancel();
  }, [onRenameCancel]);
  
  const handleStartRename = useCallback((id: string) => {
      onStartRename(id);
  }, [onStartRename]);
  
  const handleSetHoverPlayingId = useCallback((id: string | null) => {
      onSetHoverPlayingId(id);
  }, [onSetHoverPlayingId]);
  
  const handlePersonClick = useCallback((id: string, e: React.MouseEvent) => {
      onPersonClick?.(id, e);
  }, [onPersonClick]);
  
  const handlePersonContextMenu = useCallback((e: React.MouseEvent, id: string) => {
      onPersonContextMenu?.(e, id);
  }, [onPersonContextMenu]);
  
  const handlePersonDoubleClick = useCallback((id: string) => {
      onPersonDoubleClick?.(id);
  }, [onPersonDoubleClick]);
  
  const handleToggleGroup = useCallback((id: string) => {
      onToggleGroup?.(id);
  }, [onToggleGroup]);
  
  // Track if we're in the middle of a programmatic scroll restore
  const isRestoringScrollRef = useRef(false);
  // Track if we have successfully restored scroll position for the current view
  const hasRestoredRef = useRef(false);
  const restoreTimeoutRef = useRef<any>(null);
  // Store target scroll in ref to avoid closure trap in scroll handler
  const targetScrollRef = useRef(activeTab.scrollTop);

  // Reset restoration flag when key view parameters change
  useLayoutEffect(() => {
    if (isVisible) {
        hasRestoredRef.current = false;
        // Clear any pending timeout when reseting
        if (restoreTimeoutRef.current) {
             clearTimeout(restoreTimeoutRef.current);
        }
        isRestoringScrollRef.current = false;
    }
  }, [activeTab.id, activeTab.folderId, activeTab.viewMode, isVisible, activeTab.viewingFileId, activeTab.history?.currentIndex]);

  // Keep targetScrollRef in sync with activeTab.scrollTop
  useEffect(() => {
      targetScrollRef.current = activeTab.scrollTop;
  }, [activeTab.scrollTop]);

  const handleMouseDownInternal = useCallback((e: React.MouseEvent) => {
      // If user interacts, assume restoration is done/overridden
      hasRestoredRef.current = true;
      onMouseDown?.(e);
  }, [onMouseDown]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
        // Build-in interaction check
        if (!e.ctrlKey) {
             hasRestoredRef.current = true;
        }

        if (e.ctrlKey && onThumbnailSizeChange) {
            e.preventDefault();
            const maxLimit = activeTab.viewMode === 'people-overview' ? 450 : 480;
            const minLimit = activeTab.viewMode === 'people-overview' ? 140 : 100;
            const step = 20;
            const delta = e.deltaY > 0 ? -step : step;
            const newSize = Math.max(minLimit, Math.min(maxLimit, thumbnailSize + delta));
            onThumbnailSizeChange(newSize);
        }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
        container.removeEventListener('wheel', handleWheel);
    };
  }, [containerRef, thumbnailSize, onThumbnailSizeChange, activeTab.viewMode]);

  useEffect(() => {
    if (!containerRef?.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width > 0) {
        setContainerRect({ width: rect.width, height: rect.height });
        containerWidthRef.current = rect.width;
        committedWidthRef.current = rect.width;
    }

    let animationFrameId: number;
    const observer = new ResizeObserver((entries) => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);

        animationFrameId = requestAnimationFrame(() => {
            for (const entry of entries) {
                if (entry.target === containerRef.current) {
                    // 非 tags-overview 视图：使用容器全宽（含滚动条 gutter）作为布局宽度，
                    // 配合内容负 margin 覆盖 gutter，使网格视觉间距恢复为布局内部 padding，
                    // 同时 both-edges gutter 仍保证滚动条显示/隐藏时布局稳定。
                    const newWidth = activeTab.viewMode === 'tags-overview'
                        ? entry.contentRect.width
                        : (containerRef.current?.getBoundingClientRect().width || entry.contentRect.width);
                    const newHeight = entry.contentRect.height;
                    setContainerRect(prev => ({ width: prev.width, height: newHeight }));

                    // 容器隐藏（display:none）会报告 width=0。如果当前已有非零宽度，
                    // 不要把 0 写入 state——会触发 useLayout 重算（items=0 分支清空布局），
                    // 紧接着容器恢复可见时又触发一次重算（0→实际宽度）。
                    if (newWidth <= 0) continue;

                    // 亚像素抖动（scrollbar 出现/消失导致 1062→1061.64）不会改变取整后的宽度，
                    // useLayoutHook 已用 Math.round 处理；这里再加 1px 阈值提前过滤。
                    if (Math.abs(newWidth - containerWidthRef.current) < 1) continue;

                    containerWidthRef.current = newWidth;
                    if (widthDebounceRef.current) clearTimeout(widthDebounceRef.current);
                    widthDebounceRef.current = setTimeout(() => {
                        // 二次检查可见性：debounce 期间视图可能已切走
                        if (!isVisibleRef.current) return;
                        // 面板动画结束后 RO 实测与预测宽度的亚像素/舍入偏差（~1px，取整
                        // 后可能跨整数边界）不应触发第二次布局重算——那是"面板展开完后
                        // 布局抖一下"的根源。容忍 <2px 偏差不提交；真实宽度变化不受影响。
                        const w = containerWidthRef.current;
                        if (Math.abs(w - committedWidthRef.current) < 2) return;
                        committedWidthRef.current = w;
                        setContainerRect(prev => ({ width: w, height: prev.height }));
                    }, 60);
                }
            }
        });
    });
    observer.observe(containerRef.current);
    
    // Use a stable handler ref or check current status inside handler
    const handleScroll = () => {
        const scroller = containerRef.current;
        if (scroller) {
            // 滚动中显示滚动条；停止滚动 800ms 后自动隐藏（thumb 透明，布局空间保留，保持居中稳定）
            scroller.classList.add('scrolling');
            if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
            scrollHideTimerRef.current = setTimeout(() => {
                scroller.classList.remove('scrolling');
            }, 800);

            // 过渡冻结：滚动事件持续期间暂停卡片过渡（性能优化）；
            // 滚动停止后立即恢复（不等滚动条 800ms 淡出），避免滚动停止后
            // 一段时间内 hover 扇形展开等过渡被冻结为 0ms、瞬间跳变。
            scroller.classList.add('anim-freeze');
            if (animFreezeTimerRef.current) clearTimeout(animFreezeTimerRef.current);
            animFreezeTimerRef.current = setTimeout(() => {
                const sc = containerRef.current;
                if (!sc) return;
                // 若滚动停止瞬间鼠标已悬停在卡片上（过渡曾被冻结、hover 态已瞬间应用），
                // 强制重播一次过渡：先定格为堆叠态，恢复 transition 后移除，播放摊开动画。
                const hovered = sc.querySelector('.file-item:hover');
                if (hovered) {
                    hovered.classList.add('replay-fan');
                }
                sc.classList.remove('anim-freeze');
                if (hovered) {
                    void sc.offsetHeight; // 强制 reflow：让 base 态 + 恢复的 transition 生效
                    requestAnimationFrame(() => {
                        hovered.classList.remove('replay-fan');
                    });
                }
            }, 30);

            if (isRestoringScrollRef.current || scroller.clientWidth === 0) {
                return;
            }

            const currentScroll = containerRef.current.scrollTop;

            // 捏合期间钉住滚动位置：快速捏合的原生滚动无法被 preventDefault 取消，
            // 这里主动拉回，保证手势期间 scrollTop 稳定（FLIP 靠它计算锚点）。
            const pin = pinchScrollPinRef.current;
            if (pin !== null && !isRestoringScrollRef.current && Math.abs(currentScroll - pin) > 1) {
                containerRef.current.scrollTop = pin;
                return;
            }

            const targetScroll = targetScrollRef.current;

            if (!hasRestoredRef.current && targetScroll > 0 && currentScroll < targetScroll - 100) {
                 return;
            }

            const now = Date.now();
            const dt = now - lastScrollTimeRef.current;
            const dy = Math.abs(currentScroll - lastScrollTopRef.current);
            lastScrollTimeRef.current = now;
            lastScrollTopRef.current = currentScroll;

            if (dt > 0) {
                const velocity = dy / dt;
                if (velocity > 3 || dt < 32) {
                    setGlobalScrollState('fast');
                } else if (velocity > 0.5 || dt < 150) {
                    setGlobalScrollState('scrolling');
                } else {
                    setGlobalScrollState('idle');
                }

                if (scrollStateTimerRef.current) clearTimeout(scrollStateTimerRef.current);
                scrollStateTimerRef.current = setTimeout(() => {
                    setGlobalScrollState('idle');
                }, 300);
            }

            // 文件夹封面预取：视口下方提前 1.2 屏预热缩略图（每滚动 ~400px 触发一次）。
            // 解码通过 ThumbnailBatcher 聚合、走 Rust 并发限制，滚动到达时缓存已就绪，
            // 卡片挂载即显示三图拼贴，避免窗口边界批量现场生成造成的掉帧尖峰。
            const viewBottom = currentScroll + (scroller.clientHeight || 0);
            if (viewBottom - lastFolderPrefetchRef.current > 400) {
                lastFolderPrefetchRef.current = viewBottom;
                getFolderThumbnailPrefetcher().prefetchAhead(
                    prefetchLayoutRef.current,
                    prefetchSortedByYRef.current,
                    getFileNodeRef.current,
                    viewBottom
                );
            }

            // 按需虚拟化：滚动期间 React 状态保持不动（卡片绝对定位 + 原生滚动，
            // 由浏览器合成器处理）。仅当视口 [currentScroll, +height] 越过
            // 已挂载卡片的渲染窗口边界时，才触发一次重渲染挂载新卡片。
            const win = renderWindowRef.current;
            const containerH = scroller.clientHeight || 0;
            const needsUpdate = currentScroll < win.min || currentScroll + containerH > win.max;
            if (needsUpdate && scrollRafRef.current === null) {
                scrollRafRef.current = requestAnimationFrame(() => {
                    scrollRafRef.current = null;
                    const scroller2 = containerRef.current;
                    if (scroller2) {
                        setScrollTop(scroller2.scrollTop);
                    }
                });
            }
            // 过渡期（面板开合/捏合的 FLIP 动画中）的 scroll 事件多为浏览器 clamp 或
            // PHASE 1 设置新位置引发，跳过 debounced 写入避免污染 activeTab.scrollTop
            // （FLIP PHASE 1 自己会直调正确的值）。
            if (!isLayoutTransitioningRef.current) {
                debouncedOnScrollTopChange?.(currentScroll);
            }
            onScroll?.();
        }
    };
    containerRef.current.addEventListener('scroll', handleScroll, { passive: true });
    // 滚动性能记录器：测量滚动期间帧耗时 / Long Task / 渲染次数等
    scrollProfiler.attach(containerRef.current);

    // 鼠标悬停在滚动条区域（容器右缘）时添加 scrollbar-hover，滚动条显示并放大；
    // 移开滚动条区域后移除，实现「仅在滚动条上悬停才显示/变大」。
    const handlePointerMove = (e: MouseEvent) => {
        const sc = containerRef.current;
        if (!sc) return;
        const rect = sc.getBoundingClientRect();
        const nearScrollbar = e.clientX >= rect.right - 20 && e.clientX <= rect.right;
        sc.classList.toggle('scrollbar-hover', nearScrollbar);
    };
    const handlePointerLeave = () => {
        containerRef.current?.classList.remove('scrollbar-hover');
    };
    containerRef.current.addEventListener('mousemove', handlePointerMove);
    containerRef.current.addEventListener('mouseleave', handlePointerLeave);

    return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
        observer.disconnect();
        containerRef?.current?.removeEventListener('scroll', handleScroll);
        containerRef?.current?.removeEventListener('mousemove', handlePointerMove);
        containerRef?.current?.removeEventListener('mouseleave', handlePointerLeave);
        scrollProfiler.detach(containerRef.current);
        if (widthDebounceRef.current) clearTimeout(widthDebounceRef.current);
        if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
        if (animFreezeTimerRef.current) clearTimeout(animFreezeTimerRef.current);
        containerRef?.current?.classList.remove('anim-freeze');
        // 取消待执行的滚动位置保存（debounce），避免组件卸载后仍更新 App 状态
        debouncedOnScrollTopChange?.cancel?.();
    };
  }, [containerRef, activeTab.viewMode]);

  // Predict container width immediately when panels toggle, so card transitions
  // run simultaneously with the panel animation instead of waiting for ResizeObserver.
  // 隐藏（display:none）时不预测：否则会触发 useLayout 重算 → FLIP/WAAPI 在不可见
  // 组件上完整跑一遍（实测 1954 卡、每次面板开合 2 次 FLIP），纯浪费主线程。
  // 切回可见时 RO 会汇报真实宽度，走正常重算路径。
  useEffect(() => {
    if (panelWidthRem === undefined) return;
    if (prevPanelWidthRemRef.current !== undefined && prevPanelWidthRemRef.current !== panelWidthRem) {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const deltaRem = prevPanelWidthRemRef.current - panelWidthRem;
      const deltaPx = deltaRem * remPx;
      if (containerWidthRef.current > 0 && isVisibleRef.current) {
        const predictedWidth = containerWidthRef.current + deltaPx;
        console.log(`[FLIP-FileGrid] PREDICT width: ${containerWidthRef.current.toFixed(1)}→${predictedWidth.toFixed(1)} (Δ${deltaPx.toFixed(1)}px) t=${performance.now().toFixed(0)}`);
        setContainerRect(prev => ({ width: predictedWidth, height: prev.height }));
        containerWidthRef.current = predictedWidth;
        committedWidthRef.current = predictedWidth;
      }
    }
    prevPanelWidthRemRef.current = panelWidthRem;
  }, [panelWidthRem]);

  const { layout, totalHeight, sortedByY } = useLayout(
      activeTab.viewMode === 'people-overview' ? [] : displayFileIds,
      getFileNode,
      activeTab.layoutMode,
      containerRect.width,
      thumbnailSize,
      activeTab.viewMode as any,
      groupedTags,
      people,
      activeTab.searchQuery
  );

  // Keep the shared layoutRef in sync for marquee-selection collision detection
  useEffect(() => {
    if (layoutItemsRef) {
      layoutItemsRef.current = layout;
    }
  }, [layout, layoutItemsRef]);
  // 文件夹封面预取：同步布局引用，供滚动 handler 扫描视口前方的文件夹
  prefetchLayoutRef.current = layout;
  prefetchSortedByYRef.current = sortedByY;

  // 文件夹封面预取器初始化：设置资源根目录；切换目录/标签/视图时重置已预取集合
  useEffect(() => {
    const prefetcher = getFolderThumbnailPrefetcher();
    prefetcher.setRoot(effectiveResourceRootRef.current ?? null);
    prefetcher.reset();
    lastFolderPrefetchRef.current = 0;
  }, [effectiveResourceRoot, activeTab.id, activeTab.folderId, activeTab.viewMode]);

  // FLIP animation: anchor at viewport top instead of page top.
  // Only applies to non-grouped views where the top-level layout is used for rendering.
  const isNonGroupedView = groupBy === 'none' || !groupedFiles || groupedFiles.length === 0;

  // Sync isLayoutTransitioning to ref for use inside FLIP effect (avoids stale closure / extra deps)
  useEffect(() => {
    isLayoutTransitioningRef.current = isLayoutTransitioning;
  }, [isLayoutTransitioning]);

  // Watch layout input changes: set transition state (freezes card CSS transitions and
  // forces the WAAPI path). The render buffer is NOT inflated: old viewport cards land
  // near the anchor (= new scrollTop) after reflow, and the FLIP's PHASE 0 switches the
  // render window to the new scrollTop before animating, so a normal buffer suffices.
  // (Inflating to 1200~2600 mounted 150~260 cards; under the pinch touchmove flood the
  // commit stretched to 120~350ms, so a rapid second pinch felt dead and only animated
  // after the fingers lifted.)
  useEffect(() => {
    const prevThumb = prevThumbnailSizeRef.current;
    const prevWidth = prevContainerWidthRef.current;
    const currWidth = containerRect.width;
    const thumbChanged = prevThumb !== thumbnailSize;
    const widthChanged = prevWidth !== currWidth && prevWidth > 0 && currWidth > 0;

    if (!thumbChanged && !widthChanged) {
      // 关键修复（2026-08-31，与 FoldersOverview 同源 bug）：早退路径也必须同步宽度
      // ref。挂载序列（state 0 → 初测宽度）因 widthChanged 的 prevWidth>0 条件走此
      // 分支，若不同步 prevContainerWidthRef 会永远卡在 0 → 之后所有纯宽度变化都被
      // prevWidth>0 拦截 → 宽度过渡分支从未执行 → CSS+WAAPI 双动画 = 布局抖动。
      if (currWidth > 0 && prevWidth !== currWidth) {
        prevContainerWidthRef.current = currWidth;
        console.log(`[FLIP-FileGrid] width ref synced at mount: ${prevWidth.toFixed(0)}→${currWidth.toFixed(0)}`);
      }
      return;
    }
    // Skip if container not visible / not non-grouped / 当前视图是 folders-overview
    // （FileGrid 渲染在视口下方被 overflow-hidden 裁剪，isVisible 不含 viewMode，
    // RO 宽度提交照常进行以保证切回时状态正确，但过渡态/FLIP 对用户不可见、应跳过）
    if (currWidth <= 0 || !isNonGroupedView || !isViewActiveRef.current) {
      prevThumbnailSizeRef.current = thumbnailSize;
      prevContainerWidthRef.current = currWidth;
      if (currWidth > 0 && isNonGroupedView) {
        console.log(`[FLIP-FileGrid] SKIP transition (view=${activeTab.viewMode}, grid below-fold/not visible)`);
      }
      return;
    }
    // 宽度变化（面板开合）同样进入过渡态：FLIP 锚点会瞬间跳变 scrollTop，若卡片 CSS
    // transform 过渡仍在运行，WAAPI 先结束时卡片会被 CSS 过渡拉回中间态再滑到终点
    // → 面板展开完后“弹一下”；且全量卡片 CSS 过渡 + WAAPI 双重动画是掉帧主因。
    // 进入过渡态 = 禁用卡片 CSS 过渡（根容器 [&_*]:!transition-none）、统一走 WAAPI
    // （与捏合切换同路径）。亚像素 RO 汇报（<1px，取整后不产生新布局）不触发。
    if (!thumbChanged) {
      prevThumbnailSizeRef.current = thumbnailSize;
      prevContainerWidthRef.current = currWidth;
      if (Math.abs(currWidth - prevWidth) > 1) {
        const scrollNow = containerRef?.current?.scrollTop || 0;
        // 钉住宽度 FLIP 的滚动基线：内容变矮（展开面板）时新布局渲染会触发浏览器
        // clamp DOM scrollTop，FLIP 必须用 clamp 前的真实位置选锚点。
        widthFlipPinnedScrollRef.current = scrollNow;
        // 与面板 width 300ms ease-out 对齐（记录面板动画起点，WAAPI 用剩余时长）
        flipAnimParamsRef.current = { duration: 300, easing: 'ease-out', startedAt: performance.now(), syncToPanel: true };
        transitionBufferRef.current = 400;
        setIsLayoutTransitioning(true);
        console.log(`[FLIP-FileGrid] TRANSITION START (width): ${prevWidth.toFixed(0)}→${currWidth.toFixed(0)}, scroll=${scrollNow.toFixed(0)} t=${performance.now().toFixed(0)}`);
        if (transitionResetTimerRef.current) clearTimeout(transitionResetTimerRef.current);
        transitionResetTimerRef.current = setTimeout(() => {
          setIsLayoutTransitioning(false);
          transitionBufferRef.current = 400;
        }, 600);
      }
      return;
    }

    const currentScroll = containerRef?.current?.scrollTop || 0;

    flipAnimParamsRef.current = { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', startedAt: 0, syncToPanel: false };
    transitionBufferRef.current = 400;
    setIsLayoutTransitioning(true);
    console.log(`[FLIP-FileGrid] TRANSITION START: thumb=${prevThumb}→${thumbnailSize}, width=${prevWidth.toFixed(0)}→${currWidth.toFixed(0)}, scroll=${currentScroll.toFixed(0)} t=${performance.now().toFixed(0)}`);

    if (transitionResetTimerRef.current) clearTimeout(transitionResetTimerRef.current);
    transitionResetTimerRef.current = setTimeout(() => {
      setIsLayoutTransitioning(false);
      transitionBufferRef.current = 400;
      console.log(`[FLIP-FileGrid] TRANSITION END (timeout 600ms)`);
    }, 600);

    prevThumbnailSizeRef.current = thumbnailSize;
    prevContainerWidthRef.current = currWidth;
  }, [thumbnailSize, containerRect.width]);

  useLayoutEffect(() => {
    if (!isNonGroupedView) {
      prevLayoutPositionsRef.current = new Map();
      return;
    }
    // 不可见 / 视图不活跃（folders-overview 等 overview 视图下 FileGrid 渲染在视口
    // 下方被裁剪）时只记录最新位置作为后续 FLIP 基线，跳过锚点纠正与 WAAPI——
    // 对用户不可见的布局变化无需动画（实测曾每次面板开合跑 2 轮完整 FLIP）。
    if (!isViewActiveRef.current) {
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = containerRef?.current?.scrollTop || 0;
      console.log(`[FLIP-FileGrid] SKIP FLIP (view=${activeTab.viewMode}): grid not user-visible`);
      if (pendingFlipDataRef.current) {
        pendingFlipDataRef.current = null;
        setFlipPhase(0);
      }
      if (isLayoutTransitioningRef.current) {
        if (transitionResetTimerRef.current) clearTimeout(transitionResetTimerRef.current);
        transitionResetTimerRef.current = setTimeout(() => {
          setIsLayoutTransitioning(false);
          transitionBufferRef.current = 400;
        }, 400);
      }
      return;
    }
    const prevPositions = prevLayoutPositionsRef.current;
    const logId = ++flipDebugLogRef.current;

    // Detect sort option/direction change: when sorting changes the entire ordering
    // intentionally, so the FLIP anchor logic (which tries to keep an anchor card at
    // the same screen position) must NOT run — it would scroll to a random place.
    // Instead, reset scroll to top so the user sees the beginning of the new order.
    const sortChanged = prevSortByRef.current !== sortBy || prevSortDirectionRef.current !== sortDirection;
    prevSortByRef.current = sortBy;
    prevSortDirectionRef.current = sortDirection;
    if (sortChanged) {
      lastSortResetTimeRef.current = Date.now();
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      const container = containerRef?.current;
      if (container && container.scrollTop !== 0) {
        isRestoringScrollRef.current = true;
        container.scrollTop = 0;
        setScrollTop(0);
        throttledOnScrollTopChange?.(0);
        if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
        restoreTimeoutRef.current = setTimeout(() => { isRestoringScrollRef.current = false; }, 50);
      }
      prevScrollTopForFlipRef.current = 0;
      hasRestoredRef.current = true;
      if (flipPhase === 1) setFlipPhase(0);
      return;
    }

    // First render or empty layout: just record positions
    if (prevPositions.size === 0 || layout.length === 0) {
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = containerRef?.current?.scrollTop || 0;
      return;
    }

    // Check if any position actually changed
    let hasPositionChanged = false;
    for (const item of layout) {
      const prev = prevPositions.get(item.id);
      if (!prev || Math.abs(prev.x - item.x) > 0.5 || Math.abs(prev.y - item.y) > 0.5) {
        hasPositionChanged = true;
        break;
      }
    }
    if (!hasPositionChanged) {
      prevScrollTopForFlipRef.current = containerRef?.current?.scrollTop || 0;
      return;
    }

    // If most items changed (e.g., tab switch), skip FLIP to avoid animating unrelated cards
    const commonCount = layout.filter(item => prevPositions.has(item.id)).length;
    if (commonCount < layout.length * 0.5) {
      console.log(`[FLIP-FileGrid] #${logId} SKIP: too many new items (common=${commonCount}/${layout.length})`);
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = containerRef?.current?.scrollTop || 0;
      return;
    }

    const container = containerRef?.current;
    if (!container) return;

    // BUG FIX #1: Use LIVE scrollTop from the DOM, not the stale prevScrollTopForFlipRef.
    // 宽度 clamp 修复（与 FoldersOverview 同源）：面板展开使内容高度骤降时，React
    // 提交新布局渲染会触发浏览器把 DOM scrollTop clamp 到新 maxScroll（实测
    // 6723→3823）。live 值已失真，锚点必须按 clamp 前用户真实位置（宽度过渡分支
    // 记录的 pin）选取，否则页面被带到错误位置。
    let oldScrollTop = container.scrollTop;
    const clampedScrollTop = oldScrollTop;
    const pinnedScrollTop = widthFlipPinnedScrollRef.current;
    if (pinnedScrollTop !== null) {
      widthFlipPinnedScrollRef.current = null;
      if (Math.abs(pinnedScrollTop - oldScrollTop) > 1) {
        console.log(`[FLIP-FileGrid] #${logId}   CLAMP detected: live ${oldScrollTop.toFixed(1)} was clamped, using pinned ${pinnedScrollTop.toFixed(1)}`);
        oldScrollTop = pinnedScrollTop;
      }
    }
    const staleScrollTop = prevScrollTopForFlipRef.current;

    console.log(`[FLIP-FileGrid] #${logId} START: layout=${layout.length}, prevPos=${prevPositions.size}, common=${commonCount} t=${performance.now().toFixed(0)}`);
    console.log(`[FLIP-FileGrid] #${logId}   scrollTop: live=${clampedScrollTop.toFixed(1)}${oldScrollTop !== clampedScrollTop ? ` (pinned=${oldScrollTop.toFixed(1)})` : ''}, staleRef=${staleScrollTop.toFixed(1)}, drift=${(clampedScrollTop - staleScrollTop).toFixed(1)}`);

    // Sort-reset window: after a sort change, displayFileIds/layout recompute is
    // asynchronous and may trigger this effect a SECOND time (with sortChanged=false
    // because prevSortByRef was already updated on the first trigger). During that
    // window the anchor logic would pick a card that moved far away (e.g. oldY=24 →
    // newY=7012) and jump scroll to keep it on-screen — the "random jump" bug.
    // Fix: within 500ms of a sort reset, force scrollTop=0 and skip the anchor logic.
    {
      const sinceSort = lastSortResetTimeRef.current ? Date.now() - lastSortResetTimeRef.current : -1;
      if (sinceSort >= 0 && sinceSort < 500) {
        const map = new Map<string, { x: number; y: number }>();
        layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
        prevLayoutPositionsRef.current = map;
        const cont = containerRef?.current;
        if (cont && cont.scrollTop !== 0) {
          isRestoringScrollRef.current = true;
          cont.scrollTop = 0;
          setScrollTop(0);
          throttledOnScrollTopChange?.(0);
          if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
          restoreTimeoutRef.current = setTimeout(() => { isRestoringScrollRef.current = false; }, 50);
        }
        prevScrollTopForFlipRef.current = 0;
        if (flipPhase === 1) setFlipPhase(0);
        return;
      }
    }

    // Find anchor card: the card closest to viewport top (oldScreenY >= 0) in previous layout
    let anchorId: string | null = null;
    let anchorOldScreenY = 0;
    let minScreenY = Infinity;
    prevPositions.forEach((pos, id) => {
      const screenY = pos.y - oldScrollTop;
      if (screenY >= -50 && screenY < minScreenY) {
        minScreenY = screenY;
        anchorId = id;
        anchorOldScreenY = screenY;
      }
    });

    // Calculate new scroll top so the anchor card stays at the same screen position
    let newScrollTop = oldScrollTop;
    if (anchorId) {
      const anchorNew = layout.find(item => item.id === anchorId);
      if (anchorNew) {
        newScrollTop = Math.max(0, anchorNew.y - anchorOldScreenY);
      }
    }

    // 不封顶滚动纠正：锚点必须精确停在原屏幕位置。此前的 ±1 视口封顶会把深处滚动的锚点
    // 顶出屏幕 700~1500px，全部卡片以 1500~3000px 的幅度整体"扫射"过视口（实测每次捏合
    // scrollDelta 都恰好等于 ±clientHeight，即封顶值）。大位移的挂载由 PHASE 0/1 兜底：
    // PHASE 0 先把渲染窗口切到新 scrollTop（挂上新视口卡片），PHASE 1 在同一帧内设置 DOM
    // 滚动 + WAAPI；旧视口卡片按锚点换算后的新位置总落在新 scrollTop 附近，天然保持挂载。
    const maxScroll = Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
    newScrollTop = Math.max(0, Math.min(maxScroll, newScrollTop));

    const anchorOldY = anchorId ? prevPositions.get(anchorId)?.y : undefined;
    const anchorNewY = anchorId ? layout.find(i => i.id === anchorId)?.y : undefined;
    const scrollDelta = newScrollTop - oldScrollTop;
    console.log(`[FLIP-FileGrid] #${logId}   anchor: id=${(anchorId || '').slice(0, 12)}, oldY=${anchorOldY?.toFixed(0)}, screenY=${anchorOldScreenY.toFixed(0)}, newY=${anchorNewY?.toFixed(0)}, newScroll=${newScrollTop.toFixed(0)}, scrollDelta=${scrollDelta.toFixed(0)}`);

    // If scroll adjustment is negligible, CSS transition on transform handles the animation.
    // No need for WAAPI — this avoids perf cost on panel toggle (width-only changes).
    // 注意：thumbnailSize 切换期间（isLayoutTransitioning）CSS 过渡被禁用（性能优化），
    // 此时即使 scrollDelta 很小也必须走 WAAPI，否则会变成无动画的硬切。
    if (Math.abs(scrollDelta) <= 1 && !isLayoutTransitioningRef.current) {
      console.log(`[FLIP-FileGrid] #${logId} SKIP WAAPI: |scrollDelta|≤1, CSS transition handles it`);
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = oldScrollTop;
      if (flipPhase === 1) setFlipPhase(0);
      return;
    }

    // Two-phase FLIP: when scrollDelta is large, the new viewport cards aren't mounted yet
    // (visibleItems was computed with old scrollTop). Phase 0 updates scrollTop state so
    // visibleItems includes new viewport cards. Phase 1 runs the WAAPI animation after
    // re-render. NOTE: buffer is NOT expanded here — old viewport cards' positions are
    // already recorded in prevPositions, and after the anchor correction they land near
    // the new scrollTop anyway; only the new viewport cards need mounting, which Phase
    // 0's window switch handles.
    // Skip Phase 0 when the new viewport is already covered by the current buffer (e.g.,
    // width-only changes with small scrollDelta) — avoids an unnecessary re-render that
    // causes mid-animation stutter.
    const containerHeight = container.clientHeight || 0;
    const currentBuffer = transitionBufferRef.current;
    const oldBufferMin = oldScrollTop - currentBuffer;
    const oldBufferMax = oldScrollTop + containerHeight + currentBuffer;
    const newViewportCovered = newScrollTop >= oldBufferMin && (newScrollTop + containerHeight) <= oldBufferMax;

    if (flipPhase === 0 && !newViewportCovered) {
      console.log(`[FLIP-FileGrid] #${logId} PHASE 0: scroll ${oldScrollTop.toFixed(0)}→${newScrollTop.toFixed(0)}, delta=${scrollDelta.toFixed(0)} (buffer kept at ${currentBuffer})`);
      pendingFlipDataRef.current = { oldScrollTop, newScrollTop };
      setScrollTop(newScrollTop);
      setFlipPhase(1);
      return;
    }

    // Phase 1: run FLIP animation
    let actualOldScrollTop = oldScrollTop;
    let actualNewScrollTop = newScrollTop;
    if (flipPhase === 1 && pendingFlipDataRef.current) {
      actualOldScrollTop = pendingFlipDataRef.current.oldScrollTop;
      actualNewScrollTop = pendingFlipDataRef.current.newScrollTop;
      pendingFlipDataRef.current = null;
      setFlipPhase(0);
      console.log(`[FLIP-FileGrid] #${logId} PHASE 1: oldScroll=${actualOldScrollTop.toFixed(0)}, newScroll=${actualNewScrollTop.toFixed(0)}`);
    }

    // Adjust scroll position instantly (before paint, so no visual jump)
    container.scrollTop = actualNewScrollTop;
    // 捏合期间的滚动钉跟随 FLIP 的新位置，防止后续拉回旧值
    if (pinchScrollPinRef.current !== null) {
      pinchScrollPinRef.current = actualNewScrollTop;
    }

    // Apply WAAPI FLIP animation only to cards near old OR new viewport.
    // visibleItems may include many cards (large buffer), but only animate relevant ones.
    // padding=150：动画期间视口固定（240ms 内无滚动），±150 之外的卡全程不可见，
    // 动画它们纯属浪费合成成本（小图标档位列多卡多，是帧率低的主因）。
    const viewportPadding = 150;
    const oldVpMin = actualOldScrollTop - viewportPadding;
    const oldVpMax = actualOldScrollTop + containerHeight + viewportPadding;
    const newVpMin = actualNewScrollTop - viewportPadding;
    const newVpMax = actualNewScrollTop + containerHeight + viewportPadding;

    // 动画参数：宽度触发时与面板 width 300ms ease-out 对齐（时长=面板剩余时间，
    // 同 easing → 卡片与面板同起同止、进度同步，消除"两端式"脱节）；捏合保持 240ms。
    const animParams = flipAnimParamsRef.current;
    let animDuration = animParams.duration;
    if (animParams.syncToPanel) {
      const elapsed = performance.now() - animParams.startedAt;
      animDuration = Math.max(120, Math.round(animParams.duration - elapsed));
    }
    const animEasing = animParams.easing;

    let animatedCount = 0;
    let notFoundCount = 0;
    let skippedCount = 0;
    visibleItems.forEach(item => {
      const prev = prevPositions.get(item.id);
      if (!prev) return;

      const inOldVp = item.y < oldVpMax && item.y + item.height > oldVpMin;
      const inNewVp = item.y < newVpMax && item.y + item.height > newVpMin;
      if (!inOldVp && !inNewVp) {
        skippedCount++;
        return;
      }

      const el = container.querySelector(`[data-id="${item.id}"]`) as HTMLElement | null;
      if (!el) {
        notFoundCount++;
        return;
      }

      const oldScreenY = prev.y - actualOldScrollTop;
      const newScreenY = item.y - actualNewScrollTop;
      const deltaY = oldScreenY - newScreenY;
      const deltaX = prev.x - item.x;

      if (Math.abs(deltaY) < 1 && Math.abs(deltaX) < 1) {
        skippedCount++;
        return;
      }

      el.animate(
        [
          { transform: `translate(${item.x + deltaX}px, ${item.y + deltaY}px)` },
          { transform: `translate(${item.x}px, ${item.y}px)` },
        ],
        {
          duration: animDuration,
          easing: animEasing,
          fill: 'none',
        }
      );
      animatedCount++;
    });

    console.log(`[FLIP-FileGrid] #${logId}   WAAPI: animated=${animatedCount}, notFound=${notFoundCount}, skipped=${skippedCount}, visibleTotal=${visibleItems.length}, dur=${animDuration}ms t=${performance.now().toFixed(0)}`);

    // Update refs for next layout change
    const map = new Map<string, { x: number; y: number }>();
    layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
    prevLayoutPositionsRef.current = map;
    prevScrollTopForFlipRef.current = actualNewScrollTop;

    // Update scrollTop state (WAAPI animation overrides inline transform, so re-render is safe)
    setScrollTop(actualNewScrollTop);
    throttledOnScrollTopChange?.(actualNewScrollTop);

    // Reset transition state after animation completes
    if (isLayoutTransitioningRef.current) {
      if (transitionResetTimerRef.current) clearTimeout(transitionResetTimerRef.current);
      transitionResetTimerRef.current = setTimeout(() => {
        setIsLayoutTransitioning(false);
        transitionBufferRef.current = 400;
        console.log(`[FLIP-FileGrid] #${logId} TRANSITION END (post-FLIP 400ms)`);
      }, 400);
    }
  }, [layout, isNonGroupedView, flipPhase, sortBy, sortDirection]);

  useLayoutEffect(() => {
      if (!isVisible) return;

      if (containerRef?.current && !hasRestoredRef.current && containerRect.width > 0) {
           const targetScroll = activeTab.scrollTop;
          
           if(targetScroll > 0) {
               isRestoringScrollRef.current = true;
               containerRef.current.scrollTop = targetScroll;
               setScrollTop(targetScroll);
               
               if (restoreTimeoutRef.current) {
                   clearTimeout(restoreTimeoutRef.current);
               }

               restoreTimeoutRef.current = setTimeout(() => {
                   isRestoringScrollRef.current = false;
               }, 100);

               const currentScroll = containerRef.current.scrollTop;
               const isClamped = Math.abs(currentScroll - targetScroll) > 10;
               
               if (!isClamped) {
                   hasRestoredRef.current = true;
               }
           } else {
              // Explicitly reset scroll to 0 if target is 0, to handle component reuse
              if (containerRef.current.scrollTop !== 0) {
                  isRestoringScrollRef.current = true;
                  containerRef.current.scrollTop = 0;
                  setScrollTop(0);
                  
                  if (restoreTimeoutRef.current) {
                      clearTimeout(restoreTimeoutRef.current);
                  }
   
                  restoreTimeoutRef.current = setTimeout(() => {
                      isRestoringScrollRef.current = false;
                  }, 50);
              }
              hasRestoredRef.current = true;
           }
      }
  }, [activeTab.id, activeTab.folderId, activeTab.viewMode, activeTab.scrollTop, containerRect.width, totalHeight, isVisible]);

  // Handle scrolling to specific item
  useEffect(() => {
      // Only run if we have a target item ID and layout is ready
      // IMPORTANT: Must wait for containerRect.width > 0 to ensure layout is calculated correctly based on container width
      if (!isVisible || !activeTab.scrollToItemId || !containerRef?.current || layout.length === 0 || containerRect.width <= 0 || containerRect.height <= 0) return;

      const item = layout.find(i => i.id === activeTab.scrollToItemId);
      
      if (item) {
         const containerHeight = containerRect.height;
         const itemTop = item.y;
         const itemHeight = item.height;
         
         // Calculate scroll position to center the item
         let newScrollTop = itemTop - (containerHeight / 2) + (itemHeight / 2);
         
         // Clamp based on total layout height
         newScrollTop = Math.max(0, Math.min(newScrollTop, totalHeight - containerHeight));
         
         // If totalHeight is smaller than container, scrollTop should be 0
         if (totalHeight < containerHeight) {
            newScrollTop = 0;
         }

         // Log for debugging
         // console.log(`[FileGrid] ScrollToItem: ${activeTab.scrollToItemId}, itemY=${itemTop}, newScroll=${newScrollTop}, containerH=${containerHeight}`);
         
         // Temporarily block scroll updates to state
         isRestoringScrollRef.current = true;
         containerRef.current.scrollTop = newScrollTop;
         setScrollTop(newScrollTop);
         
         if (restoreTimeoutRef.current) {
             clearTimeout(restoreTimeoutRef.current);
         }
         
         // Slightly longer timeout to ensure scroll settles
         restoreTimeoutRef.current = setTimeout(() => {
             isRestoringScrollRef.current = false;
         }, 150);

         onConsumeScrollToItem?.();
      }
  }, [activeTab.scrollToItemId, layout, isVisible, containerRect.width, containerRect.height, totalHeight]);

  // 防御性检查：构建当前 displayFileIds 的 Set，用于过滤掉残留布局中
  // 属于上一个文件夹的 item，避免切换文件夹时短暂渲染旧文件夹的图片。
  const displayFileIdsSet = useMemo(() => new Set(displayFileIds), [displayFileIds]);

  const visibleItems = useMemo(() => {
      const buffer = isLayoutTransitioning ? transitionBufferRef.current : 400;
      const minY = scrollTop - buffer;
      const maxY = scrollTop + containerRect.height + buffer;
      // 记录本次挂载的渲染窗口，供滚动事件判断是否需要按需重渲染
      renderWindowRef.current = { min: minY, max: maxY };
      if (layout.length === 0 || sortedByY.length === 0) return [];
      // sortedByY is sorted by layout[idx].y; binary-search the first index whose y
      // is >= minY - SAFE_MARGIN (margin covers max item height so items whose top is
      // above minY but bottom still intersects the viewport are not skipped).
      const SAFE_MARGIN = 800;
      const threshold = minY - SAFE_MARGIN;
      let lo = 0, hi = sortedByY.length;
      while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (layout[sortedByY[mid]].y < threshold) lo = mid + 1;
          else hi = mid;
      }
      // Linear scan from lo; since sorted by y, stop as soon as y >= maxY.
      const out: LayoutItem[] = [];
      for (let i = lo; i < sortedByY.length; i++) {
          const item = layout[sortedByY[i]];
          if (item.y >= maxY) break;
          if (item.y + item.height > minY && displayFileIdsSet.has(item.id)) out.push(item);
      }
      return out;
  }, [layout, sortedByY, scrollTop, containerRect.height, isLayoutTransitioning, displayFileIdsSet]);

  // LAN 导航管道：visibleItems 首次非空时记录「第一页第一个 Item Render」
  const lanNavFirstRenderRef = useRef(false);
  const lanNavLastIdRef = useRef(0);
  useEffect(() => {
      const currentNavId = lanNavId();
      // 新的导航会话开始：重置首次渲染标记
      if (currentNavId !== lanNavLastIdRef.current) {
          lanNavFirstRenderRef.current = false;
          lanNavLastIdRef.current = currentNavId;
      }
      if (lanNavActive() && visibleItems.length > 0 && !lanNavFirstRenderRef.current) {
          lanNavFirstRenderRef.current = true;
          lanNavStep('===== FIRST ITEM RENDER =====', `count=${visibleItems.length}`);
      }
  }, [visibleItems.length]);

  // keep a cheap, always-available source of truth for how many items FileGrid is rendering
  useEffect(() => {
      const win = window as any;
      win.__AURORA_RENDER_COUNTS__ = win.__AURORA_RENDER_COUNTS__ || {};

      // logical (virtualized) count published earlier as `fileGrid` — keep for backward-compat
      win.__AURORA_RENDER_COUNTS__.fileGrid = visibleItems.length;

      // total items the view intends to show
      const totalLogical = Array.isArray(displayFileIds) ? displayFileIds.length : 0;
      win.__AURORA_RENDER_COUNTS__.fileGridTotal = totalLogical;

      // DOM-mounted count (best-effort)
      const domCount = typeof document !== 'undefined' ? document.querySelectorAll('.file-item[data-id]').length : 0;
      win.__AURORA_RENDER_COUNTS__.fileGridDOM = domCount;

      // virtualization heuristics
      const logicalWindowSmaller = typeof visibleItems.length === 'number' && totalLogical > 0 && visibleItems.length < totalLogical;
      const domMuchSmaller = domCount > 0 && totalLogical > 0 && domCount < totalLogical;

      win.__AURORA_RENDER_COUNTS__.fileGridVirtualizedLogical = !!logicalWindowSmaller;
      win.__AURORA_RENDER_COUNTS__.fileGridVirtualizedDOM = !!domMuchSmaller;

      // expose a simple / authoritative boolean
      win.__AURORA_RENDER_COUNTS__.fileGridUsingVirtualization = !!(logicalWindowSmaller || domMuchSmaller || (Array.isArray(layout) && layout.length < totalLogical));
  }, [visibleItems.length, displayFileIds.length, layout]);

  useEffect(() => {
    if (!isAndroid || visibleItems.length === 0) return;
    const prefetcher = getThumbnailPrefetcher();
    const visible = visibleItems.map(item => {
      const file = getFileNode(item.id);
      return {
        mediaStoreId: file?.mediaStoreId,
        filePath: item.id,
      };
    }).filter(v => v.mediaStoreId != null);
    const buffer = visible;
    prefetcher.updateVisibleIds(visible, buffer);
  }, [visibleItems, isAndroid]);

  const sortedKeys = useMemo(() => {
      if (!groupedTags) return [];
      const keys = Object.keys(groupedTags);
      return sortKeys(keys);
  }, [groupedTags]);

  if (activeTab.viewMode === 'tags-overview') {
      return (
          <div className="w-full h-full flex flex-col">
              <TagIndexBar 
                  keys={sortedKeys}
                  scrollTop={scrollTop}
                  layout={layout}
              />
              <div
                  ref={containerRef}
                  id="file-grid-container"
                  className={`flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 relative ${isLayoutTransitioning ? '[&_*]:!transition-none' : ''}`}
                  onContextMenu={isAndroid ? undefined : onBackgroundContextMenu}
                  onMouseDown={handleMouseDownInternal}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
              >
                  {isAndroid && (
                      <PullToRefreshIndicator
                          isRefreshing={isPullRefreshing}
                          isComplete={isPullComplete}
                          pullDistanceRef={pullDistanceRef}
                      />
                  )}
                  <div className="absolute inset-0 pointer-events-none z-50">
                      <div
                          ref={marqueeOverlayRef}
                          className="absolute border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/20 opacity-50 pointer-events-none"
                          style={{ display: 'none', left: 0, top: 0, width: 0, height: 0, willChange: 'left, top, width, height', transform: 'translateZ(0)' }}
                      />
                  </div>
                  <div ref={contentRef}>
                  <TagsList
                      groupedTags={groupedTags || {}}
                      keys={sortedKeys}
                      files={files || {}}
                      selectedTagIds={activeTab.selectedTagIds}
                      onTagClick={handleTagClickStable}
                      onTagDoubleClick={handleTagDoubleClickStable}
                      onTagContextMenu={handleTagContextMenuStable}
                      t={t}
                      layout={layout}
                      totalHeight={totalHeight}
                      scrollTop={scrollTop}
                      containerHeight={containerRect.height}
                      resourceRoot={resourceRoot}
                  />
                  </div>
              </div>
          </div>
      );
  }

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      const target = e.target as HTMLElement;
      const folderElement = target.closest('.file-item[data-id]') as HTMLElement | null;
      const folderId = folderElement?.getAttribute('data-id') || null;
      const isSelfTarget = !!(folderId && draggedFileIds && draggedFileIds.includes(folderId));
      const folder = folderId ? getFileNode(folderId) : null;
      const isValidDrop = !!(folder && folder.type === FileType.FOLDER && !isSelfTarget);

      // Schedule highlight update via debounced RAF — DOM mutations
      // are executed OUTSIDE the drag event so the browser won't
      // trigger dragLeave re-evaluation cycles.
      scheduleDragHighlight(isValidDrop ? folderElement : null);
  };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      
      try {
          const data = e.dataTransfer.getData('application/json');
          if (!data) return;
          
          const { type, ids } = JSON.parse(data);
          if (type !== 'file' || !ids || ids.length === 0) return;
          
          // Clean up drop target highlights
          if (dragHighlightRafRef.current !== null) {
              cancelAnimationFrame(dragHighlightRafRef.current);
              dragHighlightRafRef.current = null;
          }
          const allFolders = document.querySelectorAll('.file-item[data-id]');
          allFolders.forEach(el => delete (el as HTMLElement).dataset.dropTarget);
          dragHoverRef.current = null;
          
          // 判断是否拖拽到文件夹上
          const target = e.target as HTMLElement;
          const folderElement = target.closest('.file-item[data-id]');
          
          if (folderElement) {
              const targetFolderId = folderElement.getAttribute('data-id');
              if (targetFolderId) {
                  const targetFolder = getFileNode(targetFolderId);
                  
                  if (targetFolder && targetFolder.type === FileType.FOLDER) {
                      // 拖拽到文件夹上：交给父组件处理
                      if (onDropOnFolder) {
                          onDropOnFolder(targetFolderId, ids);
                      }
                  }
              }
          } else {
              // 拖拽到空白处：视为拖拽到当前目录
              const currentFolderId = activeTab.folderId;
              if (currentFolderId && onDropOnFolder) {
                  // 判断所有文件是否已在当前目录
                  const allFilesInCurrentFolder = ids.every((id: string) => {
                      const file = getFileNode(id);
                      return file && file.parentId === currentFolderId;
                  });
                  
                  // 已在当前目录时无需处理，直接返回
                  if (allFilesInCurrentFolder) {
                      return;
                  }
                  
                  onDropOnFolder(currentFolderId, ids);
              }
          }
      } catch (error) {
          console.error('Drop handling error:', error);
      }
  };

  return (
      <div
          ref={containerRef}
          id={isAndroid ? 'file-grid-scroll' : 'file-grid-container'}
          className={`relative w-full h-full min-w-0 overflow-y-auto overflow-x-hidden transition-all duration-200 ${isDraggingOver ? 'bg-gradient-to-b from-blue-50 to-transparent dark:from-blue-900/15 dark:to-transparent border-2 border-dashed border-blue-300 dark:border-blue-700/50' : ''} ${isLayoutTransitioning ? '[&_*]:!transition-none' : ''}`}
          style={isAndroid ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
          onContextMenu={isAndroid ? undefined : onBackgroundContextMenu}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onDragOver={isAndroid ? undefined : handleDragOver}
          onDrop={isAndroid ? undefined : handleDrop}
          onDragLeave={isAndroid ? undefined : undefined}
      >
          {isAndroid && (
              <style dangerouslySetInnerHTML={{ __html: '#file-grid-scroll::-webkit-scrollbar{display:none;width:0!important;height:0!important}' }} />
          )}
          {isAndroid && (
              <PullToRefreshIndicator
                  isRefreshing={isPullRefreshing}
                  isComplete={isPullComplete}
                  pullDistanceRef={pullDistanceRef}
              />
          )}
          <div className="absolute inset-0 pointer-events-none z-50">
              <div
                  ref={marqueeOverlayRef}
                  className="absolute border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/20 opacity-50 pointer-events-none"
                  style={{ display: 'none', left: 0, top: 0, width: 0, height: 0, willChange: 'left, top, width, height', transform: 'translateZ(0)' }}
              />
          </div>

          <div
              ref={contentRef}
              className="file-grid-content"
          >
          {displayFileIds.length === 0 && activeTab.viewMode === 'browser' ? (
              <EmptyFolderPlaceholder
                  isRefreshing={getFileNode(activeTab.folderId)?.isRefreshing}
                  onRefresh={() => { onRefresh?.(); }}
                  t={t}
              />
          ) : activeTab.viewMode === 'people-overview' ? (
              <PersonGrid
                  people={people || {}}
                  files={files || {}}
                  topics={topics}
                  selectedPersonIds={activeTab.selectedPersonIds}
                  onPersonClick={handlePersonClick}
                  onPersonDoubleClick={handlePersonDoubleClick}
                  onPersonContextMenu={handlePersonContextMenu}
                  onStartRenamePerson={onStartRenamePerson}
                  t={t}
                  thumbnailSize={thumbnailSize}
                  containerRect={containerRect}
                  scrollTop={scrollTop}
                  containerRef={containerRef}
                  sortBy={personSortBy}
                  sortDirection={personSortDirection}
                  groupBy={personGroupBy}
                  resourceRoot={effectiveResourceRoot}
              />
          ) : groupBy !== 'none' && groupedFiles && groupedFiles.length > 0 ? (
              <div className="w-full min-w-0">
                  {groupedFiles.map((group) => (
                      <div key={group.id} className={collapsedGroups[group.id] ? 'mb-2' : 'mb-8'}>
                          <GroupHeader
                              group={group}
                              collapsed={!!collapsedGroups[group.id]}
                              onToggle={handleToggleGroup}
                          />
                          {!collapsedGroups[group.id] && (
                              <GroupContent
                                  group={group}
                                  getFileNode={getFileNode}
                                  activeTab={activeTab}
                                  renamingId={renamingId}
                                  thumbnailSize={thumbnailSize}
                                  hoverPlayingId={hoverPlayingId}
                                  handleFileClick={handleFileClick}
                                  handleFileDoubleClick={handleFileDoubleClick}
                                  handleContextMenu={handleContextMenu}
                                  handleStartRename={handleStartRename}
                                  handleRenameSubmit={handleRenameSubmit}
                                  handleRenameCancel={handleRenameCancel}
                                  handleSetHoverPlayingId={handleSetHoverPlayingId}
                                  settings={settings}
                                  containerRect={containerRect}
                                  scrollTop={scrollTop}
                                  t={t}
                                  resourceRoot={effectiveResourceRoot}
                                  cachePath={effectiveCachePath}
                                  onDragStart={onDragStart}
                                  onDragEnd={onDragEnd}
                                  setIsDraggingInternal={setIsDraggingInternal}
                                  setDraggedFilePaths={setDraggedFilePaths}
                                  onFileLongPress={onFileLongPress}
                                  onShowContextMenuForFile={onShowContextMenuForFile}
                                  isAndroidSelectionMode={isAndroidSelectionMode}
                                  onAndroidRangeSelect={onAndroidRangeSelect}
                              />
                          )}
                      </div>
                  ))}
              </div>
          ) : activeTab.layoutMode === 'list' ? (
              <div className="w-full h-full min-w-0">
                  <div className="relative w-full" style={{ height: totalHeight }}>
                      {visibleItems.map((item) => {
                          const file = getFileNode(item.id);
                          if (!file) return null;
                          return (
                              <div 
                                key={file.id} 
                                className="absolute"
                                style={{ 
                                    transform: `translate(${item.x}px, ${item.y}px)`,
                                    width: item.width, 
                                    height: item.height 
                                }}
                              >
                                  <FileListItem
                                      file={file}
                                      getFileNode={getFileNode}
                                      isSelected={activeTab.selectedFileIds.includes(file.id)}
                                      renamingId={renamingId}
                                      onFileClick={handleFileClick}
                                      onFileDoubleClick={handleFileDoubleClick}
                                      onContextMenu={handleContextMenu}
                                      onStartRename={onStartRename}
                                      onRenameSubmit={onRenameSubmit}
                                      onRenameCancel={onRenameCancel}
                                      t={t}
                                      resourceRoot={effectiveResourceRoot}
                                      cachePath={effectiveCachePath}
                                      selectedFileIds={activeTab.selectedFileIds}
                                      onDragStart={onDragStart}
                                      onDragEnd={onDragEnd}
                                      thumbnailSize={thumbnailSize}
                                      setIsDraggingInternal={setIsDraggingInternal}
                                      setDraggedFilePaths={setDraggedFilePaths}
                                      onFileLongPress={onFileLongPress}
                                      onShowContextMenuForFile={onShowContextMenuForFile}
                                      isAndroidSelectionMode={isAndroidSelectionMode}
                                      onAndroidRangeSelect={onAndroidRangeSelect}
                                  />
                              </div>
                          );
                      })}
                  </div>
              </div>
          ) : (
              <div className="w-full min-w-0" style={{ position: 'relative', minHeight: '100%' }}>
                  <div className="min-w-0" style={{ position: 'relative' }}>
                      {/* Fixed height container to prevent scroll bounce */}
                      <div
                          className="relative min-w-0"
                          style={{
                              width: '100%',
                              maxWidth: '100%',
                              height: totalHeight,
                              position: 'relative'
                          }}
                      >
                          {visibleItems.map((item) => {
                              const file = getFileNode(item.id);
                              if (!file) return null;
                              
                              return (
                                  <FileCard
                                      key={file.id}
                                      file={file}
                                      getFileNode={getFileNode}
                                      isSelected={activeTab.selectedFileIds.includes(file.id)}
                                      renamingId={renamingId}
                                      layoutMode={activeTab.layoutMode}
                                      hoverPlayingId={hoverPlayingId}
                                      onFileClick={handleFileClick}
                                      onFileDoubleClick={handleFileDoubleClick}
                                      onContextMenu={handleContextMenu}
                                      onStartRename={onStartRename}
                                      onRenameSubmit={handleRenameSubmit}
                                      onRenameCancel={handleRenameCancel}
                                      onSetHoverPlayingId={handleSetHoverPlayingId}
                                      settings={settings}
                                      style={item}
                                      resourceRoot={effectiveResourceRoot}
                                      cachePath={effectiveCachePath}
                                      selectedFileIds={activeTab.selectedFileIds}
                                      onDragStart={onDragStart}
                                      onDragEnd={onDragEnd}
                                      thumbnailSize={thumbnailSize}
                                      setIsDraggingInternal={setIsDraggingInternal}
                                      setDraggedFilePaths={setDraggedFilePaths}
                                      onFileLongPress={onFileLongPress}
                                      onShowContextMenuForFile={onShowContextMenuForFile}
                                      isAndroidSelectionMode={isAndroidSelectionMode}
                                      onAndroidRangeSelect={onAndroidRangeSelect}
                                  />
                              );
                          })}
                      </div>
                  </div>
              </div>
          )}
          </div>
      </div>
  );
});
