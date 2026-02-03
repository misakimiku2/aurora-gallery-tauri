
import React, { useState } from 'react';
import { Folder, Image as ImageIcon } from 'lucide-react';
import { FileNode, FileType } from '../types';
import { formatSize } from '../utils/mockFileSystem';
import { isTauriEnvironment } from '../utils/environment';
import { startDragToExternal } from '../api/tauri-bridge';
import { getGlobalCache, getThumbnailPathCache } from '../utils/thumbnailCache';
import { ImageThumbnail } from './ImageThumbnail';
import { InlineRenameInput } from './InlineRenameInput';

export const FileListItem = React.memo(({
  file,
  files,
  isSelected,
  renamingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  t,
  resourceRoot,
  cachePath,
  selectedFileIds,
  onDragStart,
  onDragEnd,
  thumbnailSize,
  setIsDraggingInternal,
  setDraggedFilePaths
}: any) => {
  if (!file) return null;
  
  // Drag handler for list view
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    
    if (!isSelected) {
      onFileClick(e, file.id);
    }
    
    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
      ? selectedFileIds 
      : [file.id];
    
    const filePaths = filesToDrag.map((fileId: string) => files[fileId]?.path || '').filter(Boolean);
    
    if (setIsDraggingInternal && setDraggedFilePaths) {
      setIsDraggingInternal(true);
      setDraggedFilePaths(filePaths);
    }
    
    try {
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        internalDrag: true 
      }));
      
      const uriList = filePaths.map((path: string) => `file://${path.replace(/\\/g, '/')}`).join('\n');
      e.dataTransfer.setData('text/uri-list', uriList);
      
      const textData = `${filesToDrag.length} file${filesToDrag.length > 1 ? 's' : ''} selected`;
      e.dataTransfer.setData('text/plain', textData);
      
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (error) {
      // Error handling
    }
    
    const dragThumbSize = 100;
    
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
    
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.position = 'relative';
    thumbnailsContainer.style.width = '100%';
    thumbnailsContainer.style.height = '100%';
    thumbnailsContainer.style.display = 'flex';
    thumbnailsContainer.style.alignItems = 'center';
    thumbnailsContainer.style.justifyContent = 'center';
    
    const cache = getGlobalCache();
    const previewCount = Math.min(filesToDrag.length, 3);
    const previewFiles: string[] = [];
    previewFiles.push(file.id);
    
    for (const fileId of filesToDrag) {
      if (fileId !== file.id && previewFiles.length < previewCount) {
        previewFiles.push(fileId);
      }
    }
    
    for (let i = 0; i < previewFiles.length; i++) {
      const draggedFileId = previewFiles[i];
      const draggedFile = files[draggedFileId];
      if (!draggedFile) continue;
      
      const cachedThumb = draggedFile.type === FileType.IMAGE ? cache.get(draggedFile.path) : null;
      const singleThumbSize = dragThumbSize * 0.9;
      
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
      
      thumbElement.style.zIndex = `${previewCount - i}`;
      
      const rotation = i === 0 ? 0 : (i === 1 ? -8 : 8);
      const offsetScale = singleThumbSize / 150;
      const offsetX = i === 0 ? 0 : (i === 1 ? -10 * offsetScale : 10 * offsetScale);
      const offsetY = i * 12 * offsetScale;
      thumbElement.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`;
      
      if (cachedThumb) {
        const img = document.createElement('img');
        img.src = cachedThumb;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.objectPosition = 'center';
        img.draggable = false;
        thumbElement.appendChild(img);
      } else {
        if (draggedFile.type === FileType.IMAGE) {
          thumbElement.innerHTML = `<div style="font-size: 32px;">🖼️</div>`;
        } else if (draggedFile.type === FileType.FOLDER) {
          thumbElement.innerHTML = `
            <div style="width: 100%; height: 100%; position: relative;">
              <svg viewBox="0 0 100 100" style="position: absolute; width: 100%; height: 100%; fill: #3b82f6; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));" preserveAspectRatio="none">
                <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" />
              </svg>
              <div style="position: absolute; left: 0; right: 0; bottom: 0; height: 60%; transform: perspective(800px) rotateX(-10deg);">
                <svg viewBox="0 0 100 65" style="width: 100%; height: 100%; fill: #2563eb; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.15));" preserveAspectRatio="none">
                  <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" />
                </svg>
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0.5; mix-blend-mode: overlay;">
                  <svg viewBox="0 0 24 24" style="width: 32px; height: 32px; fill: white; stroke: white; stroke-width: 1.5;" preserveAspectRatio="xMidYMid meet">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                </div>
              </div>
            </div>
          `;
        } else {
          thumbElement.innerHTML = `<div style="font-size: 32px;">📄</div>`;
        }
      }
      
      thumbnailsContainer.appendChild(thumbElement);
    }
    
    if (filesToDrag.length > 3) {
      const count = filesToDrag.length - 3;
      const countBadge = document.createElement('div');
      countBadge.style.position = 'absolute';
      const badgeSize = 40 * (dragThumbSize / 200);
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
    
    dragImageContainer.appendChild(thumbnailsContainer);
    document.body.appendChild(dragImageContainer);
    
    try {
      const dragOffset = dragThumbSize / 2;
      e.dataTransfer.setDragImage(dragImageContainer, dragOffset, dragOffset);
    } catch (error) {
      // Error handling
    }
    
    e.dataTransfer.effectAllowed = 'move';
    
    if (setIsDraggingInternal) {
      setIsDraggingInternal(true);
    }
    
    if (setDraggedFilePaths) {
      setDraggedFilePaths(filePaths);
    }
    
    try {
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        internalDrag: true
      }));
    } catch (error) {
      console.error('Drag data setup error:', error);
    }
    
    if (onDragStart) {
      onDragStart(filesToDrag);
    }
    
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
    
    if (setIsDraggingInternal) {
      setIsDraggingInternal(false);
    }
    
    if (onDragEnd) {
      onDragEnd();
    }
  };
  
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  
  return (
    <div
        data-id={file.id}
        className={`
            file-item flex items-center p-2 rounded text-sm cursor-pointer border transition-colors mb-1 relative
            ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-blue-500 border-l-4 shadow-md' : 'bg-white dark:bg-gray-900 border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'}
            ${isExternalDragging ? 'opacity-50' : ''}
        `}
        onMouseDown={async (e) => {
            if (e.button === 0) {
                e.stopPropagation();
                
                if (e.altKey && isTauriEnvironment()) {
                    e.preventDefault();
                    
                    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
                        ? selectedFileIds 
                        : [file.id];
                    
                    const filePaths = filesToDrag
                        .map((fileId: string) => files[fileId]?.path || '')
                        .filter(Boolean);
                    
                    if (filePaths.length > 0) {
                        setIsExternalDragging(true);
                        
                        if (setIsDraggingInternal) {
                            setIsDraggingInternal(true);
                        }
                        
                        const pathCache = getThumbnailPathCache();
                        const thumbnailPaths = filePaths
                            .slice(0, 3)
                            .map((fp: string) => pathCache.get(fp))
                            .filter((p: string | undefined): p is string => !!p);
                        
                        const cacheDir = resourceRoot 
                            ? `${resourceRoot}${resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache`
                            : undefined;
                        
                        try {
                            await startDragToExternal(filePaths, thumbnailPaths, cacheDir, () => {
                                setIsExternalDragging(false);
                                if (setIsDraggingInternal) {
                                    setIsDraggingInternal(false);
                                }
                            });
                        } catch (error) {
                            console.error('External drag failed:', error);
                            setIsExternalDragging(false);
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
        draggable={true}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}>
        <div className="flex-1 flex items-center overflow-hidden min-w-0 pointer-events-none">
            {file.type === FileType.FOLDER ? (
            <Folder className="text-blue-500 mr-3 shrink-0" size={18} />
            ) : (
            <div className="w-6 h-6 mr-3 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden shrink-0 relative">
                {file.type === FileType.IMAGE ? (
                    <div className="w-full h-full">
                        <ImageThumbnail
                            src={''}
                            alt={file.name}
                            isSelected={false}
                            filePath={file.path}
                            modified={file.updatedAt}
                            size={file.size}
                            isHovering={false}
                            fileMeta={file.meta}
                            resourceRoot={resourceRoot}
                            cachePath={cachePath}
                        />
                    </div>
                ) : (
                    <div className="w-full h-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                        <ImageIcon className="text-gray-400 dark:text-gray-500" size={14} />
                    </div>
                )}
            </div>
            )}
            {renamingId === file.id ? (
            <div className="w-64 pointer-events-auto">
                <InlineRenameInput
                    defaultValue={file.name}
                    onCommit={(val: string) => onRenameSubmit(val, file.id)}
                    onCancel={onRenameCancel}
                />
            </div>
            ) : (
            <span
                className="truncate text-gray-900 dark:text-gray-100 font-bold text-sm pointer-events-auto"
                onDoubleClick={(e) => {
                e.stopPropagation();
                onStartRename(file.id);
                }}
            >{file.name}</span>
            )}
        </div>
        <div className="w-24 text-xs text-gray-500 hidden md:block pointer-events-none">
            {file.type === FileType.IMAGE && file.meta?.width ? `${file.meta.width}×${file.meta.height}` : '-'}
        </div>
        <div className="w-32 text-xs text-gray-500 truncate hidden sm:block pointer-events-none">
            {file.updatedAt ? new Date(file.updatedAt).toLocaleDateString() : '-'}
        </div>
        <div className="w-12 text-xs text-gray-500 uppercase hidden md:block pointer-events-none">
            {file.type === FileType.FOLDER ? t('meta.folderType') : file.meta?.format || '-'}
        </div>
        <div className="w-20 text-xs text-gray-500 text-right font-mono hidden sm:block pointer-events-none">
            {file.type === FileType.IMAGE 
                ? formatSize(file.meta?.sizeKb || 0) 
                : (file.type === FileType.FOLDER ? `${file.children?.length || 0} ${t('meta.items')}` : '-')}
        </div>
    </div>
  );
});
