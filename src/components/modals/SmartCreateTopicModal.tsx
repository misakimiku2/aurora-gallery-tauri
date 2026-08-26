import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FolderOpen, Check, Sparkles, X, Users, Image, AlertTriangle } from 'lucide-react';
import { Grid } from 'react-window';
import * as RW from 'react-window';
import { WorkTopicInfo, Topic, Person, FileNode, WorkCharacter } from '../../types';
import { cropToImgStyle, centerCrop } from '../../utils/cropStyle';
import { clipGetWorkTopics, clipCreateWorkTopics } from '../../api/tauri-bridge';
import { ImageThumbnail } from '../ImageThumbnail';

const FixedSizeListComp: any = (() => {
  const mod: any = RW as any;
  if (mod.FixedSizeList) return mod.FixedSizeList;
  if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
  if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
  return null;
})();

const extractCharacterName = (tagName: string): string => {
  const patterns = ['_(', '('];
  for (const pattern of patterns) {
    const pos = tagName.lastIndexOf(pattern);
    if (pos !== -1) {
      return tagName.substring(0, pos);
    }
  }
  return tagName;
};

const formatDisplayName = (name: string): string => {
  return name.replace(/_/g, ' ');
};

const formatCharacterName = (tagName: string): string => {
  const characterName = extractCharacterName(tagName);
  return formatDisplayName(characterName);
};

const SharpImage = React.memo(({ src, aspect = 3 / 4, className = "" }: { src: string; aspect?: number; className?: string }) => {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
  };

  let imgStyle: React.CSSProperties = { objectFit: 'cover' };
  if (dim) {
    imgStyle = {
      position: 'absolute',
      ...cropToImgStyle(centerCrop(dim.w, dim.h, aspect)),
      imageRendering: 'auto'
    };
  }

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <img
        src={src}
        onLoad={handleLoad}
        style={imgStyle}
        className={dim ? "" : "w-full h-full object-cover opacity-0"}
        decoding="async"
      />
      {!dim && (
        <div className="absolute inset-0 bg-gray-100 dark:bg-gray-800 animate-pulse flex items-center justify-center">
          <Image size={16} className="text-gray-300 dark:text-gray-600" />
        </div>
      )}
    </div>
  );
});
SharpImage.displayName = 'SharpImage';

const FilePreviewGrid = React.memo(({ fileIds, files, resourceRoot }: { fileIds: string[]; files: Record<string, FileNode>; resourceRoot: string }) => {
  const columnCount = 5;
  const rowCount = Math.ceil(fileIds.length / columnCount);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      if (el.offsetWidth > 0) setWidth(el.offsetWidth);
    };
    updateWidth();

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const Cell = useCallback(({ columnIndex, rowIndex, style }: any) => {
    const index = rowIndex * columnCount + columnIndex;
    if (index >= fileIds.length) return null;

    const fileId = fileIds[index];
    const file = files[fileId];

    return (
      <div style={{ ...style, padding: '4px' }}>
        <div className="w-full h-full rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 relative">
          {file ? (
            <ImageThumbnail
              src=""
              alt={file.name}
              isSelected={false}
              filePath={file.path}
              modified={file.updatedAt || file.meta?.modified}
              resourceRoot={resourceRoot}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Image size={20} className="text-gray-300 dark:text-gray-600" />
            </div>
          )}
        </div>
      </div>
    );
  }, [fileIds, files, resourceRoot]);

  const gutter = 8;
  const columnWidth = (width > 0) ? (width - gutter * 2) / columnCount : 0;

  return (
    <div ref={containerRef} className="w-full h-full min-h-[200px]">
      {(width === 0) ? (
        <div className="w-full h-full font-mono text-xs flex flex-col items-center justify-center text-gray-400 gap-2">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-purple-500"></div>
          Initializing Grid... (W: {width})
        </div>
      ) : (
        <Grid
          columnCount={columnCount}
          columnWidth={columnWidth}
          rowCount={rowCount}
          rowHeight={columnWidth}
          style={{ height: 400, width: width }}
          cellComponent={Cell}
          cellProps={{} as any}
        />
      )}
    </div>
  );
});
FilePreviewGrid.displayName = 'FilePreviewGrid';

