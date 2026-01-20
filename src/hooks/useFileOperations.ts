import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  copyFile, moveFile, scanFile, writeFileFromBytes,
  deleteFile, createFolder, renameFile, copyImageColors
} from '../api/tauri-bridge';
import { performanceMonitor } from '../utils/performanceMonitor';
import { info as logInfo, debug as logDebug } from '../utils/logger';
import { asyncPool } from '../utils/async';
import { FileNode, FileType, TabState, DeletionTask, AppState } from '../types';
import { isTauriEnvironment } from '../utils/environment';

interface UseFileOperationsProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  startTask: (type: string, items: any[], initialMsg: string, autoProgress?: boolean) => string;
  updateTask: (id: string, updates: any) => void;
  handleRefresh: (folderId?: string) => Promise<void>;
  handleUpdateFile: (id: string, updates: Partial<FileNode>) => void;
  displayFileIds: string[];
}

export const useFileOperations = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  startTask,
  updateTask,
  handleRefresh,
  handleUpdateFile,
  displayFileIds
}: UseFileOperationsProps) => {
  const [deletionTasks, setDeletionTasks] = useState<DeletionTask[]>([]);

  const handleCopyFiles = async (fileIds: string[], targetFolderId: string) => {
    const copyTimer = performanceMonitor.start('handleCopyFiles');
    logInfo('[CopyFiles] Starting copy operation', { fileIds, targetFolderId });
    const targetFolder = state.files[targetFolderId];

    if (!targetFolder || !targetFolder.path) {
      console.error('[CopyFiles] Invalid target folder or path');
      performanceMonitor.end(copyTimer, 'handleCopyFiles', { success: false, fileCount: fileIds.length });
      return;
    }

    const taskId = startTask('copy', fileIds, t('tasks.copying'), false);
    const separator = targetFolder.path.includes('/') ? '/' : '\\';
    let copiedCount = 0;
    const scannedFilesMap = new Map<string, any>();
    const filePathsMap = new Map<string, { sourcePath: string; newPath: string; filename: string; originalFile: FileNode }>();

    try {
      for (const id of fileIds) {
        const file = state.files[id];
        if (file && file.path) {
          const filename = file.name;
          const newPath = `${targetFolder.path}${separator}${filename}`;
          filePathsMap.set(id, { sourcePath: file.path, newPath, filename, originalFile: file });
        }
      }

      await asyncPool(10, fileIds, async (id) => {
        const fileInfo = filePathsMap.get(id);
        if (!fileInfo) return;

        try {
          await copyFile(fileInfo.sourcePath, fileInfo.newPath);
          // 尝试复制颜色信息，避免重复提取
          await copyImageColors(fileInfo.sourcePath, fileInfo.newPath);

          const scannedFile = await scanFile(fileInfo.newPath, targetFolderId);
          scannedFilesMap.set(id, { scannedFile, originalFile: fileInfo.originalFile });
          copiedCount++;
          updateTask(taskId, { current: copiedCount });
        } catch (error) {
          console.error('[CopyFiles] Error processing file ID', id, error);
        }
      });

      if (scannedFilesMap.size > 0) {
        setState(prev => {
          const newFiles = { ...prev.files };
          const updatedTargetFolder = { ...newFiles[targetFolderId] };
          updatedTargetFolder.children = [...(updatedTargetFolder.children || [])];

          scannedFilesMap.forEach(({ scannedFile }) => {
            const existingFile = prev.files[scannedFile.id];
            if (existingFile) {
              newFiles[scannedFile.id] = {
                ...scannedFile,
                tags: existingFile.tags,
                description: existingFile.description,
                url: existingFile.url,
                aiData: existingFile.aiData,
                sourceUrl: existingFile.sourceUrl,
                author: existingFile.author,
                category: existingFile.category
              };
            } else {
              newFiles[scannedFile.id] = scannedFile;
            }

            if (!updatedTargetFolder.children?.includes(scannedFile.id)) {
              updatedTargetFolder.children?.push(scannedFile.id);
            }
          });

          newFiles[targetFolderId] = updatedTargetFolder;
          return { ...prev, files: newFiles };
        });
      }

      showToast(t('context.copied'));
      updateTask(taskId, { current: fileIds.length, status: 'completed' });
      setTimeout(() => {
        setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }));
      }, 1000);

      performanceMonitor.end(copyTimer, 'handleCopyFiles', {
        success: true,
        fileCount: fileIds.length,
        copiedCount: copiedCount
      });
    } catch (e) {
      console.error('[CopyFiles] Error during copy operation:', e);
      showToast("Copy failed");
      setTimeout(() => {
        setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }));
      }, 1000);
      performanceMonitor.end(copyTimer, 'handleCopyFiles', { success: false, fileCount: fileIds.length, copiedCount: copiedCount });
    }
  };

  const handleMoveFiles = async (fileIds: string[], targetFolderId: string) => {
    const moveTimer = performanceMonitor.start('handleMoveFiles');
    logInfo('[MoveFiles] Starting move operation', { fileIds, targetFolderId });

    if (fileIds.includes(targetFolderId)) {
      performanceMonitor.end(moveTimer, 'handleMoveFiles', { success: false, fileCount: fileIds.length });
      return;
    }

    const targetFolder = state.files[targetFolderId];
    if (!targetFolder || !targetFolder.path) {
      performanceMonitor.end(moveTimer, 'handleMoveFiles', { success: false, fileCount: fileIds.length });
      return;
    }

    const taskId = startTask('move', fileIds, t('tasks.moving'), false);
    const separator = targetFolder.path.includes('/') ? '/' : '\\';
    const sourceParentIds = new Set<string>();
    let movedCount = 0;

    const filePathsMap = new Map<string, {
      sourcePath: string;
      newPath: string;
      filename: string;
      originalFile: FileNode;
      parentId: string | undefined;
    }>();

    try {
      for (const id of fileIds) {
        const file = state.files[id];
        if (file && file.path) {
          filePathsMap.set(id, {
            sourcePath: file.path,
            newPath: `${targetFolder.path}${separator}${file.name}`,
            filename: file.name,
            originalFile: file,
            parentId: file.parentId || undefined
          });
        }
      }

      let existingFiles: string[] = [];
      await asyncPool(20, fileIds, async (id) => {
        const fileInfo = filePathsMap.get(id);
        if (!fileInfo) return;
        try {
          const exists = await invoke<boolean>('file_exists', { filePath: fileInfo.newPath });
          if (exists) existingFiles.push(fileInfo.filename);
        } catch (error) { console.error(error); }
      });

      if (existingFiles.length > 0) {
        await new Promise<void>((resolve, reject) => {
          setState(prev => ({
            ...prev,
            activeModal: {
              type: 'confirm-overwrite-file',
              data: {
                files: existingFiles,
                onConfirm: () => {
                  setState(s => ({ ...s, activeModal: { type: null } }));
                  resolve();
                },
                onCancel: () => {
                  setState(s => ({ ...s, activeModal: { type: null } }));
                  reject(new Error('User cancelled move operation'));
                }
              }
            }
          }));
        });
      }

      await asyncPool(10, fileIds, async (id) => {
        const fileInfo = filePathsMap.get(id);
        if (!fileInfo) return;
        try {
          await moveFile(fileInfo.sourcePath, fileInfo.newPath);
          movedCount++;
          updateTask(taskId, { current: movedCount });
        } catch (error) { console.error(error); }
      });

      setState(prev => {
        const newFiles = { ...prev.files };
        const updatedTargetFolder = { ...newFiles[targetFolderId] };
        updatedTargetFolder.children = [...(updatedTargetFolder.children || [])];
        const sourceParentsToUpdate = new Map<string, any>();

        for (const id of fileIds) {
          const fileInfo = filePathsMap.get(id);
          const file = newFiles[id];
          if (!fileInfo || !file) continue;

          if (fileInfo.parentId) {
            sourceParentIds.add(fileInfo.parentId);
            if (!sourceParentsToUpdate.has(fileInfo.parentId)) {
              const sourceParent = newFiles[fileInfo.parentId];
              if (sourceParent) {
                sourceParentsToUpdate.set(fileInfo.parentId, {
                  ...sourceParent,
                  children: [...(sourceParent.children || [])]
                });
              }
            }
          }

          const existingFileId: string | undefined = updatedTargetFolder.children.find(childId => {
            const childFile = newFiles[childId];
            return childFile && childFile.name === fileInfo.filename;
          });

          if (existingFileId) {
            updatedTargetFolder.children = updatedTargetFolder.children.filter((childId: string): boolean => childId !== existingFileId);
            delete newFiles[existingFileId];
          }

          newFiles[id] = { ...file, parentId: targetFolderId, path: fileInfo.newPath };
          updatedTargetFolder.children.push(id);

          if (fileInfo.parentId && sourceParentsToUpdate.has(fileInfo.parentId)) {
            const sourceParent = sourceParentsToUpdate.get(fileInfo.parentId);
            sourceParent.children = sourceParent.children.filter((childId: string) => childId !== id);
          }
        }

        sourceParentsToUpdate.forEach((updatedParent, parentId) => { newFiles[parentId] = updatedParent; });
        newFiles[targetFolderId] = updatedTargetFolder;
        return { ...prev, files: newFiles };
      });

      showToast(t('context.moved'));
      updateTask(taskId, { current: fileIds.length, status: 'completed' });
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
      performanceMonitor.end(moveTimer, 'handleMoveFiles', { success: true, fileCount: fileIds.length, movedCount });
    } catch (e) {
      console.error('[MoveFiles] Error:', e);
      showToast("Move failed");
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
      performanceMonitor.end(moveTimer, 'handleMoveFiles', { success: false, fileCount: fileIds.length, movedCount });
    }
  };

  const handleExternalCopyFiles = async (files: File[], items?: DataTransferItemList) => {
    if (!activeTab.folderId) return;
    const targetFolder = state.files[activeTab.folderId];
    if (!targetFolder || targetFolder.type !== FileType.FOLDER) return;

    // 如果有 items,尝试使用 webkitGetAsEntry 处理文件夹
    if (items && items.length > 0) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
      }

      if (entries.length > 0) {
        await handleEntriesCopy(entries, targetFolder.path);
        return;
      }
    }

    const dummyItems = new Array(files.length).fill('external-file');
    const taskId = startTask('copy', dummyItems, t('tasks.copying'), false);
    updateTask(taskId, { current: 0 });

    try {
      const targetFolderId = activeTab.folderId;
      let current = 0;
      for (const file of files) {
        const destPath = `${targetFolder.path}${targetFolder.path.includes('\\') ? '\\' : '/'}${file.name}`;
        try {
          const arrayBuffer = await file.arrayBuffer();
          await writeFileFromBytes(destPath, new Uint8Array(arrayBuffer));
          const scannedFile = await scanFile(destPath, targetFolderId);

          setState(prev => {
            const newFiles = { ...prev.files };
            const existingFile = prev.files[scannedFile.id];
            newFiles[scannedFile.id] = existingFile ? { ...scannedFile, ...existingFile, path: scannedFile.path, name: scannedFile.name } : scannedFile;

            const currentFolder = newFiles[targetFolderId];
            if (currentFolder && !currentFolder.children?.includes(scannedFile.id)) {
              newFiles[targetFolderId] = { ...currentFolder, children: [...(currentFolder.children || []), scannedFile.id] };
            }
            return { ...prev, files: newFiles };
          });
        } catch (error) { console.error(error); }
        current++;
        updateTask(taskId, { current });
      }
      updateTask(taskId, { status: 'completed', current: files.length });
      showToast(t('context.copied'));
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
    } catch (error) {
      console.error(error);
      updateTask(taskId, { status: 'completed' });
      showToast(t('errors.copyFailed'));
    }
  };

  // 处理 FileSystemEntry 数组(文件和文件夹)
  const handleEntriesCopy = async (entries: FileSystemEntry[], targetPath: string) => {
    const taskId = startTask('copy', [], t('tasks.copying'), false);
    let totalFiles = 0;
    let processedFiles = 0;

    try {
      // 递归处理所有 entries
      for (const entry of entries) {
        await processEntry(entry, targetPath, taskId, (delta) => {
          totalFiles += delta;
          updateTask(taskId, { total: totalFiles });
        }, () => {
          processedFiles++;
          updateTask(taskId, { current: processedFiles });
        });
      }

      updateTask(taskId, { status: 'completed', current: processedFiles });
      showToast(t('context.copied'));

      // 刷新目标文件夹
      await handleRefresh(activeTab.folderId);

      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
    } catch (error) {
      console.error('[handleEntriesCopy] Error:', error);
      updateTask(taskId, { status: 'completed' });
      showToast(t('errors.copyFailed'));
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
    }
  };

  // 递归处理单个 entry
  const processEntry = async (
    entry: FileSystemEntry,
    targetPath: string,
    taskId: string,
    onFileDiscovered: (delta: number) => void,
    onFileProcessed: () => void
  ): Promise<void> => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      onFileDiscovered(1);
      await processFileEntry(fileEntry, targetPath, onFileProcessed);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      await processDirEntry(dirEntry, targetPath, taskId, onFileDiscovered, onFileProcessed);
    }
  };

  // 处理文件 entry
  const processFileEntry = async (
    fileEntry: FileSystemFileEntry,
    targetPath: string,
    onFileProcessed: () => void
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      fileEntry.file(async (file) => {
        try {
          const separator = targetPath.includes('\\') ? '\\' : '/';
          const destPath = `${targetPath}${separator}${file.name}`;
          const arrayBuffer = await file.arrayBuffer();
          await writeFileFromBytes(destPath, new Uint8Array(arrayBuffer));
          onFileProcessed();
          resolve();
        } catch (error) {
          console.error('[processFileEntry] Error:', error);
          onFileProcessed();
          reject(error);
        }
      }, (error) => {
        console.error('[processFileEntry] File read error:', error);
        onFileProcessed();
        reject(error);
      });
    });
  };

  // 处理文件夹 entry
  const processDirEntry = async (
    dirEntry: FileSystemDirectoryEntry,
    targetPath: string,
    taskId: string,
    onFileDiscovered: (delta: number) => void,
    onFileProcessed: () => void
  ): Promise<void> => {
    const separator = targetPath.includes('\\') ? '\\' : '/';
    const newDirPath = `${targetPath}${separator}${dirEntry.name}`;

    try {
      // 创建目标文件夹
      await createFolder(newDirPath);

      // 读取文件夹内容
      const entries = await readAllDirectoryEntries(dirEntry);

      // 递归处理文件夹内的所有项
      for (const entry of entries) {
        await processEntry(entry, newDirPath, taskId, onFileDiscovered, onFileProcessed);
      }
    } catch (error) {
      console.error('[processDirEntry] Error:', error);
      throw error;
    }
  };

  // 读取文件夹的所有 entries
  const readAllDirectoryEntries = async (dirEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      const reader = dirEntry.createReader();
      const entries: FileSystemEntry[] = [];

      const readEntries = () => {
        reader.readEntries((results) => {
          if (results.length === 0) {
            // 读取完成
            resolve(entries);
          } else {
            // 还有更多 entries,继续读取
            entries.push(...results);
            readEntries();
          }
        }, (error) => {
          console.error('[readAllDirectoryEntries] Error:', error);
          reject(error);
        });
      };

      readEntries();
    });
  };

  const handleExternalMoveFiles = async (files: File[]) => {
    if (!activeTab.folderId) return;
    const targetFolder = state.files[activeTab.folderId];
    if (!targetFolder || targetFolder.type !== FileType.FOLDER) return;

    const taskId = startTask('move', [], t('tasks.moving'), false);
    updateTask(taskId, { total: files.length, current: 0 });

    try {
      const targetFolderId = activeTab.folderId;
      let current = 0;
      for (const file of files) {
        const destPath = `${targetFolder.path}${targetFolder.path.includes('\\') ? '\\' : '/'}${file.name}`;
        const arrayBuffer = await file.arrayBuffer();
        await writeFileFromBytes(destPath, new Uint8Array(arrayBuffer));
        current++;
        updateTask(taskId, { current });
      }

      for (const file of files) {
        const destPath = `${targetFolder.path}${targetFolder.path.includes('\\') ? '\\' : '/'}${file.name}`;
        try {
          const scannedFile = await scanFile(destPath, targetFolderId);
          setState(prev => {
            const newFiles = { ...prev.files };
            const existingFile = prev.files[scannedFile.id];
            newFiles[scannedFile.id] = existingFile ? { ...scannedFile, ...existingFile, path: scannedFile.path, name: scannedFile.name } : scannedFile;
            const currentFolder = newFiles[targetFolderId];
            if (currentFolder && !currentFolder.children?.includes(scannedFile.id)) {
              newFiles[targetFolderId] = { ...currentFolder, children: [...(currentFolder.children || []), scannedFile.id] };
            }
            return { ...prev, files: newFiles };
          });
        } catch (error) { console.error(error); }
      }
      showToast(t('context.moved'));
    } catch (error) {
      console.error(error);
      updateTask(taskId, { status: 'completed' });
      showToast(t('errors.moveFailed'));
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 1000);
    }
  };

  const handleDropOnFolder = async (targetFolderId: string, sourceIds: string[]) => {
    const validIds = sourceIds.filter(id => id !== targetFolderId && state.files[id]);
    if (validIds.length === 0) return;
    const targetFolder = state.files[targetFolderId];
    if (!targetFolder || targetFolder.type !== FileType.FOLDER) return;

    const filesToMove = validIds.filter(id => state.files[id]?.parentId !== targetFolderId);
    if (filesToMove.length === 0) return;
    await handleMoveFiles(filesToMove, targetFolderId);
  };

  const handleBatchRename = async (pattern: string, startNum: number) => {
    const selectedIds = activeTab.selectedFileIds;
    if (selectedIds.length === 0) return;

    const sortedIds = [...selectedIds].sort((a, b) => {
      const indexA = displayFileIds.indexOf(a);
      const indexB = displayFileIds.indexOf(b);
      return (indexA === -1 ? 999999 : indexA) - (indexB === -1 ? 999999 : indexB);
    });

    const taskId = startTask('move', sortedIds, t('tasks.renaming'), false);
    let current = 0;

    for (let i = 0; i < sortedIds.length; i++) {
      const id = sortedIds[i];
      const file = state.files[id];
      if (!file) continue;

      const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
      const num = startNum + i;
      let newNameBase = pattern.replace(/#+/g, (match) => num.toString().padStart(match.length, '0'));
      const newName = ext ? `${newNameBase}.${ext}` : newNameBase;

      if (newName !== file.name) {
        try {
          const sep = file.path.includes('\\') ? '\\' : '/';
          const parentDir = file.path.substring(0, file.path.lastIndexOf(sep));
          const newPath = `${parentDir}${sep}${newName}`;
          await renameFile(file.path, newPath);
          handleUpdateFile(id, { name: newName, path: newPath });
        } catch (e) {
          console.error(e);
          showToast(`${t('error.renameFailed')}: ${file.name}`);
        }
      }
      current++;
      updateTask(taskId, { current });
    }
    updateTask(taskId, { status: 'completed', current: sortedIds.length });
    setState(s => ({ ...s, activeModal: { type: null } }));
  };

  const handleRenameSubmit = async (value: string, id: string) => {
    value = value.trim();
    const file = state.files[id];
    if (!value || value === file.name) { setState(s => ({ ...s, renamingId: null })); return; }
    if (file.path) {
      try {
        const separator = file.path.includes('/') ? '/' : '\\';
        const parentPath = file.path.substring(0, file.path.lastIndexOf(separator));
        const newPath = `${parentPath}${separator}${value}`;
        if (isTauriEnvironment()) {
          await renameFile(file.path, newPath);
        } else {
          throw new Error("No file system access available");
        }
        await handleRefresh();
        setState(s => ({ ...s, renamingId: null }));
      } catch (e) {
        console.error(e);
        showToast("Rename failed");
      }
    } else {
      handleUpdateFile(id, { name: value });
      setState(s => ({ ...s, renamingId: null }));
    }
  };

  const requestDelete = (ids: string[]) => {
    const filesToDelete = ids.map(id => state.files[id]).filter(Boolean);
    if (filesToDelete.length === 0) return;
    const taskId = Math.random().toString(36).substr(2, 9);
    setState(prev => {
      const newFiles = { ...prev.files };
      ids.forEach(id => {
        const file = newFiles[id];
        if (file?.parentId && newFiles[file.parentId]) {
          const parent = newFiles[file.parentId];
          newFiles[file.parentId] = { ...parent, children: parent.children?.filter(cid => cid !== id) };
        }
        delete newFiles[id];
      });

      const updatedTabs = prev.tabs.map(t => {
        const isViewingDeletedFile = t.viewingFileId && ids.includes(t.viewingFileId);
        return {
          ...t,
          selectedFileIds: t.selectedFileIds.filter(fid => !ids.includes(fid)),
          viewingFileId: isViewingDeletedFile ? null : t.viewingFileId
        };
      });

      return { ...prev, files: newFiles, tabs: updatedTabs };
    });
    setDeletionTasks(prev => [...prev, { id: taskId, files: filesToDelete }]);
  };

  const undoDelete = (taskId: string) => {
    const task = deletionTasks.find(t => t.id === taskId);
    if (!task) return;
    setState(prev => {
      const newFiles = { ...prev.files };
      task.files.forEach(file => {
        newFiles[file.id] = file;
        if (file.parentId && newFiles[file.parentId]) {
          const parent = newFiles[file.parentId];
          if (!parent.children?.includes(file.id)) {
            newFiles[file.parentId] = { ...parent, children: [...(parent.children || []), file.id] };
          }
        }
      });
      return { ...prev, files: newFiles };
    });
    setDeletionTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const dismissDelete = async (taskId: string) => {
    const task = deletionTasks.find(t => t.id === taskId);
    if (task) {
      for (const file of task.files) {
        if (file.path && isTauriEnvironment()) {
          await deleteFile(file.path);
        }
      }
    }
    setDeletionTasks(prev => prev.filter(t => t.id !== taskId));
  };

  const handleCreateFolder = async (targetId?: string) => {
    const parentId = targetId || activeTab.folderId;
    if (!parentId) {
      const baseName = t('context.newFolder');
      let name = baseName;
      let counter = 1;
      const rootFiles = state.roots.map(rootId => state.files[rootId]);
      while (rootFiles.some(file => file?.name === name)) { name = `${baseName} (${counter++})`; }
      const newId = Math.random().toString(36).substr(2, 9);
      const newFolder: FileNode = { id: newId, parentId: null, name, type: FileType.FOLDER, path: '', children: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      setState(prev => ({ ...prev, files: { ...prev.files, [newId]: newFolder }, roots: [...prev.roots, newId], renamingId: newId }));
      return;
    }

    const parent = state.files[parentId];
    if (!parent) return;
    const baseName = t('context.newFolder');
    let name = baseName;
    if (parent.path) {
      try {
        let counter = 1;
        const children = parent.children?.map(id => state.files[id]) || [];
        while (children.some(c => c.name === name)) { name = `${baseName} (${counter++})`; }
        const sep = parent.path.includes('/') ? '/' : '\\';
        const newPath = `${parent.path}${sep}${name}`;
        if (isTauriEnvironment()) {
          await createFolder(newPath);
        } else {
          throw new Error("No file system access available");
        }
        await handleRefresh();
        setState(prev => {
          const parentFolder = prev.files[parentId];
          if (parentFolder?.children) {
            const childFiles = parentFolder.children.map(id => prev.files[id]);
            const newFolder = childFiles.find(file => file?.name === name && file?.type === FileType.FOLDER);
            if (newFolder) return { ...prev, renamingId: newFolder.id };
          }
          return prev;
        });
      } catch (error) { console.error(error); showToast("Error creating folder"); }
    } else {
      let counter = 1;
      const children = parent.children?.map(id => state.files[id]) || [];
      while (children.some(c => c.name === name)) { name = `${baseName} (${counter++})`; }
      const newId = Math.random().toString(36).substr(2, 9);
      const newFolder: FileNode = { id: newId, parentId: parentId, name, type: FileType.FOLDER, path: '', children: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      setState(prev => {
        const newFiles = { ...prev.files, [newId]: newFolder };
        if (newFiles[parentId]) newFiles[parentId] = { ...newFiles[parentId], children: [...(newFiles[parentId].children || []), newId] };
        return { ...prev, files: newFiles, renamingId: newId };
      });
    }
  };

  return {
    handleCopyFiles,
    handleMoveFiles,
    handleExternalCopyFiles,
    handleExternalMoveFiles,
    handleDropOnFolder,
    handleBatchRename,
    handleRenameSubmit,
    requestDelete,
    undoDelete,
    dismissDelete,
    handleCreateFolder,
    deletionTasks,
    setDeletionTasks
  };
};
