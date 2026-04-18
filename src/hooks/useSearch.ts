import { useState, useCallback, useEffect } from 'react';
import { AppState, FileNode, FileType, AiSearchFilter, TabState, TaskProgress, SearchScope } from '../types';
import { searchByColor, searchByPalette, getColorDbStats, scanFile } from '../api/tauri-bridge';
import { asyncPool } from '../utils/async';

type ViewMode = 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview';

interface UseSearchProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  startTask: (type: string, fileIds: string[], label: string, autoProgress: boolean) => string;
  updateTask: (taskId: string, update: Partial<TaskProgress>) => void;
  pushHistory: (folderId: string, viewingId: string | null, viewMode?: ViewMode, searchQuery?: string, searchScope?: SearchScope, activeTags?: string[], activePersonId?: string | null, nextScrollTop?: number, aiFilter?: AiSearchFilter | null, activeTopicId?: string | null, selectedTopicIds?: string[], selectedPersonIds?: string[], scrollToItemId?: string) => void;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
}

export const useSearch = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  startTask,
  updateTask,
  pushHistory,
  updateActiveTab,
}: UseSearchProps) => {
  const [isClipSearchEnabled, setIsClipSearchEnabled] = useState(false);
  const [clipLoading, setClipLoading] = useState(false);

  useEffect(() => {
    const query = activeTab.searchQuery?.trim() || '';

    if (query.startsWith('palette:') || query.startsWith('color:')) {
      const isPalette = query.startsWith('palette:');
      const content = query.replace(/^(palette:|color:)/, '').trim();

      if (!content) return;

      const colors = content.split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
      if (colors.length === 0) return;

      const executeSearch = async () => {
        const colorDbStats = await getColorDbStats();

        const totalImagesInDir = Object.values(state.files || {}).filter(f => f.type === FileType.IMAGE).length;
        const extractedCount = colorDbStats?.extracted || 0;

        const hasInsufficientData = !colorDbStats ||
          extractedCount === 0 ||
          extractedCount < totalImagesInDir * 0.1;

        if (hasInsufficientData) {
          showToast(t('tasks.colorDbInsufficient'));
          updateActiveTab({ searchQuery: '' });
          return;
        }

        const searchFn = isPalette ? searchByPalette : searchByColor;
        const arg = isPalette ? colors : colors[0];

        try {
          // @ts-ignore - Argument types are handled inside wrapper functions
          const paths: string[] = await searchFn(arg);
          updateActiveTab({
            aiFilter: {
              keywords: [],
              colors: colors,
              people: [],
              description: '',
              filePaths: paths,
              originalQuery: query
            }
          });
        } catch (err) {
          console.error('[ColorSearch Sync] Backend error:', err);
        }
      };

      executeSearch();
    }
  }, [activeTab.searchQuery]);

  const performAiSearch = async (query: string) => {
    if (!query.trim()) {
      pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, null);
      return;
    }

    const taskId = startTask('ai', [], t('settings.aiSmartSearchThinking'), false);
    showToast(t('settings.aiSmartSearchThinking'));

    try {
      const aiConfig = state.settings.ai;
      const prompt = `
          Analyze this search query for a photo gallery: "${query}".
          Extract search intent and criteria into a JSON object.
          Return ONLY JSON.
          
          Expected JSON Structure:
          {
            "keywords": string[], // Synonyms, objects, tags
            "colors": string[], // Hex codes or color names
            "people": string[], // Names of people
            "description": string // A concise description of what to look for (optional)
          }
          `;

      let result: any = null;

      if (aiConfig.provider === 'openai') {
        const messages: any[] = [];
        if (aiConfig.systemPrompt) {
          messages.push({ role: "system", content: aiConfig.systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const body = {
          model: aiConfig.openai.model,
          messages,
          max_tokens: 500
        };
        try {
          const res = await fetch(`${aiConfig.openai.endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.openai.apiKey}` },
            body: JSON.stringify(body)
          });
          const resData = await res.json();
          if (resData?.choices?.[0]?.message?.content) {
            try {
              const text = resData.choices[0].message.content;
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            } catch (e) { }
          }
        } catch (e) {
          console.error('AI search failed:', e);
        }
      } else if (aiConfig.provider === 'ollama') {
        const body: any = { model: aiConfig.ollama.model, prompt: prompt, stream: false, format: "json" };
        if (aiConfig.systemPrompt) {
          body.system = aiConfig.systemPrompt;
        }
        try {
          const res = await fetch(`${aiConfig.ollama.endpoint}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const resData = await res.json();
          if (resData?.response) {
            try {
              const text = resData.response;
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            } catch (e) { }
          }
        } catch (e) {
          console.error('AI search failed:', e);
        }
      } else if (aiConfig.provider === 'lmstudio') {
        const messages: any[] = [];
        if (aiConfig.systemPrompt) {
          messages.push({ role: "system", content: aiConfig.systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const body = {
          model: aiConfig.lmstudio.model,
          messages,
          max_tokens: 500,
          stream: false
        };
        let endpoint = aiConfig.lmstudio.endpoint.replace(/\/+$/, '');
        if (!endpoint.endsWith('/v1')) endpoint += '/v1';
        try {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const resData = await res.json();
          if (resData?.choices?.[0]?.message?.content) {
            try { result = JSON.parse(resData.choices[0].message.content); } catch (e) { }
          }
        } catch (e) {
          console.error('AI search failed:', e);
        }
      }

      if (result) {
        const aiFilter = {
          originalQuery: query,
          keywords: result.keywords || [],
          colors: result.colors || [],
          people: result.people || [],
          description: result.description
        };

        pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);
        showToast("AI Search Applied");
      } else {
        pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, null);
        showToast("AI Search Failed, using standard search");
      }

    } catch (e) {
      console.error("AI Search Error", e);
      pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, null);
      showToast("AI Search Error");
    } finally {
      updateTask(taskId, { current: 1, status: 'completed' });
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
    }
  };

  const onPerformSearch = async (query: string) => {
    if (isClipSearchEnabled && query.trim()) {
      const taskId = startTask('ai', [], '正在使用 CLIP 搜索...', false);

      try {
        const { clipSearchByText } = await import('../api/tauri-bridge');
        const modelName = state.settings.clip.modelName;
        const minScore = state.settings.clip.minScore ?? 0.4;
        const unlimitedResults = state.settings.clip.unlimitedResults ?? false;
        const maxResults = unlimitedResults ? 999999 : (state.settings.clip.maxResults ?? 200);
        console.log('[CLIP Search] Starting search:', { query: query.trim(), modelName, minScore, maxResults, unlimitedResults });

        const results = await clipSearchByText(query.trim(), { top_k: maxResults, min_score: minScore }, modelName);
        console.log('[CLIP Search] Results:', results);

        if (results && results.length > 0) {
          const fileIds = results.map(r => r.file_id);
          console.log('[CLIP Search] File IDs:', fileIds);

          const validPaths: string[] = [];
          const missingPaths: string[] = [];
          const newFilesMap: Record<string, FileNode> = {};

          const allFiles = Object.values(state.files || {});
          const idMap = new Map<string, string>();
          allFiles.forEach(f => {
            if (f.id) idMap.set(f.id, f.path);
          });

          console.log('[CLIP Search] ID map size:', idMap.size);

          results.forEach(result => {
            const filePath = idMap.get(result.file_id);
            if (filePath) {
              validPaths.push(filePath);
            } else {
              missingPaths.push(result.file_id);
            }
          });

          const aiFilter: AiSearchFilter = {
            keywords: [query.trim()],
            colors: [],
            people: [],
            originalQuery: `clip:${query.trim()}`,
            filePaths: validPaths
          };

          pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

          if (validPaths.length === 0 && results.length > 0) {
            showToast(`未在当前图库路径中找到匹配的文件，这可能是由于索引尚未同步。`);
          }
        } else {
          try {
            const { clipGetEmbeddingCountByModel, clipGetModelVersions } = await import('../api/tauri-bridge');
            const count = await clipGetEmbeddingCountByModel(modelName);
            if (count > 0) {
              showToast(`未找到与 "${query}" 相关的匹配项（相似度低于阈值）。`);
            } else {
              const versions = await clipGetModelVersions();
              if (versions.length > 0) {
                const versionList = versions.map(([name, cnt]: [string, number]) => `${name}(${cnt}张)`).join(', ');
                showToast(`当前模型 ${modelName} 无嵌入向量。可用模型: ${versionList}。请前往设置切换模型或生成嵌入向量。`);
              } else {
                showToast(`图库中尚未生成 ${modelName} 的嵌入向量信息，请前往设置进行生成。`);
              }
            }
          } catch (e) {
            showToast(`未找到匹配项。`);
          }
        }
      } catch (e) {
        console.error("CLIP search failed", e);
        showToast("CLIP 搜索失败: " + e);
      } finally {
        updateTask(taskId, { current: 1, status: 'completed' });
        setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
      }
      return;
    }

    if (query.startsWith('color:')) {
      let hex = query.replace('color:', '').trim();
      if (hex.startsWith('#')) hex = hex.substring(1);

      const taskId = startTask('ai', [], t('tasks.searchingColor'), false);

      try {
        const colorDbStats = await getColorDbStats();

        const totalImagesInDir = Object.values(state.files || {}).filter(f => f.type === FileType.IMAGE).length;
        const extractedCount = colorDbStats?.extracted || 0;

        const hasInsufficientData = !colorDbStats ||
          extractedCount === 0 ||
          extractedCount < totalImagesInDir * 0.1;

        if (hasInsufficientData) {
          showToast(t('tasks.colorDbInsufficient'));
          updateTask(taskId, { current: 1, status: 'completed' });
          setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
          return;
        }

        const results = await searchByColor(`#${hex}`);

        const validPaths: string[] = [];
        const missingPaths: string[] = [];
        const newFilesMap: Record<string, FileNode> = {};

        const normalize = (p: string) => {
          if (!p) return '';
          let clean = p.startsWith('\\\\?\\') ? p.slice(4) : p;
          clean = clean.replace(/\\/g, '/');
          return clean.toLowerCase();
        };

        const allFiles = Object.values(state.files || {});
        const pathMap = new Map<string, string>();
        allFiles.forEach(f => {
          if (f.path) pathMap.set(normalize(f.path), f.path);
        });

        results.forEach(rustPath => {
          const normRust = normalize(rustPath);
          const matchedPath = pathMap.get(normRust);
          if (matchedPath) {
            validPaths.push(matchedPath);
          } else {
            missingPaths.push(rustPath);
          }
        });

        if (missingPaths.length > 0) {
          await asyncPool(10, missingPaths, async (path) => {
            try {
              const node = await scanFile(path);
              if (node) {
                newFilesMap[node.id] = node;
                validPaths.push(node.path);
              }
            } catch (e) { }
          });
        }

        if (Object.keys(newFilesMap).length > 0) {
          setState(prev => ({
            ...prev,
            files: { ...prev.files, ...newFilesMap }
          }));
        }

        if (validPaths.length === 0 && results.length > 0) {
          showToast(t('errors.fileNotFound'));
        }

        const aiFilter: AiSearchFilter = {
          keywords: [],
          colors: [hex],
          people: [],
          originalQuery: query,
          filePaths: validPaths
        };

        pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

      } catch (e) {
        console.error("Color search failed", e);
        showToast("Color search failed");
      } finally {
        updateTask(taskId, { current: 1, status: 'completed' });
        setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
      }
      return;
    }

    if (query.startsWith('palette:')) {
      const rawPalette = query.replace('palette:', '').trim();
      if (!rawPalette) return;

      const palette = rawPalette.split(',').map(c => {
        let hex = c.trim();
        if (!hex.startsWith('#')) hex = '#' + hex;
        return hex;
      });

      const taskId = startTask('ai', [], t('tasks.searchingPalette'), false);

      try {
        const colorDbStats = await getColorDbStats();

        const totalImagesInDir = Object.values(state.files || {}).filter(f => f.type === FileType.IMAGE).length;
        const extractedCount = colorDbStats?.extracted || 0;

        const hasInsufficientData = !colorDbStats ||
          extractedCount === 0 ||
          extractedCount < totalImagesInDir * 0.1;

        if (hasInsufficientData) {
          showToast(t('tasks.colorDbInsufficient'));
          updateTask(taskId, { current: 1, status: 'completed' });
          setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
          return;
        }

        const results = await searchByPalette(palette);

        const validPaths: string[] = [];
        const missingPaths: string[] = [];
        const newFilesMap: Record<string, FileNode> = {};

        const normalize = (p: string) => {
          if (!p) return '';
          let clean = p.startsWith('\\\\?\\') ? p.slice(4) : p;
          clean = clean.replace(/\\/g, '/');
          return clean.toLowerCase();
        };

        const allFiles = Object.values(state.files || {});
        const pathMap = new Map<string, string>();
        allFiles.forEach(f => {
          if (f.path) pathMap.set(normalize(f.path), f.path);
        });

        results.forEach(rustPath => {
          const normRust = normalize(rustPath);
          const matchedPath = pathMap.get(normRust);
          if (matchedPath) {
            validPaths.push(matchedPath);
          } else {
            missingPaths.push(rustPath);
          }
        });

        if (missingPaths.length > 0) {
          await asyncPool(10, missingPaths, async (path) => {
            try {
              const node = await scanFile(path);
              if (node) {
                newFilesMap[node.id] = node;
                validPaths.push(node.path);
              }
            } catch (e) {
              console.warn('Failed to load search result file:', path);
            }
          });
        }

        if (Object.keys(newFilesMap).length > 0) {
          setState(prev => ({
            ...prev,
            files: { ...prev.files, ...newFilesMap }
          }));
        }

        if (validPaths.length === 0 && results.length > 0) {
          showToast(t('errors.fileNotFound'));
        }

        const aiFilter: AiSearchFilter = {
          keywords: [],
          colors: palette,
          people: [],
          originalQuery: query,
          filePaths: validPaths
        };

        pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

        if (validPaths.length > 0) {
          showToast(t('context.found') + ` ${validPaths.length} ` + t('context.files'));
        } else {
          showToast(t('context.noFiles'));
        }

      } catch (e) {
        console.error("Palette search failed", e);
        showToast("Palette search failed: " + e);
      } finally {
        updateTask(taskId, { current: 1, status: 'completed' });
        setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
      }
      return;
    }

    if (state.settings.search.isAISearchEnabled) {
      await performAiSearch(query);
    } else {
      pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0);
    }
  };

  const handlePerformSearch = onPerformSearch;

  const handleViewerSearch = (query: string) => pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0);

  const handleSearchSimilarImages = async (fileId: string) => {
    const file = state.files[fileId];
    if (!file || file.type !== FileType.IMAGE) return;

    const taskId = startTask('ai', [], '正在搜索相似图片...', false);

    try {
      const { clipSearchByImage } = await import('../api/tauri-bridge');
      const modelName = state.settings.clip.modelName;
      const minScore = state.settings.clip.minScore ?? 0.4;
      const unlimitedResults = state.settings.clip.unlimitedResults ?? false;
      const maxResults = unlimitedResults ? 999999 : (state.settings.clip.maxResults ?? 200);

      console.log('[Image Search] Starting search:', { filePath: file.path, modelName, minScore, maxResults, unlimitedResults });

      const results = await clipSearchByImage(file.path, { top_k: maxResults, min_score: minScore }, modelName);
      console.log('[Image Search] Results:', results);

      if (results && results.length > 0) {
        const validPaths: string[] = [];
        const allFiles = Object.values(state.files || {});
        const idMap = new Map<string, string>();
        allFiles.forEach(f => {
          if (f.id) idMap.set(f.id, f.path);
        });

        results.forEach(result => {
          const filePath = idMap.get(result.file_id);
          if (filePath) {
            validPaths.push(filePath);
          }
        });

        const aiFilter: AiSearchFilter = {
          keywords: [],
          colors: [],
          people: [],
          originalQuery: `image:${file.name}`,
          filePaths: validPaths
        };

        pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

        if (validPaths.length === 0) {
          showToast(`未找到相似图片，请确保已生成嵌入向量。`);
        } else {
          showToast(`找到 ${validPaths.length} 张相似图片`);
        }
      } else {
        try {
          const { clipGetEmbeddingCountByModel } = await import('../api/tauri-bridge');
          const count = await clipGetEmbeddingCountByModel(modelName);
          if (count === 0) {
            showToast(`图库中尚未生成 ${modelName} 的嵌入向量信息，请前往设置进行生成。`);
          } else {
            showToast(`未找到相似图片。`);
          }
        } catch (e) {
          showToast(`未找到相似图片。`);
        }
      }
    } catch (e) {
      console.error("Image search failed", e);
      const errorMsg = String(e);
      if (errorMsg.includes('Invalid PNG') || errorMsg.includes('Format error') || errorMsg.includes('Failed to open image')) {
        showToast(`图片文件可能已损坏，无法读取: ${file.name}`);
      } else if (errorMsg.includes('not initialized') || errorMsg.includes('not loaded')) {
        showToast(`模型未加载，请前往设置加载模型。`);
      } else {
        showToast("以图搜图失败: " + e);
      }
    } finally {
      updateTask(taskId, { current: 1, status: 'completed' });
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
    }
  };

  const openClipSettings = useCallback(() => {
    setState(s => ({ ...s, isSettingsOpen: true, settingsCategory: 'aiVision' }));
  }, [setState]);

  const handleClipEnabledChange = useCallback(async (enabled: boolean) => {
    const { clipUnloadModel } = await import('../api/tauri-bridge');

    setClipLoading(true);

    if (!enabled) {
      setIsClipSearchEnabled(false);
      try {
        await clipUnloadModel();
      } catch (err) {
        console.error('Failed to unload CLIP model:', err);
      }
    }

    setState(s => ({
      ...s,
      settings: {
        ...s.settings,
        clip: {
          ...s.settings.clip,
          enabled,
          modelName: '' as any
        }
      }
    }));

    setClipLoading(false);
  }, [setState]);

  return {
    performAiSearch,
    onPerformSearch,
    handlePerformSearch,
    handleViewerSearch,
    handleSearchSimilarImages,
    handleClipEnabledChange,
    openClipSettings,
    isClipSearchEnabled,
    setIsClipSearchEnabled,
    clipLoading,
  };
};