interface SmartCreateTopicModalProps {
  language: 'zh' | 'en';
  clipSettings: {
    minScore: number;
    modelName: string;
    enabled: boolean;
  };
  people: Record<string, Person>;
  topics: Record<string, Topic>;
  files: Record<string, FileNode>;
  resourceRoot: string;
  onConfirm: (topics: Topic[], people: Person[]) => void;
  onClose: () => void;
  t: (key: string) => string;
}

const ITEM_HEIGHT = 104;

interface WorkRowProps {
  index: number;
  style: React.CSSProperties;
  data: {
    works: WorkTopicInfo[];
    selectedWorks: Set<string>;
    onToggle: (workName: string) => void;
    language: 'zh' | 'en';
    onSelect: (work: WorkTopicInfo) => void;
    selectedWorkName: string | null;
    files: Record<string, FileNode>;
    resourceRoot: string;
  };
}

const WorkRow = React.memo(({ index, style, data }: WorkRowProps) => {
  const { works, selectedWorks, onToggle, language, onSelect, selectedWorkName, files } = data;
  const work = works[index];
  const isSelected = selectedWorks.has(work.workName);
  const isPreviewed = selectedWorkName === work.workName;

  const displayName = language === 'zh' && work.workNameCn 
    ? work.workNameCn 
    : formatDisplayName(work.workName);
  const existingTopic = work.existingTopicId;

  const coverFile = work.coverFileId ? files[work.coverFileId] : null;
  const coverUrl = coverFile ? convertFileSrc(coverFile.path) : null;

  return (
    <div style={style}>
      <div
        onClick={() => onSelect(work)}
        className={`flex items-center px-4 py-3 rounded-2xl cursor-pointer transition-all duration-200 group mx-1.5 my-1 border ${isPreviewed
          ? 'bg-purple-100 dark:bg-purple-900/40 border-purple-200 dark:border-purple-800 shelf-shadow shadow-purple-500/10'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 border-transparent shadow-sm shadow-transparent'
          }`}
      >
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (!existingTopic) onToggle(work.workName);
          }}
          className={`mr-4 w-6 h-6 rounded-lg border-2 flex items-center justify-center flex-shrink-0 transition-all ${existingTopic
            ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 cursor-not-allowed'
            : isSelected
              ? 'border-purple-500 bg-purple-500 cursor-pointer shadow-sm shadow-purple-500/20'
              : 'border-gray-300 dark:border-gray-600 cursor-pointer bg-white dark:bg-gray-800 hover:border-purple-400 focus-within:ring-2 ring-purple-500/50'
            }`}
        >
          {isSelected && !existingTopic && <Check size={14} className="text-white" strokeWidth={3} />}
          {existingTopic && <Check size={14} className="text-gray-300 dark:text-gray-600" />}
        </div>

        <div className="w-14 h-[74.6px] rounded-xl overflow-hidden flex-shrink-0 mr-4 bg-gray-100 dark:bg-gray-700 flex items-center justify-center border border-gray-200 dark:border-gray-700 shadow-sm relative">
          {coverUrl ? (
            <SharpImage src={coverUrl} aspect={3 / 4} className="w-full h-full" />
          ) : (
            <FolderOpen size={20} className="text-gray-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className={`text-sm truncate leading-tight ${isPreviewed ? 'text-purple-700 dark:text-purple-300 font-bold' : 'text-gray-800 dark:text-gray-200 font-medium'}`}>
              {displayName}
            </div>
            {existingTopic && (
              <div className="bg-green-500 px-2 py-0.5 rounded-full text-[9px] font-bold text-white uppercase tracking-tighter flex-shrink-0">
                {language === 'zh' ? '已创建' : 'EXISTING'}
              </div>
            )}
          </div>
          <div className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-1 mb-1 block">Topic</div>
          <div className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center gap-2">
            <span className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded-full"><Users size={8} />{work.characterCount}</span>
            <span className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded-full"><Image size={8} />{work.imageCount}</span>
          </div>
        </div>
      </div>
    </div>
  );
});

