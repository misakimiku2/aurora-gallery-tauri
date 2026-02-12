
import React, { useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { LayoutMode, FileNode, FileType, TabState, Person, GroupByOption, FileGroup } from '../types';
import { getFolderPreviewImages, formatSize } from '../utils/mockFileSystem';
import { Image as ImageIcon, Check, Folder, Tag, User, ChevronDown, Book, Film } from 'lucide-react';
import md5 from 'md5';
import { startDragToExternal } from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useLayout, LayoutItem } from './useLayoutHook';
import { PersonGrid } from './PersonGrid';
import { TagsList } from './TagsList';
import { performanceMonitor } from '../utils/performanceMonitor';
import { getGlobalCache, getThumbnailPathCache } from '../utils/thumbnailCache';
import { throttle } from '../utils/debounce';
import { useInView } from '../hooks/useInView';
import { Folder3DIcon } from './Folder3DIcon';
import { ImageThumbnail } from './ImageThumbnail';
import { FolderThumbnail } from './FolderThumbnail';
import { InlineRenameInput } from './InlineRenameInput';
import { FileListItem } from './FileListItem';

const sortKeys = (keys: string[]) => keys.sort((a, b) => {
    if (a === '0-9') return -1; if (b === '0-9') return 1;
    if (a === '#') return 1; if (b === '#') return -1;
    return a.localeCompare(b);
});

