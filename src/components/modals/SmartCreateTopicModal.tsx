import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { FolderOpen, Check, Sparkles, X, Users, Image } from 'lucide-react';
import * as RW from 'react-window';
import { WorkTopicInfo, Topic, Person } from '../../types';
import { clipGetWorkTopics, clipCreateWorkTopics } from '../../api/tauri-bridge';

const FixedSizeListComp: any = (() => {
  const mod: any = RW as any;
  if (mod.FixedSizeList) return mod.FixedSizeList;
  if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
  if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
  return null;
})();

interface SmartCreateTopicModalProps {
  language: 'zh' | 'en';
  clipSettings: {
    minScore: number;
    modelName: string;
    enabled: boolean;
  };
  people: Record<string, Person>;
  topics: Record<string, Topic>;
  onConfirm: (topics: Topic[], people: Person[]) => void;
  onClose: () => void;
  t: (key: string) => string;
}

const ITEM_HEIGHT = 56;

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
  };
}

const WorkRow = React.memo(({ index, style, data }: WorkRowProps) => {
  const { works, selectedWorks, onToggle, language, onSelect, selectedWorkName } = data;
  const work = works[index];
  const isSelected = selectedWorks.has(work.workName);
  const isPreviewed = selectedWorkName === work.workName;
  
  const displayName = language === 'zh' && work.workNameCn ? work.workNameCn : work.workName;
  const existingTopic = work.existingTopicId;
  
  return (
    <div
      style={style}
      onClick={() => onSelect(work)}
      className={`flex items-center p-2 rounded cursor-pointer group ${
        isPreviewed
          ? 'bg-blue-100 dark:bg-blue-900/30'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          if (!existingTopic) onToggle(work.workName);
        }}
        className={`mr-3 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
          existingTopic
            ? 'border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 cursor-not-allowed'
            : isSelected
              ? 'border-blue-500 bg-blue-500 cursor-pointer'
              : 'border-gray-300 dark:border-gray-600 cursor-pointer'
        }`}
      >
        {isSelected && !existingTopic && <Check size={12} className="text-white" />}
        {existingTopic && <Check size={12} className="text-gray-400 dark:text-gray-500" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${isPreviewed ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-800 dark:text-gray-200'}`}>
          {displayName}
          {existingTopic && <span className="ml-2 text-xs text-gray-400">({language === 'zh' ? '已创建' : 'Created'})</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
          <span className="flex items-center gap-1"><Users size={10} />{work.characterCount}</span>
          <span className="flex items-center gap-1"><Image size={10} />{work.imageCount}</span>
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
      const workNames = Array.from(selectedWorks);
      console.log('[SmartCreateTopicModal] Creating topics for works:', workNames);
      const result = await clipCreateWorkTopics(workNames);
      console.log('[SmartCreateTopicModal] Created topics:', result.topics);
      console.log('[SmartCreateTopicModal] Created people:', result.people);
      onConfirm(result.topics, result.people);
    } catch (error) {
      console.error('Failed to create work topics:', error);
    } finally {
      setCreating(false);
    }
  }, [selectedWorks, onConfirm]);

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
    selectedWorkName: selectedWork?.workName ?? null
  }), [filteredWorks, selectedWorks, handleToggleWork, language, handleSelectWork, selectedWork]);

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
        <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 p-4 flex flex-col overflow-hidden">
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
                className={`flex-1 px-4 py-2 rounded text-sm text-white transition-colors ${
                  selectedWorks.size > 0 && !creating
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

        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
          <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectedWork
                ? `${t('smartCreateTopic.preview') || '预览'}: ${language === 'zh' && selectedWork.workNameCn ? selectedWork.workNameCn : selectedWork.workName}`
                : t('smartCreateTopic.selectToPreview') || '选择作品查看详情'}
            </span>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {!selectedWork ? (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <FolderOpen size={48} className="mx-auto mb-3 opacity-30" />
                  <p>{t('smartCreateTopic.selectWorkToPreview') || '请选择作品查看详情'}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
                  <h4 className="font-medium text-gray-900 dark:text-white mb-2">
                    {language === 'zh' ? '作品信息' : 'Work Info'}
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">{language === 'zh' ? '英文名' : 'English Name'}:</span>
                      <span className="ml-2 text-gray-900 dark:text-white">{selectedWork.workName}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">{language === 'zh' ? '中文名' : 'Chinese Name'}:</span>
                      <span className="ml-2 text-gray-900 dark:text-white">{selectedWork.workNameCn || '-'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">{language === 'zh' ? '角色数' : 'Characters'}:</span>
                      <span className="ml-2 text-gray-900 dark:text-white">{selectedWork.characterCount}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">{language === 'zh' ? '图片数' : 'Images'}:</span>
                      <span className="ml-2 text-gray-900 dark:text-white">{selectedWork.imageCount}</span>
                    </div>
                  </div>
                </div>

                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
                  <h4 className="font-medium text-gray-900 dark:text-white mb-3">
                    {language === 'zh' ? '角色列表' : 'Character List'}
                  </h4>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {selectedWork.characters.map((char) => {
                      const person = char.personId ? people[char.personId] : null;
                      const charDisplayName = language === 'zh' && char.tagNameCn ? char.tagNameCn : char.tagName;
                      
                      return (
                        <div
                          key={char.tagName}
                          className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700 rounded"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
                              {person ? (
                                <span className="text-xs text-gray-600 dark:text-gray-300">
                                  {person.name.charAt(0)}
                                </span>
                              ) : (
                                <Users size={14} className="text-gray-400" />
                              )}
                            </div>
                            <div>
                              <div className="text-sm text-gray-900 dark:text-white">{charDisplayName}</div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                {char.imageCount} {language === 'zh' ? '张图片' : 'images'}
                              </div>
                            </div>
                          </div>
                          {person && (
                            <span className="text-xs text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-0.5 rounded">
                              {language === 'zh' ? '已创建' : 'Created'}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {selectedWork.existingTopicId && (
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
                    <p className="text-sm text-yellow-700 dark:text-yellow-300">
                      {language === 'zh'
                        ? '此作品的专题已存在，无法重复创建'
                        : 'Topic for this work already exists'}
                    </p>
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