WorkRow.displayName = 'WorkRow';

export const SmartCreateTopicModal: React.FC<SmartCreateTopicModalProps> = ({
  language,
  clipSettings,
  people,
  topics,
  files,
  resourceRoot,
  onConfirm,
  onClose,
  t
}) => {
  const [workTopics, setWorkTopics] = useState<WorkTopicInfo[]>([]);
  const [selectedWorks, setSelectedWorks] = useState<Set<string>>(new Set());
  const [selectedWork, setSelectedWork] = useState<WorkTopicInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [threshold, setThreshold] = useState(0.1);
  const [searchQuery, setSearchQuery] = useState('');
  const [customTopicTypes, setCustomTopicTypes] = useState<Record<string, string>>({});

  const workListRef = useRef<HTMLDivElement>(null);
  const [workListHeight, setWorkListHeight] = useState(300);
  const thresholdDebounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const updateWorkListHeight = () => {
      if (workListRef.current) {
        const rect = workListRef.current.getBoundingClientRect();
        setWorkListHeight(rect.height);
      }
    };

    updateWorkListHeight();
    window.addEventListener('resize', updateWorkListHeight);

    const observer = new ResizeObserver(updateWorkListHeight);
    if (workListRef.current) {
      observer.observe(workListRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateWorkListHeight);
      observer.disconnect();
    };
  }, []);

  const loadWorkTopics = useCallback(async (minScore: number) => {
    if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const topics = await clipGetWorkTopics(minScore, 1, language);
      setWorkTopics(topics);
    } catch (error) {
      console.error('Failed to load work topics:', error);
    } finally {
      setLoading(false);
    }
  }, [clipSettings.enabled, clipSettings.modelName, language]);

  useEffect(() => {
    loadWorkTopics(threshold);
  }, []);

  const handleThresholdChange = useCallback((newThreshold: number) => {
    setThreshold(newThreshold);

    if (thresholdDebounceRef.current) {
      clearTimeout(thresholdDebounceRef.current);
    }

    thresholdDebounceRef.current = setTimeout(() => {
      loadWorkTopics(newThreshold);
    }, 300);
  }, [loadWorkTopics]);

  const handleToggleWork = useCallback((workName: string) => {
    setSelectedWorks(prev => {
      const next = new Set(prev);
      if (next.has(workName)) {
        next.delete(workName);
      } else {
        next.add(workName);
      }
      return next;
    });
  }, []);

  const handleSelectWork = useCallback((work: WorkTopicInfo) => {
    setSelectedWork(work);
  }, []);

  const handleSelectAll = useCallback(() => {
    const selectableWorks = workTopics.filter(w => !w.existingTopicId);
    setSelectedWorks(new Set(selectableWorks.map(w => w.workName)));
  }, [workTopics]);

  const handleDeselectAll = useCallback(() => {
    setSelectedWorks(new Set());
  }, []);

  const handleConfirm = useCallback(async () => {
    if (selectedWorks.size === 0) return;

    setCreating(true);
    try {
      const worksToCreate = Array.from(selectedWorks).map(workName => {
        const work = workTopics.find(w => w.workName === workName);
        return {
          name: workName,
          topicType: customTopicTypes[workName] || 'TOPIC',
          coverFileId: work?.coverFileId
        };
      });
      console.log('[SmartCreateTopicModal] Creating topics for works:', worksToCreate);
      const result = await clipCreateWorkTopics(worksToCreate);
      console.log('[SmartCreateTopicModal] Created topics:', result.topics);
      console.log('[SmartCreateTopicModal] Created people:', result.people);
      onConfirm(result.topics, result.people);
    } catch (error) {
      console.error('Failed to create work topics:', error);
    } finally {
      setCreating(false);
    }
  }, [selectedWorks, workTopics, customTopicTypes, onConfirm]);

  const filteredWorks = useMemo(() => {
    if (!searchQuery.trim()) return workTopics;

    const query = searchQuery.toLowerCase();
    return workTopics.filter(work => {
      const nameMatch = work.workName.toLowerCase().includes(query);
      const nameCnMatch = work.workNameCn?.toLowerCase().includes(query);
      return nameMatch || nameCnMatch;
    });
  }, [workTopics, searchQuery]);

  const stats = useMemo(() => {
    const total = workTopics.length;
    const existing = workTopics.filter(w => w.existingTopicId).length;
    const available = total - existing;
    const selected = selectedWorks.size;
    const totalCharacters = Array.from(selectedWorks).reduce((sum, workName) => {
      const work = workTopics.find(w => w.workName === workName);
      return sum + (work?.characterCount || 0);
    }, 0);
    const totalImages = Array.from(selectedWorks).reduce((sum, workName) => {
      const work = workTopics.find(w => w.workName === workName);
      return sum + (work?.imageCount || 0);
    }, 0);

    return { total, existing, available, selected, totalCharacters, totalImages };
  }, [workTopics, selectedWorks]);

  const workItemData = useMemo(() => ({
    works: filteredWorks,
    selectedWorks,
    onToggle: handleToggleWork,
    language,
    onSelect: handleSelectWork,
    selectedWorkName: selectedWork?.workName ?? null,
    files,
    resourceRoot
  }), [filteredWorks, selectedWorks, handleToggleWork, language, handleSelectWork, selectedWork, files, resourceRoot]);

  useEffect(() => {
    return () => {
      if (thresholdDebounceRef.current) {
        clearTimeout(thresholdDebounceRef.current);
      }
    };
  }, []);

  if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-[500px] animate-zoom-in">
        <div className="flex items-center justify-center h-40 text-gray-500 dark:text-gray-400">
          <div className="text-center">
            <Sparkles size={40} className="mx-auto mb-3 opacity-50" />
            <p>{t('smartCreateTopic.wd14Required') || '此功能需要启用 WD14 模型'}</p>
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            {t('settings.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl h-[85vh] flex flex-col animate-zoom-in">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="font-bold text-lg text-gray-900 dark:text-white flex items-center gap-2">
          <Sparkles size={20} className="text-purple-500" />
          {t('smartCreateTopic.title') || '智能创建专题'}
        </h3>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          <X size={18} className="text-gray-500" />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-[360px] flex-shrink-0 border-r border-gray-200 dark:border-gray-700 p-4 flex flex-col overflow-hidden">
          <div className="mb-3 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
            <div className="text-sm text-purple-700 dark:text-purple-300">
              {language === 'zh'
                ? `检测到 ${stats.total} 个作品，${stats.available} 个可创建`
                : `Detected ${stats.total} works, ${stats.available} available`}
            </div>
            {stats.selected > 0 && (
              <div className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                {language === 'zh'
                  ? `已选择 ${stats.selected} 个，共 ${stats.totalCharacters} 角色，${stats.totalImages} 张图片`
                  : `Selected ${stats.selected}, ${stats.totalCharacters} characters, ${stats.totalImages} images`}
              </div>
            )}
          </div>

          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('smartCreateTopic.threshold') || '检测阈值'}: {threshold.toFixed(3)}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.5"
              step="0.01"
              value={threshold}
              onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div className="mb-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full border dark:border-gray-600 rounded px-3 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-purple-500 text-sm"
              placeholder={t('smartCreateTopic.searchWork') || '搜索作品...'}
            />
          </div>

          <div className="flex gap-2 mb-3">
            <button
              onClick={handleSelectAll}
              className="flex-1 px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
            >
              {t('smartCreateTopic.selectAll') || '全选'}
            </button>
            <button
              onClick={handleDeselectAll}
              className="flex-1 px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-300"
            >
              {t('smartCreateTopic.deselectAll') || '取消全选'}
            </button>
          </div>

          <div ref={workListRef} className="border border-gray-200 dark:border-gray-700 rounded flex-1 min-h-0 overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-6 h-6 border-2 border-gray-300 dark:border-gray-500 border-t-purple-500 dark:border-t-purple-400 rounded-full animate-spin" />
              </div>
            ) : filteredWorks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                {t('smartCreateTopic.noWorks') || '暂无检测到的作品'}
              </div>
            ) : FixedSizeListComp ? (
              <FixedSizeListComp
                height={workListHeight}
                itemCount={filteredWorks.length}
                itemSize={ITEM_HEIGHT}
                width="100%"
                itemData={workItemData}
                overscanCount={5}
              >
                {WorkRow}
              </FixedSizeListComp>
            ) : (
              <div className="overflow-y-auto h-full">
                {filteredWorks.map((work, index) => (
                  <WorkRow
                    key={work.workName}
                    index={index}
                    style={{ height: ITEM_HEIGHT }}
                    data={workItemData}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm"
              >
                {t('settings.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={selectedWorks.size === 0 || creating}
                className={`flex-1 px-4 py-2 rounded text-sm text-white transition-colors ${selectedWorks.size > 0 && !creating
                  ? 'bg-purple-600 hover:bg-purple-700'
                  : 'bg-gray-400 cursor-not-allowed'
                  }`}
              >
                {creating
                  ? (t('smartCreateTopic.creating') || '创建中...')
                  : `${t('smartCreateTopic.createTopics') || '创建专题'} (${selectedWorks.size})`}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50/50 dark:bg-gray-900/50">
          <div className="p-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-800 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {selectedWork
                ? `${t('smartCreateTopic.preview') || '预览'}`
                : t('smartCreateTopic.selectToPreview') || '选择作品查看详情'}
            </span>
          </div>
          <div className="flex-1 overflow-auto p-6">
            {!selectedWork ? (
              <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-600">
                <div className="text-center">
                  <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4 border border-gray-200 dark:border-gray-700">
                    <FolderOpen size={32} className="opacity-40" />
                  </div>
                  <p className="text-sm">{t('smartCreateTopic.selectWorkToPreview') || '请选择左侧作品以开始预览'}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-6 max-w-4xl mx-auto">
                <div className="relative overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shelf-shadow p-6">
                  {/* Decorative Background */}
                  <div className="absolute top-0 right-0 -mt-8 -mr-8 w-32 h-32 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />

                  <div className="flex items-start gap-6 relative">
                    <div className="w-56 h-[298.7px] rounded-xl overflow-hidden shadow-xl border-4 border-white dark:border-gray-700 flex-shrink-0 relative">
                      {selectedWork.coverFileId ? (
                        <SharpImage
                          src={convertFileSrc(files[selectedWork.coverFileId]?.path)}
                          aspect={3 / 4}
                          className="w-full h-full"
                        />
                      ) : (
                        <div className="w-full h-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                          <Image size={32} className="text-gray-300 dark:text-gray-600" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 pt-2">
                      <h4 className="text-2xl font-bold text-gray-900 dark:text-white mb-2 leading-tight">
                        {language === 'zh' && selectedWork.workNameCn 
                          ? selectedWork.workNameCn 
                          : formatDisplayName(selectedWork.workName)}
                      </h4>
                      <div className="text-sm text-gray-500 dark:text-gray-400 mb-4 flex flex-col gap-1">
                        <span className="font-mono">{formatDisplayName(selectedWork.workName)}</span>
                      </div>

                      <div className="mb-6 flex flex-col gap-1.5 focus-within:text-purple-600 dark:focus-within:text-purple-400">
                        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest transition-colors">
                          {language === 'zh' ? '专题分类' : 'Topic Category'}
                        </label>
                        <input
                          type="text"
                          value={customTopicTypes[selectedWork.workName] !== undefined ? customTopicTypes[selectedWork.workName] : 'TOPIC'}
                          onChange={(e) => setCustomTopicTypes(prev => ({ ...prev, [selectedWork.workName]: e.target.value }))}
                          placeholder={language === 'zh' ? '默认为 TOPIC' : 'Default is TOPIC'}
                          className="px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-bold text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-purple-500 w-full md:w-48 shadow-sm transition-all"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-6 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-xl border border-gray-100 dark:border-gray-800">
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">{language === 'zh' ? '包含角色' : 'Characters'}</span>
                          <span className="text-xl font-bold text-purple-600 dark:text-purple-400 font-mono">{selectedWork.characterCount}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">{language === 'zh' ? '匹配图片' : 'Images'}</span>
                          <span className="text-xl font-bold text-blue-600 dark:text-blue-400 font-mono">{selectedWork.imageCount}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-4 px-1">
                    <div className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                    <h5 className="text-sm font-bold text-gray-800 dark:text-gray-200 uppercase tracking-widest">
                      {language === 'zh' ? '角色列表' : 'Character List'}
                    </h5>
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800 ml-2" />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {selectedWork.characters.map((char: WorkCharacter) => {
                      const person = char.personId ? people[char.personId] : null;
                      const charDisplayName = language === 'zh' && char.tagNameCn 
                        ? char.tagNameCn 
                        : formatCharacterName(char.tagName);
                      const charCoverFile = char.coverFileId ? files[char.coverFileId] : null;
                      const charCoverUrl = charCoverFile ? convertFileSrc(charCoverFile.path) : null;

                      return (
                        <div
                          key={char.tagName}
                          className="flex items-center gap-3 p-3 bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shelf-shadow hover:scale-[1.02] transition-transform duration-200 group"
                        >
                          <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100 dark:bg-gray-800 border-2 border-white dark:border-gray-700 shadow-sm relative">
                            {charCoverUrl ? (
                              <SharpImage src={charCoverUrl} aspect={1} className="w-full h-full" />
                            ) : person ? (
                              <div className="w-full h-full flex items-center justify-center text-sm font-bold text-purple-600 bg-purple-50 dark:bg-purple-900/20">
                                {person.name.charAt(0)}
                              </div>
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Users size={18} className="text-gray-300 dark:text-gray-600" />
                              </div>
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-gray-900 dark:text-white truncate group-hover:text-purple-600 dark:group-hover:text-purple-400 transition-colors">
                              {charDisplayName}
                            </div>
                            <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 font-medium flex items-center gap-2">
                              <span>{char.imageCount} {language === 'zh' ? '张图片' : 'images'}</span>
                              {person && (
                                <span className="flex items-center gap-0.5 text-green-600 dark:text-green-500 font-bold uppercase text-[9px]">
                                  <Check size={8} strokeWidth={4} /> {language === 'zh' ? '已有关联' : 'Linked'}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 mb-4 px-1 mt-8">
                    <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                    <h5 className="text-sm font-bold text-gray-800 dark:text-gray-200 uppercase tracking-widest">
                      {language === 'zh' ? '包含文件' : 'Attached Files'}
                    </h5>
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800 ml-2" />
                  </div>

                  <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shelf-shadow p-4 overflow-hidden" style={{ height: '400px' }}>
                    {selectedWork.fileIds && selectedWork.fileIds.length > 0 ? (
                      <FilePreviewGrid fileIds={selectedWork.fileIds} files={files} resourceRoot={resourceRoot} />
                    ) : (
                      <div className="flex items-center justify-center h-full text-gray-400 italic text-sm">
                        {language === 'zh' ? '暂无匹配文件' : 'No matching files'}
                      </div>
                    )}
                  </div>
                </div>

                {selectedWork.existingTopicId && (
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl p-4 flex items-start gap-3">
                    <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
                        {language === 'zh' ? '专题已存在' : 'Topic Exists'}
                      </p>
                      <p className="text-xs text-amber-700/70 dark:text-amber-400/70 mt-0.5 leading-relaxed">
                        {language === 'zh'
                          ? '系统检测到此作品的专题已存在，无需重复创建。'
                          : 'A topic for this work already exists in your collection.'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