const FileCard = React.memo(({
  file,
  files,
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
  setDraggedFilePaths
}: any) => {
  const [isDragging, setIsDragging] = useState(false);
  if (!file) return null;

  // Extract layout positioning
  const { x, y, width, height } = style || { x: 0, y: 0, width: 200, height: 200 };
  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);

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
    const filePaths = filesToDrag.map((fileId: string) => files[fileId]?.path || '').filter(Boolean);
    
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
      const draggedFile = files[draggedFileId];
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
    const draggedFiles = filesToDrag.map((fileId: string) => files[fileId]).filter((Boolean as unknown) as (file: FileNode | undefined) => file is FileNode);
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
            file-item group cursor-pointer transition-all duration-300 ease-out flex flex-col items-center rounded-xl
            ${isSelected ? 'z-10' : 'z-0 hover:scale-[1.01]'}
            ${isDragging ? 'opacity-50 scale-95 drop-shadow-lg' : ''}
        `}
        style={{
            position: 'absolute',
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
            willChange: 'transform'
        }}
        draggable={renamingId !== file.id}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onMouseDown={async (e) => {
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
                        .map((fileId: string) => files[fileId]?.path || '')
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
            onFileClick(e, file.id);
        }}
        onDoubleClick={(e) => {
            e.stopPropagation();
            onFileDoubleClick(file.id);
        }}
        onContextMenu={(e) => onContextMenu(e, file.id)}
        onMouseEnter={() => {
            // 锟斤拷锟侥硷拷锟斤拷锟斤拷取锟斤拷式锟斤拷为fallback
            const fileName = file.name;
            const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
            const isAnimationFormat = (file.meta?.format === 'gif' || file.meta?.format === 'webp') || (fileExt === 'gif' || fileExt === 'webp');
            
            if (settings?.animateOnHover && isAnimationFormat) {
                onSetHoverPlayingId(file.id);
            }
        }}
        onMouseLeave={() => {
            onSetHoverPlayingId(null);
        }}>
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
            <FolderThumbnail file={file} files={files} mode={layoutMode} resourceRoot={effectiveResourceRoot} cachePath={effectiveCachePath} />
            ) : (
            <ImageThumbnail
                src={''}
                alt={file.name}
                isSelected={isSelected}
                filePath={file.path}
                modified={file.updatedAt}
                size={file.size}
                isHovering={hoverPlayingId === file.id}
                fileMeta={file.meta}
                resourceRoot={effectiveResourceRoot}
                cachePath={effectiveCachePath}
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
    </div>
  );
});

const GroupContent = React.memo(({
  group,
  files,
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
  setDraggedFilePaths
}: any) => {
  const groupRef = useRef<HTMLDivElement>(null);
  const [offsetTop, setOffsetTop] = useState(0);

  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  
  // Calculate layout for this group
  const { layout, totalHeight } = useLayout(
    group.fileIds,
    files,
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
      // 降低渲染缓冲区，从 800px 减少到 400px
      const buffer = 400; 
      // 计算相对于当前分组坐标系的视口范围
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
            const file = files[item.id];
            if (!file) return null;
            return (
              <div 
                key={file.id} 
                className="absolute"
                style={{ 
                    top: item.y, 
                    left: item.x, 
                    width: item.width, 
                    height: item.height 
                }}
              >
                  <FileListItem
                      file={file}
                      files={files}
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
            const file = files[item.id];
            if (!file) return null;
            
            return (
              <FileCard
                key={file.id}
                file={file}
                files={files}
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
  files: Record<string, FileNode>;
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
}

export const FileGrid: React.FC<FileGridProps> = ({
  displayFileIds,
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
  onConsumeScrollToItem
}) => {
  // #region agent log
  // Removed debug logs
  // #endregion

  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);

  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  // 节流处理滚动位置同步到全局状态，减少全局重绘
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
    }

    let animationFrameId: number;
    const observer = new ResizeObserver((entries) => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        
        animationFrameId = requestAnimationFrame(() => {
            for (const entry of entries) {
                if (entry.target === containerRef.current) {
                    setContainerRect({ width: entry.contentRect.width, height: entry.contentRect.height });
                }
            }
        });
    });
    observer.observe(containerRef.current);
    
    // Use a stable handler ref or check current status inside handler
    const handleScroll = () => {
        if (containerRef.current) {
            // Skip reporting scroll updates if we are in the middle of restoring
            // or if layout is likely invalid (width 0)
            if (isRestoringScrollRef.current || containerRef.current.clientWidth === 0) {
                return;
            }

            const currentScroll = containerRef.current.scrollTop;
            const targetScroll = targetScrollRef.current; // Use ref to avoid closure trap

            // Defense against clamping:
            // If we haven't successfully restored yet, and the current scroll is significantly smaller
            // than the target scroll, it's likely due to container height being insufficient (clamped).
            // In this case, we should NOT update the parent state, so the original target remains for
            // subsequent attempts (e.g. after layout resize).
            if (!hasRestoredRef.current && targetScroll > 0 && currentScroll < targetScroll - 100) {
                 return;
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
    };
  }, [containerRef]);

  const { layout, totalHeight } = useLayout(
      activeTab.viewMode === 'people-overview' ? [] : displayFileIds,
      files,
      activeTab.layoutMode,
      containerRect.width,
      thumbnailSize,
      activeTab.viewMode as any,
      groupedTags,
      people,
      activeTab.searchQuery
  );

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

  const visibleItems = useMemo(() => {
      // 降低渲染缓冲区，从 800px 减少到 400px (约 2 排缩略图)
      // 这能显著减少冗余渲染，同时保持滚动时的视觉连贯性
      const buffer = 400; 
      const minY = scrollTop - buffer;
      const maxY = scrollTop + containerRect.height + buffer;
      return layout.filter(item => item.y < maxY && item.y + item.height > minY);
  }, [layout, scrollTop, containerRect.height, totalHeight]);

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

  const sortedKeys = useMemo(() => {
      if (!groupedTags) return [];
      const keys = Object.keys(groupedTags);
      return sortKeys(keys);
  }, [groupedTags]);

  if (activeTab.viewMode === 'tags-overview') {
      return (
          <div
              ref={containerRef}
              id="file-grid-container"
              className="w-full h-full overflow-y-auto overflow-x-hidden px-6 pb-6 relative"
              onContextMenu={onBackgroundContextMenu}
              onMouseDown={handleMouseDownInternal}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
          >
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
              <TagsList
                  groupedTags={groupedTags || {}}
                  keys={sortedKeys}
                  files={files}
                  selectedTagIds={activeTab.selectedTagIds}
                  onTagClick={handleTagClickStable}
                  onTagDoubleClick={handleTagDoubleClickStable}
                  onTagContextMenu={handleTagContextMenuStable}
                  t={t}
                  searchQuery={activeTab.searchQuery}
                  layout={layout}
                  totalHeight={totalHeight}
                  scrollTop={scrollTop}
                  containerHeight={containerRect.height}
                  resourceRoot={resourceRoot}
              />
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
              const folder = files[folderId];
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
                  const targetFolder = files[targetFolderId];
                  
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
                      const file = files[id];
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
          className={`relative w-full h-full min-w-0 overflow-y-auto overflow-x-hidden transition-all duration-200 ${isDraggingOver ? 'bg-gradient-to-b from-blue-50 to-transparent dark:from-blue-900/15 dark:to-transparent border-2 border-dashed border-blue-300 dark:border-blue-700/50' : ''}`}
          onContextMenu={onBackgroundContextMenu}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={() => {
              const allFolders = document.querySelectorAll('.file-item[data-id]');
              allFolders.forEach(el => el.classList.remove('drop-target-active'));
          }}
      >
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

          {activeTab.viewMode === 'people-overview' ? (
              <PersonGrid
                  people={people || {}}
                  files={files}
                  selectedPersonIds={activeTab.selectedPersonIds}
                  onPersonClick={handlePersonClick}
                  onPersonDoubleClick={handlePersonDoubleClick}
                  onPersonContextMenu={handlePersonContextMenu}
                  onStartRenamePerson={onStartRenamePerson}
                  t={t}
                  thumbnailSize={thumbnailSize}
                  containerRect={containerRect}
                  scrollTop={activeTab.scrollTop}
                  containerRef={containerRef}
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
                                  files={files}
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
                              />
                          )}
                      </div>
                  ))}
              </div>
          ) : activeTab.layoutMode === 'list' ? (
              <div className="w-full h-full min-w-0">
                  <div className="relative w-full" style={{ height: totalHeight }}>
                      {visibleItems.map((item) => {
                          const file = files[item.id];
                          if (!file) return null;
                          return (
                              <div 
                                key={file.id} 
                                className="absolute"
                                style={{ 
                                    top: item.y, 
                                    left: item.x, 
                                    width: item.width, 
                                    height: item.height 
                                }}
                              >
                                  <FileListItem
                                      file={file}
                                      files={files}
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
                              const file = files[item.id];
                              if (!file) return null;
                              
                              return (
                                  <FileCard
                                      key={file.id}
                                      file={file}
                                      files={files}
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
                                  />
                              );
                          })}
                      </div>
                  </div>
              </div>
          )}
      </div>
  );
};
