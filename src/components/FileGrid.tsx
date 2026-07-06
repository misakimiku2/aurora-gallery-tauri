
import React, { useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { LayoutMode, FileNode, FileType, TabState, Person, GroupByOption, FileGroup, Topic } from '../types';
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
import { throttle } from '../utils/debounce';
import { useInView } from '../hooks/useInView';
import { usePinchZoom } from '../hooks/usePinchZoom';
import { Folder3DIcon } from './Folder3DIcon';
import { ImageThumbnail } from './ImageThumbnail';
import { FolderThumbnail } from './FolderThumbnail';
import { InlineRenameInput } from './InlineRenameInput';
import { FileListItem } from './FileListItem';
import { CircularProgressOverlay } from './CircularProgressOverlay';
import { lanNavStep, lanNavActive, lanNavId } from '../utils/lanNavTrace';
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
    
    // 锟斤拷锟斤拷募锟轿达拷锟窖★拷校锟斤拷锟阶憋拷远锟窖★拷锟??
    if (!isSelected) {
      onFileClick(e, file.id);
    }
    
    // 锟斤拷锟斤拷锟斤拷拽锟斤拷锟捷ｏ拷锟斤拷锟斤拷募锟斤拷锟窖★拷校锟斤拷锟阶э拷锟斤拷锟窖★拷械锟斤拷募锟斤拷锟斤拷锟斤拷锟街伙拷锟阶э拷锟角帮拷锟??
    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
      ? selectedFileIds 
      : [file.id];
    
    // 锟秸硷拷锟斤拷锟斤拷拽锟侥硷拷锟斤拷实锟斤拷路锟斤拷
    const filePaths = filesToDrag.map((fileId: string) => getFileNode(fileId)?.path || '').filter(Boolean);
    
    // 锟斤拷锟斤拷锟节诧拷锟斤拷拽锟斤拷锟?
    if (setIsDraggingInternal && setDraggedFilePaths) {
      setIsDraggingInternal(true);
      setDraggedFilePaths(filePaths);
    }
    
    // 锟斤拷锟斤拷锟斤拷拽锟斤拷锟斤拷
    try {
      // 1. 锟斤拷锟斤拷JSON锟斤拷式锟斤拷锟斤拷拽锟斤拷锟捷ｏ拷锟斤拷锟斤拷锟节诧拷锟斤拷锟斤拷
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        internalDrag: true // 锟斤拷锟斤拷锟节诧拷锟斤拷拽锟斤拷锟?
      }));
      
      // 2. 锟斤拷锟斤拷text/uri-list锟斤拷式锟斤拷锟斤拷锟斤拷锟解部锟侥硷拷锟斤拷??
      const uriList = filePaths.map((path: string) => `file://${path.replace(/\\/g, '/')}`).join('\n');
      e.dataTransfer.setData('text/uri-list', uriList);
      
      // 3. 锟斤拷锟矫简单碉拷锟侥憋拷锟斤拷锟捷ｏ拷锟斤拷锟斤拷锟斤拷示锟斤拷拽锟斤拷??
      const textData = `${filesToDrag.length} file${filesToDrag.length > 1 ? 's' : ''} selected`;
      e.dataTransfer.setData('text/plain', textData);
      
      // 锟斤拷锟斤拷锟斤拷拽效锟斤拷
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (error) {
      // Error handling for drag data setup
    }
    
    // 锟斤拷锟斤拷锟斤拷拽锟斤拷锟斤拷图锟斤拷??
    // 锟斤拷锟斤拷锟斤拷图锟斤拷锟叫★拷锟轿э拷锟?00px-480px
    // 锟斤拷拽锟斤拷锟斤拷图锟斤拷小锟斤拷围锟斤拷100px-380px
    // 锟斤拷锟斤拷映锟戒：dragThumbSize = 100 + (mainThumbSize - 100) * (280 / 380)
    const mainThumbSize = thumbnailSize; // 锟斤拷锟斤拷锟斤拷图锟斤拷锟??
    const minMainSize = 100;
    const maxMainSize = 480;
    const minDragSize = 100;
    const maxDragSize = 380;
    
    // 锟斤拷锟斤拷映锟斤拷锟斤拷锟斤拷锟阶э拷锟斤拷锟酵硷拷锟叫?
    const dragThumbSize = Math.min(maxDragSize, Math.max(minDragSize, 
        minDragSize + (mainThumbSize - minMainSize) * ((maxDragSize - minDragSize) / (maxMainSize - minMainSize))
    ));
    
    // 锟脚伙拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷时DOM元锟斤拷锟斤拷为锟斤拷拽预锟斤拷
    // 锟斤拷锟街凤拷锟斤拷锟斤拷Canvas锟斤拷锟缴匡拷锟斤拷锟斤拷锟斤拷锟斤拷Canvas锟斤拷锟狡碉拷时锟斤拷锟斤拷??
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
    
    // 锟斤拷取全锟街伙拷锟斤拷
    const cache = getGlobalCache();
    
    // 锟斤拷锟斤拷锟斤拷锟斤拷图锟斤拷??
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.position = 'relative';
    thumbnailsContainer.style.width = '100%';
    thumbnailsContainer.style.height = '100%';
    thumbnailsContainer.style.display = 'flex';
    thumbnailsContainer.style.alignItems = 'center';
    thumbnailsContainer.style.justifyContent = 'center';
    
    // 锟斤拷锟斤拷锟??锟斤拷锟斤拷锟斤拷图
    const previewCount = Math.min(filesToDrag.length, 3);
    
    // 确锟斤拷锟斤拷拽锟斤拷锟侥硷拷锟斤拷示锟斤拷预锟斤拷锟叫ｏ拷锟斤拷锟斤拷锟斤拷锟饺硷拷锟斤拷??
    // 1. 锟斤拷锟斤拷锟斤拷锟接碉拷前锟斤拷拽锟斤拷锟侥硷拷锟斤拷file锟斤拷锟斤拷锟斤拷锟斤拷锟矫伙拷锟斤拷锟斤拷锟斤拷拽锟斤拷锟侥硷拷锟斤拷
    // 2. 然锟斤拷锟绞ｏ拷锟窖★拷械锟斤拷募锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷募锟斤拷锟斤拷锟斤拷锟斤拷????
    const previewFiles: string[] = [];
    
    // 确锟斤拷锟斤拷前锟斤拷拽锟斤拷锟侥硷拷锟斤拷预锟斤拷??
    previewFiles.push(file.id);
    
    // 锟斤拷剩锟斤拷选锟叫碉拷锟侥硷拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟侥硷拷锟斤拷锟斤拷锟斤拷锟斤拷??
    for (const fileId of filesToDrag) {
      if (fileId !== file.id && previewFiles.length < previewCount) {
        previewFiles.push(fileId);
      }
    }
    
    // 锟斤拷锟斤拷每锟斤拷锟侥硷拷锟斤拷锟斤拷锟斤拷图
    for (let i = 0; i < previewFiles.length; i++) {
      const draggedFileId = previewFiles[i];
      const draggedFile = getFileNode(draggedFileId);
      if (!draggedFile) continue;
      
      // 锟斤拷取锟斤拷锟斤拷锟斤拷锟斤拷锟酵?
      const cachedThumb = draggedFile.type === FileType.IMAGE ? cache.get(draggedFile.path) : null;
      
      // 锟斤拷锟姐单锟斤拷锟斤拷锟斤拷图锟竭寸（锟斤拷锟斤拷锟斤拷拽锟斤拷锟斤拷锟斤拷小??
      // 锟斤拷锟接碉拷锟斤拷锟斤拷锟斤拷图锟竭寸，锟斤拷锟斤拷锟斤拷锟斤拷75%锟斤拷锟斤拷??0%锟斤拷确锟斤拷锟节诧拷锟斤拷示锟斤拷锟斤拷锟斤拷图锟斤拷??
      const singleThumbSize = dragThumbSize * 0.9; // 锟斤拷锟斤拷锟斤拷锟斤拷图锟竭达拷为锟斤拷锟斤拷??0%
      
      // 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷图元??
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
      
      // 锟斤拷锟斤拷z-index锟斤拷确锟斤拷锟斤拷拽锟斤拷锟侥硷拷锟斤拷示锟斤拷锟斤拷前锟斤拷
      thumbElement.style.zIndex = `${previewCount - i}`;
      
      // 锟斤拷锟斤拷位锟矫猴拷锟斤拷转锟斤拷使锟斤拷CSS锟戒换??
      const rotation = i === 0 ? 0 : (i === 1 ? -8 : 8);
      // 偏锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷
      const offsetScale = singleThumbSize / 150; // 锟斤拷锟斤拷150px锟侥伙拷准锟斤拷??
      const offsetX = i === 0 ? 0 : (i === 1 ? -10 * offsetScale : 10 * offsetScale);
      const offsetY = i * 12 * offsetScale;
      thumbElement.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`;
      
      // 锟斤拷锟斤拷锟斤拷锟斤拷图锟斤拷占位??
      if (cachedThumb) {
        // 使锟斤拷锟窖伙拷锟斤拷锟斤拷锟斤拷锟酵糢RL
        const img = document.createElement('img');
        img.src = cachedThumb;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.objectPosition = 'center';
        img.draggable = false;
        thumbElement.appendChild(img);
      } else {
        // 锟斤拷锟斤拷占位??
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
          // 锟斤拷锟斤拷锟侥硷拷锟斤拷锟斤拷占位??
          thumbElement.innerHTML = `<div style="font-size: 32px;">??</div>`;
        }
      }
      
      thumbnailsContainer.appendChild(thumbElement);
    }
    
    // 锟斤拷锟斤拷锟侥硷拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟??锟斤拷锟斤拷
    if (filesToDrag.length > 3) {
      const count = filesToDrag.length - 3;
      const countBadge = document.createElement('div');
      countBadge.style.position = 'absolute';
      // 锟斤拷锟斤拷锟斤拷锟斤拷位锟矫帮拷锟斤拷锟斤拷锟斤拷??
      const badgeSize = 40 * (dragThumbSize / 200); // 锟斤拷锟斤拷200px锟斤拷锟斤拷??0px锟斤拷锟斤拷
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
    
    // 锟斤拷锟接碉拷锟斤拷??
    dragImageContainer.appendChild(thumbnailsContainer);
    document.body.appendChild(dragImageContainer);
    
    // 锟斤拷锟斤拷锟斤拷拽图锟斤拷
    try {
      // 锟斤拷拽图锟斤拷偏锟斤拷锟斤拷应为锟斤拷锟斤拷锟竭达拷锟揭伙拷耄凤拷锟斤拷锟斤拷指锟斤拷锟斤拷锟斤拷??
      const dragOffset = dragThumbSize / 2;
      e.dataTransfer.setDragImage(dragImageContainer, dragOffset, dragOffset);
    } catch (error) {
      // Error handling for drag image setup
    }
    
    // 锟斤拷锟斤拷锟斤拷拽效锟斤拷为move锟斤拷锟斤拷锟斤拷锟节诧拷锟斤拷??
    e.dataTransfer.effectAllowed = 'move';
    
    // 锟斤拷取要锟斤拷拽锟斤拷实锟斤拷锟侥硷拷路锟斤拷
    const draggedFiles = filesToDrag.map((fileId: string) => getFileNode(fileId)).filter((Boolean as unknown) as (file: FileNode | undefined) => file is FileNode);
    const draggedFilePaths = draggedFiles.map((file: FileNode) => file.path);
    
    // 锟斤拷锟斤拷锟节诧拷锟斤拷拽锟斤拷锟?
    if (setIsDraggingInternal) {
      setIsDraggingInternal(true);
    }
    
    // 锟斤拷锟斤拷锟斤拷拽锟斤拷锟侥硷拷路??
    if (setDraggedFilePaths) {
      setDraggedFilePaths(draggedFilePaths);
    }
    
    try {
      // 锟斤拷锟斤拷JSON锟斤拷式锟斤拷锟斤拷拽锟斤拷锟捷ｏ拷锟斤拷锟斤拷锟节诧拷锟斤拷锟斤拷
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        // 锟斤拷锟斤拷锟节诧拷锟斤拷拽锟斤拷锟?
        internalDrag: true
      }));
      
      // 锟斤拷锟斤拷锟斤拷锟解部锟斤拷拽锟斤拷锟捷ｏ拷锟斤拷锟解触锟斤拷锟解部锟斤拷拽锟斤拷为
      // 锟斤拷锟角斤拷锟斤拷锟斤拷拽锟斤拷锟斤拷时锟斤拷锟斤拷欠锟斤拷锟阶э拷锟斤拷锟斤拷锟??
    } catch (error) {
      console.error('Drag data setup error:', error);
    }
    
    // 通知锟斤拷锟斤拷锟斤拷锟绞硷拷锟??
    if (onDragStart) {
      onDragStart(filesToDrag);
    }
    
    // 锟斤拷锟斤拷拽锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷时元锟斤拷
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
    
    // 锟斤拷锟斤拷诓锟斤拷锟阶э拷锟斤拷
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
            willChange: 'transform',
            transition: 'transform 300ms ease-out',
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
                
                // 锟斤拷住 Alt 锟斤拷时锟斤拷锟斤拷锟斤拷锟解部锟斤拷拽锟斤拷锟斤拷锟斤拷锟侥硷拷锟斤拷锟解部应锟矫ｏ拷
                if (e.altKey && isTauriEnvironment()) {
                    e.preventDefault();
                    
                    // 锟斤拷取要锟斤拷拽锟斤拷锟侥硷拷
                    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
                        ? selectedFileIds 
                        : [file.id];
                    
                    // 锟秸硷拷锟斤拷锟斤拷拽锟侥硷拷锟斤拷实锟斤拷路锟斤拷
                    const filePaths = filesToDrag
                        .map((fileId: string) => getFileNode(fileId)?.path || '')
                        .filter(Boolean);
                    
                    if (filePaths.length > 0) {
                        setIsDragging(true);
                        
                        // 锟斤拷锟斤拷锟节诧拷锟斤拷拽锟斤拷牵锟斤拷锟街癸拷锟斤拷锟斤拷獠匡拷锟斤拷敫诧拷遣锟?
                        if (setIsDraggingInternal) {
                            setIsDraggingInternal(true);
                        }
                        
                        // 锟斤拷取锟斤拷锟斤拷图路锟斤拷锟斤拷锟斤拷??锟斤拷锟斤拷
                        const pathCache = getThumbnailPathCache();
                        const thumbnailPaths = filePaths
                            .slice(0, 3)
                            .map((fp: string) => pathCache.get(fp))
                            .filter((p: string | undefined): p is string => !!p);
                        
                        // 锟斤拷锟姐缓锟斤拷目录
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
                w-full flex-1 rounded-lg overflow-hidden border shadow-sm relative transition-all duration-300
                ${isSelected ? 'border-blue-500 border-2 ring-4 ring-blue-300/60 dark:ring-blue-700/60 shadow-lg shadow-blue-200/50 dark:shadow-blue-900/30' : isDragging ? 'border-blue-400 border-2 dashed bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-800 hover:border-gray-400 dark:hover:border-gray-500 bg-gray-100 dark:bg-gray-800'}
            `}
            style={{ 
                height: height ? (height - 40) : '100%',
                overflow: 'hidden'
            }}
        >
            {file.type === FileType.FOLDER ? (
            <FolderThumbnail file={file} getFileNode={getFileNode} mode={layoutMode} resourceRoot={effectiveResourceRoot} cachePath={effectiveCachePath} />
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
            
            <div className={`absolute top-2 left-2 transition-opacity duration-200 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
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
                className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate w-full"
                title={file.name}
                onDoubleClick={(e) => {
                e.stopPropagation();
                onStartRename(file.id);
                }}
            >
                {file.name}
            </div>
            )}
            {file.type === FileType.IMAGE && (
            <div className="text-[9px] text-gray-400 truncate">
              {file.meta ? `${file.meta.width || 0}x${file.meta.height || 0}` : ''}
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
      className="flex items-center py-1 px-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors sticky top-0 z-20"
      onClick={() => onToggle(group.id)}
    >
      <div className={`mr-2 p-1 rounded-full transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}>
        <ChevronDown size={16} className="text-gray-500" />
      </div>
      <span className="font-bold text-sm text-gray-700 dark:text-gray-200">{group.title}</span>
      <span className="ml-2 text-xs text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full">{group.fileIds.length}</span>
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
  selectionBox?: { startX: number; startY: number; currentX: number; currentY: number } | null;
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
  selectionBox,
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
  panelWidthRem
}: FileGridProps) => {
  // #region agent log
  // Removed debug logs
  // #endregion

  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  const isAndroid = effectiveResourceRoot === 'android_media_store';

  const contentRef = useRef<HTMLDivElement>(null);
  const pullDistanceRef = useRef(0);

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

  usePinchZoom(containerRef, {
    onPinchStart: useCallback(() => {
      pinchStartSizeRef.current = thumbnailSize;
    }, [thumbnailSize]),
    onPinchZoom: useCallback((totalScale: number) => {
      if (!onThumbnailSizeChange) return;
      const maxLimit = activeTab.viewMode === 'people-overview' ? 450 : 480;
      const minLimit = activeTab.viewMode === 'people-overview' ? 140 : 100;
      const newSize = Math.max(minLimit, Math.min(maxLimit, Math.round(pinchStartSizeRef.current * totalScale)));
      onThumbnailSizeChange(newSize);
    }, [onThumbnailSizeChange, activeTab.viewMode]),
  });

  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const containerWidthRef = useRef(0);
  const widthDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPanelWidthRemRef = useRef<number | undefined>(undefined);
  // 跟踪 isVisible：ResizeObserver 在容器隐藏时仍会触发（display:none→width=0），
  // 用 ref 在回调内读取最新值，避免把 0 写入 containerWidth 触发不必要的布局重算。
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const scrollStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTimeRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const prevLayoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevScrollTopForFlipRef = useRef(0);
  // Layout transition tracking: increases buffer so cards in the NEW viewport
  // are mounted before the FLIP WAAPI animation runs.
  const [isLayoutTransitioning, setIsLayoutTransitioning] = useState(false);
  const isLayoutTransitioningRef = useRef(false);
  const prevThumbnailSizeRef = useRef(thumbnailSize);
  const prevContainerWidthRef = useRef(containerRect.width);
  const transitionBufferRef = useRef(400);
  const transitionResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipDebugLogRef = useRef(0);
  // Two-phase FLIP: when scrollDelta is large, phase 0 expands buffer + updates scrollTop
  // (mounts cards at new viewport), phase 1 runs the WAAPI animation.
  const [flipPhase, setFlipPhase] = useState(0);
  const pendingFlipDataRef = useRef<{ oldScrollTop: number; newScrollTop: number } | null>(null);

  const throttledOnScrollTopChange = useMemo(() => 
    onScrollTopChange ? throttle(onScrollTopChange, 100) : undefined
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
    }

    let animationFrameId: number;
    const observer = new ResizeObserver((entries) => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);

        animationFrameId = requestAnimationFrame(() => {
            for (const entry of entries) {
                if (entry.target === containerRef.current) {
                    const newWidth = entry.contentRect.width;
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
                        setContainerRect(prev => ({ width: containerWidthRef.current, height: prev.height }));
                    }, 60);
                }
            }
        });
    });
    observer.observe(containerRef.current);
    
    // Use a stable handler ref or check current status inside handler
    const handleScroll = () => {
        if (containerRef.current) {
            if (isRestoringScrollRef.current || containerRef.current.clientWidth === 0) {
                return;
            }

            const currentScroll = containerRef.current.scrollTop;
            const targetScroll = targetScrollRef.current;

            if (!hasRestoredRef.current && targetScroll > 0 && currentScroll < targetScroll - 100) {
                 return;
            }

            const now = Date.now();
            const dt = now - lastScrollTimeRef.current;
            const dy = Math.abs(currentScroll - lastScrollTopRef.current);
            lastScrollTimeRef.current = now;
            lastScrollTopRef.current = currentScroll;

            if (isAndroid && dt > 0) {
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

            setScrollTop(currentScroll);
            throttledOnScrollTopChange?.(currentScroll);
            onScroll?.();
        }
    };
    containerRef.current.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        observer.disconnect();
        containerRef?.current?.removeEventListener('scroll', handleScroll);
        if (widthDebounceRef.current) clearTimeout(widthDebounceRef.current);
    };
  }, [containerRef, activeTab.viewMode]);

  // Predict container width immediately when panels toggle, so card transitions
  // run simultaneously with the panel animation instead of waiting for ResizeObserver
  useEffect(() => {
    if (panelWidthRem === undefined) return;
    if (prevPanelWidthRemRef.current !== undefined && prevPanelWidthRemRef.current !== panelWidthRem) {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const deltaRem = prevPanelWidthRemRef.current - panelWidthRem;
      const deltaPx = deltaRem * remPx;
      if (containerWidthRef.current > 0) {
        const predictedWidth = containerWidthRef.current + deltaPx;
        setContainerRect(prev => ({ width: predictedWidth, height: prev.height }));
        containerWidthRef.current = predictedWidth;
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

  // FLIP animation: anchor at viewport top instead of page top.
  // Only applies to non-grouped views where the top-level layout is used for rendering.
  const isNonGroupedView = groupBy === 'none' || !groupedFiles || groupedFiles.length === 0;

  // Sync isLayoutTransitioning to ref for use inside FLIP effect (avoids stale closure / extra deps)
  useEffect(() => {
    isLayoutTransitioningRef.current = isLayoutTransitioning;
  }, [isLayoutTransitioning]);

  // Watch layout input changes: set transition state + predict buffer size so the
  // new viewport's cards are mounted BEFORE the new layout arrives from the worker.
  // Only activates for thumbnail size changes — width changes (panel toggle) are
  // handled by CSS transition + predicted width, no buffer increase needed.
  useEffect(() => {
    const prevThumb = prevThumbnailSizeRef.current;
    const prevWidth = prevContainerWidthRef.current;
    const currWidth = containerRect.width;
    const thumbChanged = prevThumb !== thumbnailSize;
    const widthChanged = prevWidth !== currWidth && prevWidth > 0 && currWidth > 0;

    if (!thumbChanged && !widthChanged) return;
    // Skip if container not visible or not in non-grouped view (FileGrid idle)
    if (currWidth <= 0 || !isNonGroupedView) {
      prevThumbnailSizeRef.current = thumbnailSize;
      prevContainerWidthRef.current = currWidth;
      return;
    }
    // Only increase buffer for thumbnail size changes (large scroll adjustments).
    // For width-only changes (panel toggle), CSS transition + predicted width handles it.
    if (!thumbChanged) {
      prevThumbnailSizeRef.current = thumbnailSize;
      prevContainerWidthRef.current = currWidth;
      return;
    }

    const currentScroll = containerRef?.current?.scrollTop || 0;
    const ratio = prevThumb > 0 ? thumbnailSize / prevThumb : 1;
    const predictedDelta = Math.abs(currentScroll * (1 - ratio));
    const buffer = Math.min(3000, Math.max(1500, predictedDelta + 800));

    transitionBufferRef.current = buffer;
    setIsLayoutTransitioning(true);
    console.log(`[FLIP-FileGrid] TRANSITION START: thumb=${prevThumb}→${thumbnailSize}, width=${prevWidth.toFixed(0)}→${currWidth.toFixed(0)}, scroll=${currentScroll.toFixed(0)}, predictedDelta=${predictedDelta.toFixed(0)}, buffer=${buffer.toFixed(0)}`);

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
    const prevPositions = prevLayoutPositionsRef.current;
    const logId = ++flipDebugLogRef.current;

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
    const oldScrollTop = container.scrollTop;
    const staleScrollTop = prevScrollTopForFlipRef.current;

    console.log(`[FLIP-FileGrid] #${logId} START: layout=${layout.length}, prevPos=${prevPositions.size}, common=${commonCount}`);
    console.log(`[FLIP-FileGrid] #${logId}   scrollTop: live=${oldScrollTop.toFixed(1)}, staleRef=${staleScrollTop.toFixed(1)}, drift=${(oldScrollTop - staleScrollTop).toFixed(1)}`);

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

    const anchorOldY = anchorId ? prevPositions.get(anchorId)?.y : undefined;
    const anchorNewY = anchorId ? layout.find(i => i.id === anchorId)?.y : undefined;
    const scrollDelta = newScrollTop - oldScrollTop;
    console.log(`[FLIP-FileGrid] #${logId}   anchor: id=${(anchorId || '').slice(0, 12)}, oldY=${anchorOldY?.toFixed(0)}, screenY=${anchorOldScreenY.toFixed(0)}, newY=${anchorNewY?.toFixed(0)}, newScroll=${newScrollTop.toFixed(0)}, scrollDelta=${scrollDelta.toFixed(0)}`);

    // If scroll adjustment is negligible, CSS transition on transform handles the animation.
    // No need for WAAPI — this avoids perf cost on panel toggle (width-only changes).
    if (Math.abs(scrollDelta) <= 1) {
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
    // already recorded in prevPositions, so they don't need to be in the DOM. Only new
    // viewport cards need mounting, and the existing transition buffer handles that.
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

    // Apply WAAPI FLIP animation only to cards near old OR new viewport.
    // visibleItems may include many cards (large buffer), but only animate relevant ones.
    const viewportPadding = 400;
    const oldVpMin = actualOldScrollTop - viewportPadding;
    const oldVpMax = actualOldScrollTop + containerHeight + viewportPadding;
    const newVpMin = actualNewScrollTop - viewportPadding;
    const newVpMax = actualNewScrollTop + containerHeight + viewportPadding;

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
          duration: 300,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'none',
        }
      );
      animatedCount++;
    });

    console.log(`[FLIP-FileGrid] #${logId}   WAAPI: animated=${animatedCount}, notFound=${notFoundCount}, skipped=${skippedCount}, visibleTotal=${visibleItems.length}`);

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
  }, [layout, isNonGroupedView, flipPhase]);

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
                  className="flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 relative"
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
                      {selectionBox && (
                          <div
                              className="absolute border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/20 opacity-50 pointer-events-none"
                              style={{
                                  left: Math.min(selectionBox.startX, selectionBox.currentX),
                                  top: Math.min(selectionBox.startY, selectionBox.currentY),
                                  width: Math.abs(selectionBox.currentX - selectionBox.startX),
                                  height: Math.abs(selectionBox.currentY - selectionBox.startY),
                              }}
                          />
                      )}
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
      
      // 锟斤拷锟斤拷欠锟斤拷锟阶э拷锟斤拷募锟斤拷锟斤拷锟?
      const target = e.target as HTMLElement;
      const folderElement = target.closest('.file-item[data-id]');
      if (folderElement) {
          const folderId = folderElement.getAttribute('data-id');
          if (folderId) {
              const folder = getFileNode(folderId);
              if (folder && folder.type === FileType.FOLDER) {
                  // 锟斤拷锟斤拷锟斤拷拽锟斤拷停锟斤拷锟接撅拷效??
                  folderElement.classList.add('drop-target-active');
                  if (onDropOnFolder && dragOverTarget !== folderId) {
                      // 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷泳锟斤拷锟斤拷锟?
                  }
              }
          }
      }
  };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      
      try {
          const data = e.dataTransfer.getData('application/json');
          if (!data) return;
          
          const { type, ids } = JSON.parse(data);
          if (type !== 'file' || !ids || ids.length === 0) return;
          
          // 锟斤拷锟斤拷锟斤拷锟斤拷锟酵Ｗ??
          const allFolders = document.querySelectorAll('.file-item[data-id]');
          allFolders.forEach(el => el.classList.remove('drop-target-active'));
          
          // 锟斤拷锟斤拷欠锟斤拷锟阶э拷锟斤拷囟锟斤拷募锟??
          const target = e.target as HTMLElement;
          const folderElement = target.closest('.file-item[data-id]');
          
          if (folderElement) {
              const targetFolderId = folderElement.getAttribute('data-id');
              if (targetFolderId) {
                  const targetFolder = getFileNode(targetFolderId);
                  
                  if (targetFolder && targetFolder.type === FileType.FOLDER) {
                      // 锟斤拷拽锟斤拷锟侥硷拷锟斤拷
                      if (onDropOnFolder) {
                          onDropOnFolder(targetFolderId, ids);
                      }
                  }
              }
          } else {
              // 锟斤拷拽锟斤拷锟秸帮拷锟斤拷锟斤拷锟狡讹拷锟斤拷锟斤拷前目录锟斤拷
              const currentFolderId = activeTab.folderId;
              if (currentFolderId && onDropOnFolder) {
                  // 锟斤拷锟斤拷欠锟斤拷锟斤拷锟斤拷募锟斤拷锟斤拷丫锟斤拷诘锟角帮拷募锟斤拷锟??
                  const allFilesInCurrentFolder = ids.every((id: string) => {
                      const file = getFileNode(id);
                      return file && file.parentId === currentFolderId;
                  });
                  
                  // 锟斤拷锟斤拷锟斤拷锟斤拷募锟斤拷锟斤拷诘锟角帮拷募锟斤拷锟斤拷校锟斤拷锟街达拷锟斤拷魏尾锟??
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
          className={`relative w-full h-full min-w-0 overflow-y-auto overflow-x-hidden transition-all duration-200 ${isDraggingOver ? 'bg-gradient-to-b from-blue-50 to-transparent dark:from-blue-900/15 dark:to-transparent border-2 border-dashed border-blue-300 dark:border-blue-700/50' : ''}`}
          style={isAndroid ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
          onContextMenu={isAndroid ? undefined : onBackgroundContextMenu}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onDragOver={isAndroid ? undefined : handleDragOver}
          onDrop={isAndroid ? undefined : handleDrop}
          onDragLeave={isAndroid ? undefined : () => {
              const allFolders = document.querySelectorAll('.file-item[data-id]');
              allFolders.forEach(el => el.classList.remove('drop-target-active'));
          }}
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
              {selectionBox && (
                  <div
                      className="absolute border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/20 opacity-50 pointer-events-none"
                      style={{
                          left: Math.min(selectionBox.startX, selectionBox.currentX),
                          top: Math.min(selectionBox.startY, selectionBox.currentY),
                          width: Math.abs(selectionBox.currentX - selectionBox.startX),
                          height: Math.abs(selectionBox.currentY - selectionBox.startY),
                      }}
                  />
              )}
          </div>

          <div
              ref={contentRef}
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
