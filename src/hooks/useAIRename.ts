import { useState, useCallback } from 'react';
import { FileNode, AppSettings, Person } from '../types';
import { aiService } from '../services/aiService';
import { renameFile } from '../api/tauri-bridge';

interface UseAIRenameProps {
  settings: AppSettings;
  people: Record<string, Person>;
  onUpdate: (id: string, updates: Partial<FileNode>) => void;
  showToast: (msg: string) => void;
  t: (key: string) => string;
}

interface UseAIRenameReturn {
  isGenerating: boolean;
  previewName: string | null;
  generateName: (file: FileNode) => Promise<void>;
  applyRename: (file: FileNode) => Promise<void>;
  cancelRename: () => void;
}

export const useAIRename = ({
  settings,
  people,
  onUpdate,
  showToast,
  t,
}: UseAIRenameProps): UseAIRenameReturn => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewName, setPreviewName] = useState<string | null>(null);

  const generateName = useCallback(async (file: FileNode) => {
    if (!file.path || isGenerating) return;

    setIsGenerating(true);
    setPreviewName(null);

    try {
      // 获取人物信息
      const personNames: string[] = [];
      if (file.aiData?.faces && file.aiData.faces.length > 0) {
        file.aiData.faces.forEach((face) => {
          const personName = face.name || people[face.personId]?.name;
          if (personName && personName !== '未知人物' && !personNames.includes(personName)) {
            personNames.push(personName);
          }
        });
      }

      // 调用 AI 生成文件名
      const newName = await aiService.generateSingleFileName(
        file.path,
        file.name,
        settings,
        personNames
      );

      if (!newName || newName === file.name) {
        showToast(t('context.renameFailed') || '重命名失败');
        return;
      }

      // 设置预览名称，等待用户确认
      setPreviewName(newName);
    } catch (error) {
      console.error('AI rename failed:', error);
      showToast(t('context.renameFailed') || '重命名失败');
    } finally {
      setIsGenerating(false);
    }
  }, [settings, people, showToast, t, isGenerating]);

  const applyRename = useCallback(async (file: FileNode) => {
    if (!file.path || !previewName) return;

    try {
      // 执行文件重命名
      const sep = file.path.includes('\\') ? '\\' : '/';
      const parentDir = file.path.substring(0, file.path.lastIndexOf(sep));
      const newPath = `${parentDir}${sep}${previewName}`;

      await renameFile(file.path, newPath);

      // 更新文件状态
      onUpdate(file.id, { name: previewName, path: newPath });

      showToast(t('context.renamed') || '已重命名');
    } catch (error) {
      console.error('Rename failed:', error);
      showToast(t('context.renameFailed') || '重命名失败');
    } finally {
      setPreviewName(null);
    }
  }, [previewName, onUpdate, showToast, t]);

  const cancelRename = useCallback(() => {
    setPreviewName(null);
  }, []);

  return {
    isGenerating,
    previewName,
    generateName,
    applyRename,
    cancelRename,
  };
};
