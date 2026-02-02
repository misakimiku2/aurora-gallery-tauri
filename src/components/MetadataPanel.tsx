import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';

// 辅助函数：深度查找文件夹内的图片
const findImagesDeeply = (
    rootFolder: FileNode, 
    allFiles: Record<string, FileNode>, 
    limit: number = 3
): FileNode[] => {
    const images: FileNode[] = [];
    // 使用栈进�?DFS
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>(); // 防止循环引用
    
    // 设置一个遍历上限，防止超大文件夹卡�?UI
    let traversalCount = 0;
    const MAX_TRAVERSAL = 200;

    while (stack.length > 0 && images.length < limit && traversalCount < MAX_TRAVERSAL) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        traversalCount++;

        const node = allFiles[id];
        if (!node) continue;
        
        if (node.type === FileType.IMAGE) {
            images.push(node);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }
    
    // 排序并切�?
    return images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);
};
import { createPortal } from 'react-dom';
import { FileNode, FileType, Person, TabState, Topic } from '../types';
import { formatSize, getFolderStats, getFolderPreviewImages } from '../utils/mockFileSystem';
import { Tag, Link, HardDrive, FileText, Globe, FolderOpen, Copy, X, MoreHorizontal, Folder as FolderIcon, Calendar, Clock, PieChart, Edit3, Check, Save, Search, ChevronDown, ChevronUp, ChevronRight, Scan, Sparkles, Smile, User, Languages, Book, Film, Folder, ExternalLink, Image as ImageIcon, Palette as PaletteIcon, Trash2, RefreshCw, Layout } from 'lucide-react';
import { Folder3DIcon } from './Folder3DIcon';
// 导入 ImageViewer 的高分辨率缓�?
import { getBlobCacheSync, preloadToCache } from './ImageViewer';

interface MetadataProps {
  files: Record<string, FileNode>;
  selectedFileIds: string[];
  people?: Record<string, Person>;
  topics?: Record<string, Topic>;
  selectedPersonIds?: string[];
  selectedTopicIds?: string[];
  onUpdate: (id: string, updates: Partial<FileNode>) => void;
  onUpdatePerson?: (id: string, updates: Partial<Person>) => void;
  onUpdateTopic?: (id: string, updates: Partial<Topic>) => void;
  onDeleteTopic?: (id: string) => void;
  onSelectTopic?: (id: string) => void;
  onSelectPerson?: (id: string) => void;
  onNavigateToFolder: (folderId: string, options?: { targetId?: string }) => void;
  onNavigateToTag: (tag: string) => void;
  onSearch: (query: string) => void;
  t: (key: string) => string;
  activeTab: TabState;
  resourceRoot?: string;
  cachePath?: string;
}

// Image Preview Component for Tauri
// 获取或初始化全局缓存 (与FileGrid.tsx共享)
const getGlobalCache = () => {
  // 使用类型断言来访问全局缓存，避免重新定义LRUCache类型
  const win = window as any;
  
  // 只在缓存不存在时创建新实�?
  if (!win.__AURORA_THUMBNAIL_CACHE__) {
    // 这里不重新定义LRUCache类，因为它已经在FileGrid.tsx中定义了
    // 我们假设当FileGrid组件加载时，已经初始化了缓存
    return null;
  }
  
  return win.__AURORA_THUMBNAIL_CACHE__;
};

const ImagePreview = ({ file, resourceRoot, cachePath }: { file: FileNode, resourceRoot?: string, cachePath?: string }) => {
  // 初始化时优先�?ImageViewer 的高分辨�?Blob 缓存获取
  const [imageUrl, setImageUrl] = useState<string | null>(() => {
      if (!file.path) return null;
      // 优先使用高分辨率缓存
      const blobUrl = getBlobCacheSync(file.path);
      if (blobUrl) return blobUrl;
      // 其次使用缩略图缓�?
      const cache = getGlobalCache();
      return cache?.get(file.path) || null;
  });
  
  const [isLoading, setIsLoading] = useState(!imageUrl);
  
  useEffect(() => {
    const controller = new AbortController();

    const loadImage = async () => {
      if (!file.path) {
        setImageUrl(null);
        setIsLoading(false);
        return;
      }
      
      // 优先检�?ImageViewer 的高分辨�?Blob 缓存
      const blobUrl = getBlobCacheSync(file.path);
      if (blobUrl) {
        setImageUrl(blobUrl);
        setIsLoading(false);
        return;
      }
      
      // 检查全局缩略图缓�?
      const cache = getGlobalCache();
      const cachedUrl = cache?.get(file.path);
      
      if (cachedUrl) {
        setImageUrl(cachedUrl);
        setIsLoading(false);
        return;
      }
      
      // 如果缓存中没有，才显示加载状�?
      setIsLoading(true);
      
      try {
        // Use getThumbnail for preview (smaller, faster)
        const { getThumbnail } = await import('../api/tauri-bridge');
        
        if (controller.signal.aborted) return;

        let dataUrl = await getThumbnail(file.path, undefined, resourceRoot, controller.signal);
        
        if (controller.signal.aborted) return;

        // Fallback or use full image if thumbnail generation fails or returns null
        // But do not fallback if it was aborted!
        if (!dataUrl && file.path && !controller.signal.aborted) {
             const { convertFileSrc } = await import('@tauri-apps/api/core');
             dataUrl = convertFileSrc(file.path);
        }
        
        if (dataUrl) {
          // 更新全局缓存
          if (cache) cache.set(file.path, dataUrl);
          if (!controller.signal.aborted) setImageUrl(dataUrl);
        } else {
          if (!controller.signal.aborted) setImageUrl(null);
        }
      } catch (error) {
        console.error('Failed to load preview image:', error);
        if (!controller.signal.aborted) setImageUrl(null);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    
    loadImage();

    return () => {
      controller.abort();
    };
  }, [file.path, file.id, resourceRoot]);
  
  return (
    <div className="flex flex-col items-center">
      <div className="w-full rounded-lg overflow-hidden bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-800 flex justify-center items-center p-2 mb-2 shadow-sm min-h-[200px]">
        {isLoading ? (
          <div className="flex items-center justify-center">
            <ImageIcon className="animate-pulse text-gray-400" size={32} />
          </div>
        ) : imageUrl ? (
          <img 
            src={imageUrl} 
            className="max-w-full max-h-[300px] object-contain rounded" 
            alt={file.name} 
            decoding="async"
            style={{
                willChange: 'transform, width, height',
                WebkitBackfaceVisibility: 'hidden',
                backfaceVisibility: 'hidden',
                transform: 'translate3d(0, 0, 0)',
            }}
          />
        ) : (
          <div className="flex items-center justify-center">
            <ImageIcon className="text-gray-400" size={32} />
          </div>
        )}
      </div>
    </div>
  );
};


const CategorySelector = ({ current, onChange, t }: any) => (
  <div className="space-y-2 pt-4 border-t border-gray-200 dark:border-gray-800">
      <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold mb-2">{t('meta.folderCategory')}</div>
      <div className="flex bg-gray-100 dark:bg-gray-800 p-1.5 rounded-xl gap-2">
          {['general', 'book', 'sequence'].map((cat) => {
              const isActive = current === cat;
              return (
                  <button
                      key={cat}
                      onClick={() => onChange(cat)}
                      className={`flex-1 flex flex-col items-center justify-center py-3 rounded-lg text-xs font-medium transition-all ${
                          isActive
                          ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-md ring-1 ring-black/5 dark:ring-white/10' 
                          : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-gray-100'
                      }`}
                  >
                      {cat === 'general' && <Folder size={20} className={`mb-1.5 ${isActive ? 'fill-blue-100 dark:fill-blue-900/30' : ''}`}/>}
                      {cat === 'book' && <Book size={20} className={`mb-1.5 ${isActive ? 'fill-amber-100 dark:fill-amber-900/30' : ''}`}/>}
                      {cat === 'sequence' && <Film size={20} className={`mb-1.5 ${isActive ? 'fill-purple-100 dark:fill-purple-900/30' : ''}`}/>}
                      {t(`meta.cat${cat.charAt(0).toUpperCase() + cat.slice(1)}`)}
                  </button>
              );
          })}
      </div>
  </div>
);

const DistributionChart = ({ data, totalFiles }: { data: { label: string, value: number, color: string }[], totalFiles: number }) => {
    const max = Math.max(...data.map(d => d.value), 1);

    return (
        <div className="space-y-3">
            {data.map((item) => (
                <div key={item.label} className="flex items-center text-xs group">
                    <div className="w-20 text-gray-500 dark:text-gray-400 font-medium truncate shrink-0" title={item.label}>
                        {item.label}
                    </div>
                    <div className="flex-1 mx-3 h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div 
                            className={`h-full rounded-full ${item.color} shadow-sm transition-all duration-700 ease-out`}
                            style={{ width: `${(item.value / max) * 100}%` }}
                        />
                    </div>
                    <div className="w-12 text-right text-gray-700 dark:text-gray-300 font-mono font-medium">
                        {item.value}
                    </div>
                </div>
            ))}
            {data.length === 0 && (
                <div className="text-center text-gray-400 text-xs py-2 italic">No files found</div>
            )}
        </div>
    );
};

export const MetadataPanel: React.FC<MetadataProps> = ({ selectedFileIds, files, people, topics, selectedPersonIds, selectedTopicIds, onUpdate, onUpdatePerson, onUpdateTopic, onDeleteTopic, onSelectTopic, onSelectPerson, onNavigateToFolder, onNavigateToTag, onSearch, t, activeTab, resourceRoot, cachePath }) => {
  const isMulti = selectedFileIds.length > 1;
  const file = !isMulti && selectedFileIds.length === 1 ? files[selectedFileIds[0]] : null;
  
  // Topic Handling
  const selectedTopicCount = selectedTopicIds ? selectedTopicIds.length : 0;
  const topic = selectedTopicCount === 1 && topics && selectedTopicIds ? topics[selectedTopicIds[0]] : null;
  
  // state for topic
  const [topicName, setTopicName] = useState('');
  const [topicDesc, setTopicDesc] = useState('');
  const [topicSource, setTopicSource] = useState('');
  const [showSavedTopic, setShowSavedTopic] = useState(false);

  // 处理人物选择
  const isMultiPerson = selectedPersonIds && selectedPersonIds.length > 1;
  const selectedPeopleCount = selectedPersonIds ? selectedPersonIds.length : 0;
  const person = !isMultiPerson && selectedPeopleCount === 1 && people ? people[selectedPersonIds![0]] : null;

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [source, setSource] = useState('');
  
  const [personName, setPersonName] = useState('');
  const [personDesc, setPersonDesc] = useState('');
  const [originalPersonName, setOriginalPersonName] = useState('');
  const [originalPersonDesc, setOriginalPersonDesc] = useState('');
  const [showSavedPerson, setShowSavedPerson] = useState(false);

  // Dynamic name width helpers to avoid overlapping edit icon
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const nameMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [nameWidth, setNameWidth] = useState<number>(120);
  const [wrapperWidth, setWrapperWidth] = useState<number>(160);
  const MAX_NAME_WIDTH = 260; // allow larger names in side panel
  const ICON_PADDING = 32; // space for icon and little gap

  useEffect(() => {
    const compute = () => {
      const measureEl = nameMeasureRef.current;
      if (!measureEl) return;
      const measured = Math.ceil(measureEl.offsetWidth);
      // Compute name width based on measured text but cap to available max minus icon padding
      const computedNameW = Math.max(40, Math.min(measured + 8, MAX_NAME_WIDTH - ICON_PADDING));
      setNameWidth(computedNameW);
      setWrapperWidth(Math.min(MAX_NAME_WIDTH, computedNameW + ICON_PADDING));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [personName, nameMeasureRef]);
  
  const [batchDesc, setBatchDesc] = useState('');
  const [batchSource, setBatchSource] = useState('');
  const [isDescMixed, setIsDescMixed] = useState(false);
  const [isSourceMixed, setIsSourceMixed] = useState(false);

  const [showSavedDesc, setShowSavedDesc] = useState(false);
  const [showSavedSource, setShowSavedSource] = useState(false);

  const [newTagInput, setNewTagInput] = useState('');
  const [toast, setToast] = useState<{msg: string, visible: boolean}>({ msg: '', visible: false });
  const [paletteMenu, setPaletteMenu] = useState<{ visible: boolean, x: number, y: number, color: string | null }>({ visible: false, x: 0, y: 0, color: null });
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [toastPos, setToastPos] = useState<{ left?: number; bottom?: number } | null>(null);
    const toastRef = useRef<HTMLDivElement | null>(null);
  const [expandedTopicIds, setExpandedTopicIds] = useState<Set<string>>(new Set());
  
  // Palette menu close handler for scroll events
  useEffect(() => {
        const handleWheel = (e: WheelEvent) => {
            if (paletteMenu.visible) {
                setPaletteMenu({ ...paletteMenu, visible: false });
            }
        };

    document.addEventListener('wheel', handleWheel, true);

    return () => {
      document.removeEventListener('wheel', handleWheel, true);
    };
  }, [paletteMenu]);

    // Update toast position so it's fixed at bottom-center of this panel
    useEffect(() => {
        const update = () => {
            const el = panelRef.current;
            if (!el) return setToastPos(null);
            const rect = el.getBoundingClientRect();
            const bottom = Math.max(12, window.innerHeight - rect.bottom + 12); // gap from panel bottom

            // If toast element exists, measure its width and center precisely
            const toastEl = toastRef.current;
            if (toastEl) {
                const tw = toastEl.offsetWidth;
                const left = rect.left + (rect.width - tw) / 2;
                setToastPos({ left, bottom });
            } else {
                // Fallback: center by panel center; will be corrected after toast mounts
                const left = rect.left + rect.width / 2;
                setToastPos({ left, bottom });
            }
        };

        if (toast.visible) {
            // update immediately and again on next frame to account for DOM
            update();
            requestAnimationFrame(update);
        }
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [toast.visible]);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const personDescRef = useRef<HTMLTextAreaElement>(null);
  
  // Cache to prevent infinite re-extraction loops for the same file ID
  const extractedCache = useRef<Set<string>>(new Set());

  const systemTags = useMemo(() => {
    const tags = new Set<string>();
    Object.values(files).forEach((f: FileNode) => f.tags.forEach(tag => tags.add(tag)));
    return Array.from(tags).sort();
  }, [files]);

  // Find which topic the selected file belongs to
  const fileTopic = useMemo(() => {
    if (!file || !topics) return null;
    
    // Find the topic that contains this file's ID in its fileIds
    const topicList = Object.values(topics);
    // Note: We prioritize finding sub-topics (topics with parentId) first
    // as a file might technically be in both if the logic allows, 
    // but usually it's assigned to a specific sub-topic.
    const targetTopic = topicList.find(t => t.fileIds?.includes(file.id) && t.parentId) 
                     || topicList.find(t => t.fileIds?.includes(file.id));
    
    if (!targetTopic) return null;
    
    // Check if it has a parent (meaning it's a sub-topic)
    if (targetTopic.parentId && topics[targetTopic.parentId]) {
      return {
        main: topics[targetTopic.parentId],
        sub: targetTopic
      };
    }
    
    return {
      main: targetTopic,
      sub: null
    };
  }, [file?.id, topics]);

  useEffect(() => {
    if (file) {
      setName(file.name);
      setDesc(file.description || '');
      setSource(file.sourceUrl || '');
      
      // Extract palette colors when file is selected
      if (file.type === FileType.IMAGE && (file.path || file.url)) {
        const currentPalette = file.meta?.palette;
        let shouldExtract = false;

        if (!currentPalette || currentPalette.length === 0) {
            // Missing palette
            shouldExtract = true;
        } else if (currentPalette.every(c => c === '#000000')) {
            // All black (placeholder)
            shouldExtract = true;
        } else {
            // Enhanced "Bad Palette" Detection
            if (currentPalette.length >= 2) {
                const hexToRgb = (hex: string) => {
                    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r:0,g:0,b:0 };
                };
                
                const rgbs = currentPalette.map(hexToRgb);
                let maxDist = 0;
                let minDist = Infinity;
                
                for (let i = 0; i < rgbs.length; i++) {
                    for (let j = i + 1; j < rgbs.length; j++) {
                        const d = Math.sqrt((rgbs[i].r-rgbs[j].r)**2 + (rgbs[i].g-rgbs[j].g)**2 + (rgbs[i].b-rgbs[j].b)**2);
                        if (d > maxDist) maxDist = d;
                        if (d < minDist) minDist = d;
                    }
                }
                
                // 1. Clump check: Entire palette is too similar (monochrome)
                if (maxDist < 20) {
                    shouldExtract = true;
                }
                // 2. Duplicate check: Any two colors are too close (likely duplicates)
                // Threshold 10 ensures we re-run if we have near-duplicates like #252429 vs #242328 (dist ~1.7)
                if (minDist < 10) {
                    shouldExtract = true;
                }
            }
        }

        // Only run if we haven't already processed this file in this session
        if (shouldExtract && !extractedCache.current.has(file.id) && file.path) {
           extractedCache.current.add(file.id); // Mark as processing/processed
           // Use direct file path for palette extraction (bypass URL parsing issues)
           (async () => {
             try {

               const { getDominantColors } = await import('../api/tauri-bridge');
               
               // 尝试从全局缩略图路径缓存中获取缩略图路�?
               let thumbnailPath: string | null = null;
               const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
               if (pathCache && pathCache.get) {
                   thumbnailPath = pathCache.get(file.path!);
                   if (thumbnailPath) {
                           // 使用缓存的缩略图路径
                       }
               }
               
               // 如果缓存中没有，尝试生成缩略图并获取路径
               if (!thumbnailPath && resourceRoot) {
                   try {
                       const { getThumbnail } = await import('../api/tauri-bridge');
                       // getThumbnail 返回的是 convertFileSrc 后的 URL，我们需要原始路�?
                       // 所以我们先调用 getThumbnail 确保缩略图存在，然后从缓存中获取路径
                       const thumbUrl = await getThumbnail(file.path!, undefined, resourceRoot);
                       if (thumbUrl) {
                               // 重新从缓存获取原始路�?
                               thumbnailPath = pathCache.get(file.path!);
                           }
                   } catch (err) {
                       // 忽略缩略图生成失败，继续使用原图提取
                   }
               }
               
               // 使用缩略图路径（如果可用）或原图路径进行颜色提取
               const colors = await getDominantColors(file.path!, 8, thumbnailPath || undefined);
               if (colors && colors.length > 0) {
                   const hexColors = colors.map(c => c.hex);
                   // 只有当提取的颜色与当前颜色不同时才更新，避免不必要的更新
                   const currentHexColors = currentPalette || [];
                   const colorsChanged = JSON.stringify(hexColors) !== JSON.stringify(currentHexColors);
                   
                   if (colorsChanged) {
                       onUpdate(file.id, {
                           meta: { ...file.meta!, palette: hexColors }
                       });
                   }
               }
             } catch (err) {
               console.error('[Auto-extract] Failed to extract palette:', err);
             }
           })();
        }
      }
    } else if (isMulti) {
       /* ... (existing multi-select logic) ... */
       const selectedNodes = selectedFileIds.map(id => files[id]).filter(Boolean);
       const firstDesc = selectedNodes[0]?.description || '';
       const firstSource = selectedNodes[0]?.sourceUrl || '';
       
       const descMixed = selectedNodes.some(n => (n.description || '') !== firstDesc);
       const sourceMixed = selectedNodes.some(n => (n.sourceUrl || '') !== firstSource);
       
       setIsDescMixed(descMixed);
       setIsSourceMixed(sourceMixed);
       setBatchDesc(descMixed ? '' : firstDesc);
       setBatchSource(sourceMixed ? '' : firstSource);
    } else {
      setName('');
      setDesc('');
      setSource('');
    }
    
    if (topic) {
        setTopicName(topic.name);
        setTopicDesc(topic.description || '');
        setTopicSource(topic.sourceUrl || '');
    }
    
    if (person) {
        setPersonName(person.name);
        setPersonDesc(person.description || '');
        setOriginalPersonName(person.name);
        setOriginalPersonDesc(person.description || '');
    }

    setNewTagInput('');
    setShowSavedDesc(false);
    setShowSavedSource(false);
    setShowSavedPerson(false);
    setPaletteMenu({ visible: false, x: 0, y: 0, color: null });
  }, [file?.id, file?.description, file?.aiData, selectedFileIds.join(','), isMulti, person?.id, topic?.id, topics]);

  const handleUpdateTopicMeta = () => {
      if (topic && onUpdateTopic) {
          onUpdateTopic(topic.id, { name: topicName, description: topicDesc, sourceUrl: topicSource, updatedAt: new Date().toISOString() });
          setShowSavedTopic(true);
          setTimeout(() => setShowSavedTopic(false), 2000);
      }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(Math.max(textareaRef.current.scrollHeight, 60), 450);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [desc]);
  
  useEffect(() => {
    if (personDescRef.current) {
        personDescRef.current.style.height = 'auto';
        const newHeight = Math.max(personDescRef.current.scrollHeight, 60);
        personDescRef.current.style.height = `${newHeight}px`;
    }
  }, [personDesc]);

  const colors = useMemo(() => {
    if (!file) return [];
    
    // Prioritize locally extracted palette because it now has smart filtering
    if (file.meta?.palette && file.meta.palette.length > 0) {
        return file.meta.palette;
    }
    
    // Fallback to AI data if local palette is missing
    if (file.aiData?.dominantColors && file.aiData.dominantColors.length > 0) {
        return file.aiData.dominantColors;
    }
    
    return [];
  }, [file?.meta?.palette, file?.aiData?.dominantColors, file]);

  const folderDetails = useMemo(() => {
    if (file && file.type === FileType.FOLDER) {
        const types: Record<string, number> = {};
        let totalFiles = 0;
        let subFolderCount = 0;
        
        const stack = [file.id];
        
        while(stack.length) {
            const currentId = stack.pop()!;
            const node = files[currentId];
            if (!node) continue;
            
            if (currentId !== file.id) {
                if (node.type === FileType.FOLDER) {
                    subFolderCount++;
                } else if (node.type === FileType.IMAGE) {
                    totalFiles++;
                    const fmt = node.meta?.format.toUpperCase() || 'OTHER';
                    types[fmt] = (types[fmt] || 0) + 1;
                }
            }

            if (node.children) {
                stack.push(...node.children);
            }
        }
        
        return { types, totalFiles, subFolderCount };
    }
    return null;
  }, [file, files]);

  const folderStats = useMemo(() => {
    if (file && file.type === FileType.FOLDER) {
      return getFolderStats(files, file.id);
    }
    return null;
  }, [file, files]);

  // 获取或初始化全局缓存 (与FileGrid.tsx共享)
  const getGlobalCache = () => {
    const win = window as any;
    return win.__AURORA_THUMBNAIL_CACHE__ || null;
  };

  // 文件夹预览图，与主界面保持一�?
  const [folderPreviewImages, setFolderPreviewImages] = useState<string[]>([]);
  const [folderPreviewLoaded, setFolderPreviewLoaded] = useState(false);

  // 当文件或资源根目录变化时，更新文件夹预览�?
  useEffect(() => {
    if (!file || file.type !== FileType.FOLDER) {
      setFolderPreviewImages([]);
      setFolderPreviewLoaded(true);
      return;
    }

    // 1. 深度查找文件夹内的图�?
    const imageChildren = findImagesDeeply(file, files, 3);
    
    // 2. 检查全局缓存中是否已有缩略图
    const cache = getGlobalCache();
    if (cache) {
      // 尝试映射所有子文件到缓存中�?URL
      const cachedUrls = imageChildren.map((child: FileNode) => {
          return cache.get(child.path) || null; 
      });
      
      // 过滤�?null �?
      const validUrls = cachedUrls.filter((url: any): url is string => !!url);
      
      // 如果缓存中有数据，立即更�?
      if (validUrls.length > 0) {
        setFolderPreviewImages(validUrls);
      }
    }

    // 3. 如果没有足够的缓存数据，异步加载
    if (imageChildren.length > 0) {
      const loadPreviews = async () => {
        try {
          const { getThumbnail } = await import('../api/tauri-bridge');
          
          // 并行请求所有子文件的缩略图
          const promises = imageChildren.map(async (img: FileNode) => {
              // 先查缓存，如果有就不请求�?
              const cache = getGlobalCache();
              if (cache) {
                const cached = cache.get(img.path);
                if (cached) return cached;
              }

              // 请求新图
              const url = await getThumbnail(img.path, img.updatedAt, resourceRoot);
              return url;
          });

          const thumbnails = await Promise.all(promises);
          
          // 过滤�?null �?
          const validThumbnails = thumbnails.filter((t: any): t is string => !!t);
          
          // 更新预览�?
          if (validThumbnails.length > 0) {
            setFolderPreviewImages(validThumbnails);
          }
        } catch (error) {
          console.error('Failed to load folder previews:', error);
        } finally {
          setFolderPreviewLoaded(true);
        }
      };

      loadPreviews();
    } else {
      setFolderPreviewLoaded(true);
    }
  }, [file, files, resourceRoot]);

  const typeColors: Record<string, string> = {
      'JPG': 'bg-green-500 dark:bg-green-400',
      'JPEG': 'bg-green-500 dark:bg-green-400',
      'PNG': 'bg-teal-500 dark:bg-teal-400',
      'GIF': 'bg-purple-500 dark:bg-purple-400',
      'WEBP': 'bg-pink-500 dark:bg-pink-400',
      'SVG': 'bg-orange-500 dark:bg-orange-400',
      'MP4': 'bg-red-500 dark:bg-red-400',
      'MOV': 'bg-red-500 dark:bg-red-400',
      'FOLDER': 'bg-blue-500 dark:bg-blue-400'
  };
  const defaultColor = 'bg-gray-500 dark:bg-gray-400';

  const chartData = useMemo(() => {
    if (!folderDetails) return [];
    const data: { label: string; value: number; color: string }[] = [];
    
    if (folderDetails.subFolderCount > 0) {
        data.push({ 
            label: t('context.subfolders'), 
            value: folderDetails.subFolderCount, 
            color: typeColors['FOLDER'] || defaultColor
        });
    }
    
    Object.entries(folderDetails.types).forEach(([type, count]) => {
        data.push({ 
            label: type, 
            value: count, 
            color: typeColors[type] || defaultColor
        });
    });
    
    return data.sort((a, b) => b.value - a.value);
  }, [folderDetails, t]);
  
  const personStats = useMemo(() => {
    if (!person) return null;
    let totalSize = 0;
    let count = 0;
    Object.values(files).forEach((f: FileNode) => {
        if (f.type === FileType.IMAGE && f.aiData?.faces.some(face => face.personId === person.id)) {
            totalSize += f.meta?.sizeKb || 0;
            count++;
        }
    });
    return { totalSize, count };
  }, [person, files]);
  
  const batchStats = useMemo(() => {
    if (!isMulti) return null;
    const selectedNodes = selectedFileIds.map(id => files[id]).filter(Boolean);
    
    let totalSize = 0;
    const typeCount: Record<string, number> = {};
    const allTags = new Set<string>();

    selectedNodes.forEach(node => {
        if (node.type === FileType.IMAGE) {
            totalSize += node.meta?.sizeKb || 0;
            const fmt = node.meta?.format.toUpperCase() || 'UNKNOWN';
            typeCount[fmt] = (typeCount[fmt] || 0) + 1;
        } else {
            typeCount['FOLDER'] = (typeCount['FOLDER'] || 0) + 1;
            const fs = getFolderStats(files, node.id);
            totalSize += fs.size;
        }
        node.tags.forEach(t => allTags.add(t));
    });

    return { totalSize, typeCount, allTags: Array.from(allTags).sort() };
  }, [selectedFileIds, files]);

  const batchChartData = useMemo(() => {
      if (!batchStats) return [];
      const data: { label: string; value: number; color: string }[] = [];

      Object.entries(batchStats.typeCount).forEach(([type, count]) => {
          let label = type;
          let colorKey = type;
          if (type === 'FOLDER') {
              label = t('meta.folderType');
              colorKey = 'FOLDER';
          }
          data.push({
              label: label,
              value: count,
              color: typeColors[colorKey] || defaultColor
          });
      });

      return data.sort((a, b) => b.value - a.value);
  }, [batchStats, t]);

  const handleUpdateMeta = () => {
    if (isMulti) {
        selectedFileIds.forEach(id => {
            const updates: Partial<FileNode> = {};
            if (!isDescMixed && batchDesc) updates.description = batchDesc;
            if (!isSourceMixed && batchSource) updates.sourceUrl = batchSource;
            if (Object.keys(updates).length > 0) onUpdate(id, updates);
        });
    } else if (file) {
        onUpdate(file.id, { name, description: desc, sourceUrl: source });
    }
    setShowSavedDesc(true);
    setShowSavedSource(true);
    setTimeout(() => {
        setShowSavedDesc(false);
        setShowSavedSource(false);
    }, 2000);
  };

  const handleUpdatePersonMeta = () => {
      if (person && onUpdatePerson) {
          const newName = (personName || '').trim();
          const newDesc = (personDesc || '').trim();
          // Only persist if something actually changed
          if (newName !== person.name || newDesc !== (person.description || '')) {
              onUpdatePerson(person.id, { name: newName, description: newDesc });
          }
          // Reflect trimmed value in UI
          setPersonName(newName);
          setShowSavedPerson(true);
          setTimeout(() => setShowSavedPerson(false), 2000);
      }
  };

  const handleAddTag = (tag: string) => {
      if (!tag.trim()) return;
      const tagToAdd = tag.trim();
      if (isMulti) {
          selectedFileIds.forEach(id => {
              const f = files[id];
              if (f && !f.tags.includes(tagToAdd)) {
                  onUpdate(id, { tags: [...f.tags, tagToAdd] });
              }
          });
      } else if (file && !file.tags.includes(tagToAdd)) {
          onUpdate(file.id, { tags: [...file.tags, tagToAdd] });
      }
      setNewTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
      if (isMulti) {
          selectedFileIds.forEach(id => {
              const f = files[id];
              if (f) {
                  onUpdate(id, { tags: f.tags.filter(t => t !== tag) });
              }
          });
      } else if (file) {
          onUpdate(file.id, { tags: file.tags.filter(t => t !== tag) });
      }
  };

  const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      setToast({ msg: t('context.copied'), visible: true });
      setTimeout(() => setToast({ msg: '', visible: false }), 2000);
  };

  const handleCategoryChange = (category: 'general' | 'book' | 'sequence') => {
      if (isMulti) {
          selectedFileIds.forEach(id => {
              if (files[id]?.type === FileType.FOLDER) {
                  onUpdate(id, { category });
              }
          });
      } else if (file && file.type === FileType.FOLDER) {
          onUpdate(file.id, { category });
      }
  };

  if (topic) {
      // 封面获取逻辑增强：增加首个文件作为回退
      const getCoverUrlInternal = (t: Topic) => {
          if (t.coverFileId && files[t.coverFileId]) {
              return convertFileSrc(files[t.coverFileId].path);
          }
          if (t.fileIds && t.fileIds.length > 0) {
              // 优先查找第一个图片文�?
              for (const fid of t.fileIds) {
                  const f = files[fid];
                  if (f && f.type === FileType.IMAGE) {
                      return convertFileSrc(f.path);
                  }
              }
              // 如果没有找到明确标记为图片的文件，回退到第一个对应的文件
              const firstFile = files[t.fileIds[0]];
              if (firstFile) return convertFileSrc(firstFile.path);
          }
          return null;
      };

      const coverUrl = getCoverUrlInternal(topic);
      const subTopics = topics ? Object.values(topics).filter(t => t.parentId === topic.id) : [];
      // Aggregate people: include people from descendant subtopics when viewing a main topic
      let topicPeople: Person[] = [];
      // Map personId -> number of descendant subtopics (exclude root topic itself)
      const peopleSubtopicCount: Record<string, number> = {};
      if (people) {
          if (!topic.parentId && topics) {
              const stack: string[] = [topic.id];
              const collected = new Set<string>();
              while (stack.length > 0) {
                  const tid = stack.pop()!;
                  const t = topics[tid];
                  if (!t) continue;
                  // collect people ids
                  (t.peopleIds || []).forEach(pid => collected.add(pid));
                  // count occurrences for descendant subtopics only
                  if (tid !== topic.id) {
                      (t.peopleIds || []).forEach(pid => {
                          peopleSubtopicCount[pid] = (peopleSubtopicCount[pid] || 0) + 1;
                      });
                  }
                  Object.values(topics).forEach(sub => {
                      if (sub.parentId === tid) stack.push(sub.id);
                  });
              }
              topicPeople = Array.from(collected).map(id => people[id]).filter(Boolean);
          } else {
              topicPeople = topic.peopleIds.map(id => people[id]).filter(Boolean);
          }
      }
      
      // 计算文件数量
      const topicFileCount = topic.fileIds ? topic.fileIds.length : 0;

      // 获取封面样式 - �?TopicModule 保持一致的算法
      const getCoverStyle = (t: Topic, overrideUrl?: string | null): React.CSSProperties => {
          const url = overrideUrl || getCoverUrlInternal(t);
          if (!url) return {};
          
          const style: React.CSSProperties = {
              backgroundImage: `url("${url}")`,
              backgroundRepeat: 'no-repeat'
          };
          
          const crop = t.coverCrop;
          // 复用 TopicModule.tsx 中的裁剪算法，确保显示一�?
          if (crop && crop.width > 0 && crop.height > 0) {
              const safeWidth = Math.min(Math.max(crop.width, 0.1), 99.9);
              const safeHeight = Math.min(Math.max(crop.height, 0.1), 99.9);

              const sizeW = 10000 / safeWidth;
              const sizeH = 10000 / safeHeight;

              // 计算位置百分�? (offset / remaining_space) * 100
              // �?safeWidth �?100 时，分母�?0，所以上面做�?99.9 的限�?
              const posX = (crop.x / (100 - safeWidth)) * 100;
              const posY = (crop.y / (100 - safeHeight)) * 100;

              style.backgroundSize = `${sizeW}% ${sizeH}%`;
              style.backgroundPosition = `${posX}% ${posY}%`;
          } else {
              style.backgroundSize = 'cover';
              style.backgroundPosition = 'center';
          }
          return style;
      };

      return (
        <div className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-y-auto custom-scrollbar relative">
           {/* 现代化封�?Header */}
           <div className="relative w-full aspect-[3/4] bg-gray-100 dark:bg-gray-800 group shrink-0 overflow-hidden">
               {coverUrl ? (
                   <div className="w-full h-full transition-transform duration-700 group-hover:scale-105">
                       <div 
                           className="w-full h-full bg-cover bg-center"
                           style={{
                               ...getCoverStyle(topic, coverUrl),
                               willChange: 'transform, width, height',
                               WebkitBackfaceVisibility: 'hidden',
                               backfaceVisibility: 'hidden',
                               transform: 'translate3d(0, 0, 0)',
                           }}
                       />
                   </div>
               ) : (
                   <div className="w-full h-full flex flex-col items-center justify-center text-gray-300 dark:text-gray-600">
                       <Layout size={64} className="mb-4 opacity-20" />
                       <span className="text-xs uppercase tracking-[0.2em] font-medium">{t('sidebar.topics')}</span>
                   </div>
               )}
               {/* 底部渐变遮罩 */}
               <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
           </div>

           {/* 浮动内容面板 */}
           <div className="px-6 py-8 space-y-8 flex-1 relative bg-white dark:bg-gray-900 rounded-t-[2rem] -mt-8 shadow-2xl">
               {/* 标题与统计药�?*/}
               <div className="space-y-5">
                   <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white leading-tight text-center">
                       {topic.name}
                   </h2>
                   
                   <div className="flex flex-wrap gap-2.5 justify-center">
                       <div className="flex items-center gap-2 px-3.5 py-1.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-full border border-blue-100/50 dark:border-blue-800/30 text-[11px] font-bold uppercase tracking-wider">
                           <User size={14} />
                           <span>{topicPeople.length} {t('context.people')}</span>
                       </div>
                       <div className="flex items-center gap-2 px-3.5 py-1.5 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 rounded-full border border-purple-100/50 dark:border-purple-800/30 text-[11px] font-bold uppercase tracking-wider">
                           <ImageIcon size={14} />
                           <span>{topicFileCount} {t('context.files')}</span>
                       </div>
                       {topic.updatedAt && (
                           <div className="flex items-center gap-2 px-3.5 py-1.5 bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-full border border-gray-100 dark:border-gray-800 text-[11px] font-bold uppercase tracking-wider">
                               <Clock size={14} />
                               <span>{new Date(topic.updatedAt).toLocaleDateString()}</span>
                           </div>
                       )}
                   </div>
               </div>

               {/* 高端简介输入框 */}
               <div className="space-y-3">
                   <div className="flex justify-between items-center px-1">
                       <label className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em]">
                           {t('meta.description')}
                       </label>
                   </div>
                   <div className="bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-100 dark:border-gray-800/50 p-1 group/desc relative overflow-hidden transition-all focus-within:ring-2 ring-blue-500/10">
                       <textarea 
                           className="w-full bg-transparent border-none p-4 text-sm text-gray-700 dark:text-gray-300 min-h-[140px] focus:ring-0 resize-none leading-relaxed placeholder:text-gray-400/50"
                           value={topicDesc}
                           onChange={e => setTopicDesc(e.target.value)}
                           placeholder={t('meta.addDesc')}
                       />
                       {topicDesc !== (topic.description || '') && (
                           <div className="absolute bottom-3 right-3 animate-fade-in">
                               <button 
                                   onClick={handleUpdateTopicMeta}
                                   className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-lg shadow-blue-500/20 transition-all active:scale-95"
                               >
                                   <Save size={16} />
                                   {t('meta.save')}
                               </button>
                           </div>
                       )}
                   </div>
               </div>

               {/* 专题内人�?- 圆形头像网格，姓名置于下方，右上角显示子专题出现次数 */}
               {topicPeople.length > 0 && (
                   <div className="space-y-4">
                        <div className="flex justify-between items-center px-1">
                            <label className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em]">
                                {t('context.people')}
                            </label>
                            <span className="text-[10px] font-bold bg-gray-100 dark:bg-gray-800 text-gray-500 px-2 py-0.5 rounded-full">
                                {topicPeople.length}
                            </span>
                        </div>
                        <div className="grid grid-cols-3 gap-5">
                            {topicPeople.map(p => {
                                const pCover = files[p.coverFileId];
                                const subCount = peopleSubtopicCount && (peopleSubtopicCount[p.id] || 0);
                                return (
                                    <div 
                                        key={p.id} 
                                        className="group/avatar flex flex-col items-center gap-2 cursor-pointer" 
                                        title={p.name}
                                        onClick={() => onSelectPerson && onSelectPerson(p.id)}
                                    >
                                        <div className="relative w-20 h-20 rounded-full bg-gray-100 dark:bg-gray-800 border border-transparent group-hover/avatar:border-blue-500/50 transition-all shadow-sm">
                                            <div className="relative w-full h-full rounded-full overflow-hidden">
                                                <div className="w-full h-full transition-transform duration-500 group-hover/avatar:scale-110">
                                                    {pCover ? (
                                                       p.faceBox ? (
                                                           <img 
                                                               src={convertFileSrc(pCover.path)}
                                                               className="absolute max-w-none"
                                                               decoding="async"
                                                               style={{
                                                                   width: `${10000 / Math.max(p.faceBox.w, 2.0)}%`,
                                                                   height: `${10000 / Math.max(p.faceBox.h, 2.0)}%`,
                                                                   left: 0,
                                                                   top: 0,
                                                                   transformOrigin: 'top left',
                                                                   transform: `translate3d(${-p.faceBox.x}%, ${-p.faceBox.y}%, 0)`,
                                                               }}
                                                           />
                                                       ) : (
                                                           <img 
                                                               src={convertFileSrc(pCover.path)} 
                                                               alt={p.name}
                                                               className="w-full h-full object-cover" 
                                                               decoding="async"
                                                               style={{
                                                                   willChange: 'transform, width, height',
                                                                   WebkitBackfaceVisibility: 'hidden',
                                                                   backfaceVisibility: 'hidden',
                                                                   transform: 'translate3d(0, 0, 0)',
                                                               }}
                                                           />
                                                       )
                                                    ) : <User className="w-full h-full p-3 text-gray-400"/>}
                                                </div>
                                            </div>

                                            {subCount > 1 && (
                                                <div className="absolute -top-1 -right-1 bg-blue-600 text-white text-[10px] font-bold rounded-full w-6 h-6 flex items-center justify-center shadow-md border-2 border-white dark:border-gray-900 opacity-0 group-hover/avatar:opacity-100 transform scale-90 group-hover/avatar:scale-100 transition-all duration-150 pointer-events-none">
                                                    {subCount}
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-xs font-bold text-gray-600 dark:text-gray-400 truncate w-full text-center group-hover/avatar:text-blue-500 transition-colors">
                                            {p.name}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                   </div>
               )}

               {/* 现代子专题列�?- 改为3:4比例网格 */}
               {!topic.parentId && subTopics.length > 0 && (
                   <div className="space-y-4">
                        <div className="flex items-center px-1">
                            <label className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em] ml-1">
                                {t('context.subTopics')}
                            </label>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-6">
                            {subTopics.map(sub => {
                                const subCoverUrl = getCoverUrlInternal(sub);
                                return (
                                    <div 
                                        key={sub.id} 
                                        className="group/sub flex flex-col gap-2.5 cursor-pointer transition-all active:scale-95"
                                        onClick={() => onSelectTopic && onSelectTopic(sub.id)}
                                    >
                                        <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-100 dark:border-gray-800 shadow-sm transition-all group-hover/sub:shadow-md group-hover/sub:border-blue-500/30">
                                            {subCoverUrl ? (
                                                <div className="w-full h-full transition-transform duration-500 group-hover/sub:scale-110">
                                                    <div 
                                                        className="w-full h-full bg-cover bg-center" 
                                                        style={{
                                                            ...getCoverStyle(sub, subCoverUrl),
                                                            willChange: 'transform, width, height',
                                                            WebkitBackfaceVisibility: 'hidden',
                                                            backfaceVisibility: 'hidden',
                                                            transform: 'translate3d(0, 0, 0)',
                                                        }}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 bg-gray-50 dark:bg-gray-800/50">
                                                    <Folder size={24} className="opacity-20 mb-1" />
                                                    <span className="text-[9px] uppercase tracking-widest font-bold opacity-30">Topic</span>
                                                </div>
                                            )}
                                            {/* 底部渐显遮罩 */}
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover/sub:opacity-100 transition-opacity pointer-events-none" />
                                        </div>
                                        <div className="px-1 min-w-0">
                                            <div className="text-xs font-bold text-gray-800 dark:text-gray-200 truncate text-center group-hover/sub:text-blue-500 transition-colors">
                                                {sub.name}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                   </div>
               )}

               {/* 来源网址栏 */}
               <div className="space-y-3">
                   <label className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em] ml-1">
                       {t('context.sourceUrl')}
                   </label>
                   <div className="flex gap-2">
                       <div className="flex-1 group/input relative">
                           <input 
                               value={topicSource}
                               onChange={e => setTopicSource(e.target.value)}
                               className="w-full bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/50 rounded-2xl px-4 py-3 text-sm dark:text-white focus:outline-none focus:ring-2 ring-blue-500/20 focus:bg-white dark:focus:bg-gray-800 transition-all placeholder:text-gray-400/50"
                               placeholder="https://"
                           />
                           {topicSource !== (topic.sourceUrl || '') && (
                               <button 
                                   onClick={handleUpdateTopicMeta}
                                   className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-95"
                               >
                                   <Save size={14} />
                               </button>
                           )}
                       </div>
                       {topicSource && (
                           <a 
                               href={topicSource} 
                               target="_blank" 
                               rel="noreferrer" 
                               className="flex items-center justify-center w-12 h-12 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 text-blue-500 hover:text-white hover:bg-blue-500 hover:border-blue-500 rounded-2xl shadow-sm transition-all active:scale-95"
                               title={t('context.openInBrowser')}
                           >
                               <ExternalLink size={20}/>
                           </a>
                       )}
                   </div>
               </div>

               {/* 底部功能�?- 删除按钮 */}
               <div className="pt-8 pb-4 flex flex-col items-center">
                   <button 
                       onClick={() => onDeleteTopic && onDeleteTopic(topic.id)}
                       className="flex items-center gap-2 px-6 py-3 text-red-500/60 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-2xl transition-all text-sm font-bold tracking-tight opacity-70 hover:opacity-100"
                   >
                       <Trash2 size={16} />
                       {t('context.deleteTopic')}
                   </button>
                   <p className="text-xs text-center text-gray-400 mt-2">
                       {t('meta.deleteTopicHint')}
                   </p>
               </div>
           </div>

           {/* 现代化保存消息提�?*/}
           {showSavedTopic && (
              <div className="fixed bottom-8 left-[calc(100%-160px)] transform -translate-x-1/2 bg-gray-900/90 dark:bg-white/90 text-white dark:text-gray-900 text-xs font-bold px-5 py-2.5 rounded-2xl shadow-2xl backdrop-blur-md animate-toast-up flex items-center z-50">
                  <Check size={14} className="mr-2 text-green-500"/>
                  {t('context.saved')}
              </div>
           )}
        </div>
      );
  }

  // 多选专题的情况
  if (selectedTopicCount > 1 && topics && selectedTopicIds && selectedTopicIds.length > 0) {
      return (
        <div className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-y-auto custom-scrollbar relative">
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0 bg-gray-50 dark:bg-gray-900/50">
            <div className="font-bold text-lg text-gray-800 dark:text-white break-words leading-tight mb-1">
                {selectedTopicCount} {t('context.selectedTopics') || t('sidebar.topics')}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                {t('meta.multipleTopicsSelected') || 'Multiple topics selected'}
            </div>
          </div>

          <div className="p-5 space-y-6">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
              <div className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em] mb-4 flex items-center">
                  <Layout size={12} className="mr-2 opacity-70" /> {t('sidebar.topics')}
              </div>
              
              <div className="flex flex-col gap-4 overflow-y-auto">
                {selectedTopicIds.map(topicId => {
                  const topic = topics[topicId];
                  if (!topic) return null;

                  const getTopicCover = (t: Topic) => {
                       if (t.coverFileId && files[t.coverFileId]) {
                           return convertFileSrc(files[t.coverFileId].path);
                       }
                       if (t.backgroundFileId && files[t.backgroundFileId]) {
                           return convertFileSrc(files[t.backgroundFileId].path);
                       }
                       if (t.fileIds && t.fileIds.length > 0) {
                           for (const fid of t.fileIds) {
                               const f = files[fid];
                               if (f && f.type === FileType.IMAGE) {
                                   return convertFileSrc(f.path);
                               }
                           }
                       }
                       return null;
                  };
                  
                  const coverUrl = getTopicCover(topic);
                  const isMainTopic = !topic.parentId;
                  const allSubTopics = isMainTopic 
                        ? Object.values(topics).filter(sub => sub.parentId === topic.id)
                              .sort((a,b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                        : [];
                  
                  const isExpanded = expandedTopicIds.has(topicId);
                  const visibleSubtopics = isExpanded ? allSubTopics : allSubTopics.slice(0, 2);
                  
                  return (
                    <div 
                      key={topicId} 
                      className="flex items-start gap-3.5 p-3.5 bg-gray-50/50 dark:bg-gray-900/30 rounded-xl border border-gray-100 dark:border-gray-800/50 hover:bg-gray-200/70 dark:hover:bg-black/50 transition-all cursor-pointer group/item active:scale-[0.98]"
                      onClick={() => onSelectTopic && onSelectTopic(topicId)}
                    >
                      {/* Cover with 3:4 Ratio */}
                      <div className="w-[66px] h-[88px] rounded-lg border border-gray-200/60 dark:border-gray-700/60 shadow-sm overflow-hidden bg-gray-200 dark:bg-gray-800 flex-shrink-0 relative group-hover/item:border-blue-500/50 transition-all">
                        {coverUrl ? (
                            <div className="w-full h-full transition-shadow duration-200 group-hover/item:shadow-md">
                                {/* Use the same crop display scheme as Person avatar for crisp result */}
                                {topic.coverCrop ? (
                                    <div className="w-full h-full relative overflow-hidden">
                                        <img
                                            src={coverUrl}
                                            alt={topic.name}
                                            className="absolute max-w-none"
                                            decoding="async"
                                            style={{
                                                width: `${10000 / Math.max(topic.coverCrop.width, 2.0)}%`,
                                                height: `${10000 / Math.max(topic.coverCrop.height, 2.0)}%`,
                                                left: 0,
                                                top: 0,
                                                transformOrigin: 'top left',
                                                transform: `translate3d(${-topic.coverCrop.x}%, ${-topic.coverCrop.y}%, 0)`,
                                                willChange: 'transform, width, height',
                                                backfaceVisibility: 'hidden',
                                                imageRendering: 'auto'
                                            }}
                                        />
                                    </div>
                                ) : (
                                    <img 
                                        src={coverUrl}
                                        alt={topic.name}
                                        className="w-full h-full object-cover block"
                                        decoding="async"
                                        style={{ 
                                            WebkitBackfaceVisibility: 'hidden',
                                            backfaceVisibility: 'hidden',
                                            transform: 'none',
                                            imageRendering: 'auto'
                                        }} 
                                    />
                                )}
                            </div>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400 bg-gradient-to-br from-indigo-500/5 to-purple-500/5">
                              <Layout size={24} className="opacity-30"/>
                          </div>
                        )}
                      </div>
                      
                      {/* Info Area */}
                      <div className="flex-1 min-w-0 flex flex-col py-0.5 relative">
                        <div className="font-bold text-sm text-gray-900 dark:text-white truncate leading-tight mb-2 group-hover/item:text-blue-500 transition-colors flex items-center justify-between">
                            <span className="truncate flex-1 mr-3">{topic.name}</span>
                            {topic.type && (
                                <span className="ml-2 flex-shrink-0 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-[9px] font-black text-gray-400 dark:text-gray-500 rounded uppercase tracking-widest border border-gray-200/30 dark:border-gray-600/30">
                                    {topic.type}
                                </span>
                            )}
                        </div>
                        
                        {/* Stats Row */}
                        <div className="flex items-center gap-3 text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-2.5">
                             <span className="flex items-center bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded" title={`${topic.peopleIds?.length || 0} People`}>
                                <User size={10} className="mr-1 opacity-70"/> {topic.peopleIds?.length || 0}
                             </span>
                             <span className="flex items-center bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded" title={`${topic.fileIds?.length || 0} Files`}>
                                <ImageIcon size={10} className="mr-1 opacity-70"/> {topic.fileIds?.length || 0}
                             </span>
                             {isMainTopic && allSubTopics.length > 0 && (
                                 <span className="flex items-center bg-blue-50 dark:bg-blue-900/20 text-blue-500 px-1.5 py-0.5 rounded" title={`${allSubTopics.length} Subtopics`}>
                                    <FolderIcon size={10} className="mr-1 opacity-70"/> {allSubTopics.length}
                                 </span>
                             )}
                        </div>

                        {/* Subtopics List (Vertical List) */}
                        {isMainTopic && allSubTopics.length > 0 && (
                            <div className="space-y-1.5 pt-1.5 border-t border-gray-100 dark:border-gray-800/50 relative">
                                {visibleSubtopics.map(sub => (
                                    <div key={sub.id} className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center group/sub">
                                        <FolderIcon size={10} className="mr-2 opacity-50 shrink-0 text-blue-500/80 group-hover/sub:opacity-100" />
                                        <span className="truncate">{sub.name}</span>
                                    </div>
                                ))}
                                
                                {/* Fold/Expand Button */}
                                {allSubTopics.length > 2 && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setExpandedTopicIds(prev => {
                                                const next = new Set(prev);
                                                if (next.has(topicId)) next.delete(topicId);
                                                else next.add(topicId);
                                                return next;
                                            });
                                        }}
                                        className="absolute bottom-0 right-0 p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors text-blue-500/80 hover:text-blue-600"
                                        title={isExpanded ? "Collapse" : `Show all ${allSubTopics.length} subtopics`}
                                    >
                                        {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                    </button>
                                )}
                            </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            
            {/* Batch Actions */}
            {onDeleteTopic && (
                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                     <button
                        onClick={() => {
                            if (window.confirm(`${t('context.delete')} ${selectedTopicIds.length} ${t('sidebar.topics')}?`)) {
                                selectedTopicIds.forEach(id => onDeleteTopic(id));
                            }
                        }}
                        className="w-full flex items-center justify-center px-4 py-2.5 bg-red-50 hover:bg-red-100 dark:bg-red-900/10 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl transition-all text-sm font-bold group"
                     >
                         <Trash2 size={16} className="mr-2 group-hover:scale-110 transition-transform"/>
                         {t('context.delete')} ({selectedTopicIds.length})
                     </button>
                     <p className="text-[10px] text-center text-gray-400 mt-3 font-medium px-2">
                         {t('meta.deleteTopicHint') || 'Deleting topics will not delete the source files.'}
                     </p>
                </div>
            )}
          </div>
        </div>
      );
  }

  // 多个人物选择情况
  if (isMultiPerson) {
      return (
        <div className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-y-auto custom-scrollbar relative">
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0 bg-gray-50 dark:bg-gray-900/50">
            <div className="font-bold text-lg text-gray-800 dark:text-white break-words leading-tight mb-1">
                {selectedPeopleCount} {t('context.selectedPeople')}
            </div>
          </div>

          <div className="p-5 space-y-6">
            {/* Selected People List */}
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
              <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                  <User size={12} className="mr-1.5" /> {t('context.selectedPeople')}
              </div>
              <div className="flex flex-col gap-3 overflow-y-auto">
                {selectedPersonIds?.map(personId => {
                  const selectedPerson = people?.[personId];
                  if (!selectedPerson) return null;
                  
                  const coverFile = files[selectedPerson.coverFileId];
                  const coverUrl = coverFile?.path ? convertFileSrc(coverFile.path) : null;
                  
                  return (
                    <div 
                      key={personId} 
                      className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all cursor-pointer group/item active:scale-[0.98]"
                      onClick={() => onSelectPerson && onSelectPerson(personId)}
                    >
                      {/* Avatar */}
                      <div className="w-14 h-14 rounded-full border-2 border-white dark:border-gray-800 shadow-md overflow-hidden bg-gray-200 dark:bg-gray-700 flex-shrink-0 relative group-hover/item:border-blue-500/50 transition-colors">
                        {coverUrl ? (
                          selectedPerson.faceBox ? (
                            <img 
                                src={coverUrl} 
                                className="absolute max-w-none"
                                decoding="async"
                                style={{
                                    width: `${10000 / Math.max(selectedPerson.faceBox.w, 2.0)}%`,
                                    height: `${10000 / Math.max(selectedPerson.faceBox.h, 2.0)}%`,
                                    left: 0,
                                    top: 0,
                                    transformOrigin: 'top left',
                                    transform: `translate3d(${-selectedPerson.faceBox.x}%, ${-selectedPerson.faceBox.y}%, 0)`,
                                    willChange: 'transform, width, height',
                                    backfaceVisibility: 'hidden',
                                    imageRendering: 'auto'
                                }}
                            />
                          ) : (
                            <img 
                              src={coverUrl} 
                              className="w-full h-full object-cover"
                              decoding="async"
                              style={{
                                  willChange: 'transform, width, height',
                                  WebkitBackfaceVisibility: 'hidden',
                                  backfaceVisibility: 'hidden',
                                  transform: 'translate3d(0, 0, 0)',
                              }}
                            />
                          )
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400"><User size={18}/></div>
                        )}
                      </div>
                      
                      {/* Name and Stats */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-800 dark:text-white">{selectedPerson.name}</div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">{selectedPerson.count} {t('context.files')}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      );
  }
  
  // 单个人物选择情况
  if (person) {
      const coverFile = files[person.coverFileId];
      const coverUrl = coverFile?.path ? convertFileSrc(coverFile.path) : null;

      return (
        <div className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-y-auto custom-scrollbar relative">
          
          {/* Hero Header */}
          <div className="relative">
             {/* Blurred Background */}
             <div className="absolute inset-0 overflow-hidden h-40 z-0">
                {coverUrl ? (
                    <img src={coverUrl} className="w-full h-full object-cover blur-xl opacity-50 dark:opacity-30 scale-110" />
                ) : (
                    <div className="w-full h-full bg-gradient-to-r from-blue-100 to-purple-100 dark:from-blue-900/20 dark:to-purple-900/20"></div>
                )}
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/50 to-white dark:via-gray-900/50 dark:to-gray-900"></div>
             </div>

             {/* Profile Content */}
             <div className="relative z-10 pt-10 px-5 pb-2 flex flex-col items-center">
                {/* Avatar */}
                <div className="w-32 h-32 rounded-full border-4 border-white dark:border-gray-800 shadow-xl overflow-hidden bg-gray-200 dark:bg-gray-700 mb-4 relative group">
                    {coverUrl ? (
                       <div className="w-full h-full transition-transform duration-300 group-hover:scale-110">
                           {person.faceBox ? (
                              <img 
                                  src={coverUrl}
                                  className="absolute max-w-none"
                                  decoding="async"
                                  style={{
                                      width: `${10000 / Math.max(person.faceBox.w, 2.0)}%`,
                                      height: `${10000 / Math.max(person.faceBox.h, 2.0)}%`,
                                      left: 0,
                                      top: 0,
                                      transformOrigin: 'top left',
                                      transform: `translate3d(${-person.faceBox.x}%, ${-person.faceBox.y}%, 0)`,
                                      willChange: 'transform, width, height',
                                      backfaceVisibility: 'hidden'
                                  }}
                               />
                           ) : (
                               <img 
                                   src={coverUrl} 
                                   className="w-full h-full object-cover"
                                   decoding="async"
                                   style={{
                                      willChange: 'transform, width, height',
                                      WebkitBackfaceVisibility: 'hidden',
                                      backfaceVisibility: 'hidden',
                                      transform: 'translate3d(0, 0, 0)',
                                   }}
                               />
                           )}
                       </div>
                    ) : (
                       <div className="w-full h-full flex items-center justify-center text-gray-400"><User size={32}/></div>
                    )}
                </div>

                {/* Name Input (dynamic width to avoid overlapping edit icon) */}
                <div className="w-full relative group mb-4 flex justify-center">
                    {/* Hidden measurement span to calculate text width */}
                    <span ref={nameMeasureRef} className="invisible absolute -left-[9999px] text-2xl font-bold whitespace-pre" aria-hidden="true">{personName || t('context.enterNewPersonName')}</span>

                    <div className="relative" style={{ width: wrapperWidth }}>
                        <input
                          ref={nameInputRef}
                          value={personName}
                          onChange={(e) => setPersonName(e.target.value)}
                          onBlur={handleUpdatePersonMeta}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleUpdatePersonMeta();
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              setPersonName(originalPersonName);
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                          className="text-2xl font-bold text-center text-gray-800 dark:text-white bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 focus:outline-none block mx-auto py-1 transition-all"
                          placeholder={t('context.enterNewPersonName')}
                          style={{ width: nameWidth }}
                        />
                        <Edit3 size={14} onClick={() => nameInputRef.current?.focus()} className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer" />
                    </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center px-4 py-2 bg-white/80 dark:bg-gray-800/80 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm backdrop-blur-sm min-w-[90px]">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-bold tracking-wider mb-0.5">{t('context.files')}</span>
                        <span className="text-lg font-mono font-bold text-blue-600 dark:text-blue-400">{person.count}</span>
                    </div>
                    <div className="flex flex-col items-center px-4 py-2 bg-white/80 dark:bg-gray-800/80 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm backdrop-blur-sm min-w-[90px]">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-bold tracking-wider mb-0.5">{t('meta.size')}</span>
                        <span className="text-lg font-mono font-bold text-purple-600 dark:text-purple-400">{personStats ? formatSize(personStats.totalSize) : '-'}</span>
                    </div>
                </div>
             </div>
          </div>

          <div className="p-5 space-y-6 flex-1">
              {/* 高端简介输入框 */}
              <div className="space-y-3">
                  <div className="flex justify-between items-center px-1">
                      <label className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em]">
                          {t('meta.description')}
                      </label>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-100 dark:border-gray-800/50 p-1 group/desc relative overflow-hidden transition-all focus-within:ring-2 ring-blue-500/10">
                      <textarea
                          ref={personDescRef}
                          value={personDesc}
                          onChange={(e) => setPersonDesc(e.target.value)}
                          placeholder={t('meta.addDesc')}
                          className="w-full bg-transparent border-none p-4 text-sm text-gray-700 dark:text-gray-300 min-h-[140px] focus:ring-0 resize-none leading-relaxed placeholder:text-gray-400/50"
                      />
                      {personDesc !== (person.description || '') && (
                          <div className="absolute bottom-3 right-3 animate-fade-in">
                              <button
                                  onClick={handleUpdatePersonMeta}
                                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-lg shadow-blue-500/20 transition-all active:scale-95"
                              >
                                  <Save size={16} />
                                  {t('meta.save')}
                              </button>
                          </div>
                      )}
                  </div>
              </div>

              {/* Danger Zone */}
              <div className="pt-8 pb-4 flex justify-center">
                  <button 
                      onClick={() => onDeleteTopic && onDeleteTopic(person.id)}
                      className="flex items-center gap-2 px-6 py-3 text-red-500/60 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-2xl transition-all text-sm font-bold tracking-tight opacity-70 hover:opacity-100"
                  >
                      <Trash2 size={16} />
                      {t('context.deletePerson')}
                  </button>
              </div>
          </div>

          {/* 现代化保存消息提�?*/}
          {showSavedPerson && (
              <div className="fixed bottom-8 left-[calc(100%-160px)] transform -translate-x-1/2 bg-gray-900/90 dark:bg-white/90 text-white dark:text-gray-900 text-xs font-bold px-5 py-2.5 rounded-2xl shadow-2xl backdrop-blur-md animate-toast-up flex items-center z-50">
                  <Check size={14} className="mr-2 text-green-500"/>
                  {t('context.saved')}
              </div>
          )}
        </div>
      );
  }

  if (!file && !isMulti) {
      return (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4 text-center">
              <Sparkles size={48} className="mb-4 opacity-20"/>
              <p>{t('meta.selectHint')}</p>
          </div>
      );
  }

    return (
        <div ref={panelRef} className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-y-auto custom-scrollbar relative">
      <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex-shrink-0 bg-gray-50 dark:bg-gray-900/50">
        <div className="font-bold text-lg text-gray-800 dark:text-white break-words leading-tight mb-1">
            {isMulti ? `${selectedFileIds.length} ${t('meta.items')}` : file?.name}
        </div>
        {!isMulti && file && (
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
               {files[file.parentId || '']?.name || 'Root'}
            </div>
        )}
      </div>

      <div className="p-5 space-y-6">
        
        {/* Multi-Selection Composition Chart */}
        {isMulti && batchStats && (
             <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                    <PieChart size={12} className="mr-1.5" /> {t('meta.typeDistribution')}
                </div>
                <DistributionChart data={batchChartData} totalFiles={selectedFileIds.length} />
                
                {/* Total Files Summary */}
                <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-3 mt-3 border-t border-gray-100 dark:border-gray-800">
                    <span>{t('meta.totalFiles')}</span>
                    <span className="font-bold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">{selectedFileIds.length}</span>
                </div>
                {/* Total Size Summary */}
                <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-2">
                    <span>{t('meta.totalSize')}</span>
                    <span className="font-bold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">{formatSize(batchStats.totalSize)}</span>
                </div>
            </div>
        )}

        {/* Large Preview Image (Single Image Only) */}
        {!isMulti && file && file.type === FileType.IMAGE && (
            <ImagePreview file={file} resourceRoot={resourceRoot} cachePath={cachePath} />
        )}

        {/* Color Palette (8 Card Grid) */}
        {!isMulti && file && file.type === FileType.IMAGE && (
            <div>
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                    <div className="flex items-center">
                        <PaletteIcon size={12} className="mr-1.5"/> {t('meta.palette')}
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={async () => {
                                if (colors.length > 0) {
                                    // 搜索相似氛围 (全色板搜�?
                                    // 为每个颜色添加前缀 color: 用于触发UI搜索逻辑�?
                                    // 但实际上我们需要一种新的搜索模式�?
                                    // 目前 onSearch 仅用�?UI 搜索框输入�?
                                    // 更好的方式是直接通过 bridge 调用后端，然后更新搜索结果，
                                    // 但那样需要入侵性修改主 FileGrid 的状态�?
                                    // 这里我们通过特殊的搜索指�?`palette:hex1,hex2...` 来触�?FileGrid 的响�?
                                    // 或者，更简单的方法：我们在这里直接使用 onSearch('palette:c1,c2...')
                                    // 并让 App.tsx 解析这个指令�?
                                    // 假设 App.tsx 会处理这个逻辑，或者我们直接调�?bridge 并将结果视为搜索结果�?
                                    
                                    // 临时方案：使�?onSearch 传递特殊前缀�?
                                    // 用户代码需要确�?App.tsx 或搜索组件能解析这个�?
                                    // 根据用户当前需求描�?"调用 searchByPalette，并通过 onSearch 触发 UI 更新"
                                    
                                    try {
                                        const { searchByPalette } = await import('../api/tauri-bridge');
                                        
                                        // 氛围搜索：只使用�?个主色调（占比最大的颜色�?
                                        // 忽略后面占比小但鲜艳的点缀色，避免搜索结果过于宽泛
                                        const atmosphereColors = colors.slice(0, 5);
                                        
                                        // 执行搜索
                                        const results = await searchByPalette(atmosphereColors);
                                        // 这里我们需要告知主 UI 显示这些结果�?
                                        // 通常 onSearch 是更新搜索框的文字�?
                                        // 我们可以构造一个特殊的查询字符串�?
                                        // 或者这里只是为了触发一次搜索动作�?
                                        
                                        // 由于现在的架构限制，最快的方法是构造一个特殊的搜索字符�?
                                        // 并在 FileGrid / App 层面拦截它�?
                                        // 这里我们先只是调�?onSearch，传入一种特殊格式�?
                                        // 最好是 "palette:hex1,hex2,hex3"
                                        const searchQuery = `palette:${atmosphereColors.map(c => c.replace('#', '')).join(',')}`;
                                        console.log('[AtmosphereSearch] Triggering search:', searchQuery);
                                        console.log('[AtmosphereSearch] File path:', file.path);
                                        console.log('[AtmosphereSearch] Using top 5 colors (out of', colors.length, '):', atmosphereColors);
                                        onSearch(searchQuery);
                                    } catch (e) {
                                        console.error('[AtmosphereSearch] Search failed:', e);
                                    }
                                } else {
                                    console.log('[AtmosphereSearch] Conditions not met:', {
                                        hasFile: !!file,
                                        isImage: file?.type === FileType.IMAGE,
                                        hasPalette: !!file?.meta?.palette,
                                        paletteLength: file?.meta?.palette?.length || 0
                                    });
                                }
                            }}
                            className="p-1 px-2 flex items-center gap-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors text-[10px] text-gray-500 font-medium"
                            title={t('meta.searchAtmosphere')}
                        >
                           <Sparkles size={10} className="text-purple-500" />
                           {t('meta.atmosphere')}
                        </button>
                    
                        <button
                            onClick={() => {
                                if (file && file.type === FileType.IMAGE && file.path) {
                                    // Remove from cache to force re-extraction
                                    extractedCache.current.delete(file.id);
                                    
                                    // Re-extract palette using direct file path
                                    (async () => {
                                        try {
                                            const { getDominantColors } = await import('../api/tauri-bridge');
                                            
                                            // 尝试从全局缩略图路径缓存中获取缩略图路�?
                                            let thumbnailPath: string | null = null;
                                            const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
                                            if (pathCache && pathCache.get) {
                                                thumbnailPath = pathCache.get(file.path!);
                                            }
                                            
                                            // 如果缓存中没有，尝试生成缩略�?
                                            if (!thumbnailPath && resourceRoot) {
                                                try {
                                                    const { getThumbnail } = await import('../api/tauri-bridge');
                                                    const thumbUrl = await getThumbnail(file.path!, undefined, resourceRoot);
                                                    if (thumbUrl) {
                                                        thumbnailPath = pathCache.get(file.path!);
                                                    }
                                                } catch (err) {
                                                    console.log('Failed to generate thumbnail:', err);
                                                }
                                            }
                                            
                                            const colors = await getDominantColors(file.path!, 8, thumbnailPath || undefined);
                                             
                                            if (colors && colors.length > 0) {
                                                const hexColors = colors.map(c => c.hex);
                                                onUpdate(file.id, {
                                                    meta: { ...file.meta!, palette: hexColors }
                                                });
                                            } else {
                                                // If extraction fails or returns empty, clear the palette
                                                onUpdate(file.id, {
                                                    meta: { ...file.meta!, palette: [] }
                                                });
                                            }
                                        } catch (err) {
                                            console.error('Failed to extract palette:', err);
                                            // Clear palette on error
                                            onUpdate(file.id, {
                                                meta: { ...file.meta!, palette: [] }
                                            });
                                        }
                                    })();
                                }
                            }}
                            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors flex items-center justify-center"
                            title={t('meta.regeneratePalette')}
                        >
                            <RefreshCw size={12} className="text-gray-500 dark:text-gray-400" />
                        </button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 justify-center">
                    {colors.length > 0 ? (
                        colors.slice(0, 8).map((color, i) => (
                            <div
                                key={i}
                                className="w-6 h-6 rounded-full cursor-pointer hover:scale-110 transition-transform shadow-sm ring-1 ring-black/10 dark:ring-white/10"
                                style={{ backgroundColor: color }}
                                onClick={() => onSearch(`color:${color.replace('#', '')}`)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    // 计算菜单宽度（根据菜单项内容估算�?
                                    const menuWidth = 180;
                                    // 对于最右边的色块，将菜单显示在鼠标左边
                                    const isRightmost = i === 7; // 最后一个色�?
                                    const x = isRightmost ? e.clientX - menuWidth : e.clientX;
                                    setPaletteMenu({ visible: true, x, y: e.clientY, color });
                                }}
                                title={color}
                            />
                        ))
                    ) : (
                        Array.from({ length: 8 }).map((_, i) => (
                            <div
                                key={i}
                                className="w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse ring-1 ring-black/5 dark:ring-white/5"
                            />
                        ))
                    )}
                </div>
            </div>
        )}
        
        {/* Folder Thumbnail */}
        {!isMulti && file && file.type === FileType.FOLDER && (
            <div className="flex flex-col">
                <div className="w-full rounded-lg overflow-hidden bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-800 flex justify-center items-center py-8 mb-4 shadow-sm relative group">
                    <div className="w-[200px] h-[200px]">
                        <Folder3DIcon 
                            previewSrcs={folderPreviewImages} 
                            count={file.children?.length} 
                            category={file.category} 
                            className="w-full h-full text-blue-500 dark:text-blue-400"
                        />
                    </div>
                </div>
                
                {/* File Type Distribution */}
                {folderDetails && (
                    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-800 p-4 shadow-sm">
                        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                            <PieChart size={12} className="mr-1.5" /> {t('meta.fileDistribution')}
                        </div>
                        <DistributionChart data={chartData} totalFiles={folderDetails.totalFiles + folderDetails.subFolderCount} />
                        
                        {/* Total Files Summary */}
                        <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-3 mt-3 border-t border-gray-100 dark:border-gray-800">
                            <span>{t('meta.totalFiles')}</span>
                            <span className="font-bold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">{folderDetails.totalFiles}</span>
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* AI Analysis Section */}
        {(isMulti || (!isMulti && file && file.aiData)) && (
            // Check if any selected file has AI data
            selectedFileIds.some(id => files[id]?.aiData) && (
                <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-900/10 dark:to-blue-900/10 rounded-xl p-4 border border-purple-100 dark:border-purple-900/30">
                    <div className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider mb-3 flex items-center justify-between">
                        <div className="flex items-center"><Sparkles size={12} className="mr-1.5"/> {t('meta.aiSection')}</div>
                        {(
                            (!isMulti && file && file.aiData) ||
                            (isMulti && selectedFileIds.some(id => files[id]?.aiData))
                        ) && (
                            isMulti ? (
                                <button
                                    onClick={() => {
                                        selectedFileIds.forEach(id => {
                                            if (files[id]?.aiData) {
                                                onUpdate(id, { aiData: undefined });
                                            }
                                        });
                                    }}
                                    className="p-2 rounded-md hover:bg-red-600/10 dark:hover:bg-red-500/20 text-red-600 dark:text-red-300 transition"
                                    title={t('meta.clearAllAiData')}
                                    aria-label={t('meta.clearAllAiData')}
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : (
                                <button
                                    onClick={() => onUpdate(file.id, { aiData: undefined })}
                                    className="p-2 rounded-md hover:bg-red-600/10 dark:hover:bg-red-500/20 text-red-600 dark:text-red-300 transition"
                                    title={t('meta.clearAiData')}
                                    aria-label={t('meta.clearAiData')}
                                >
                                    <Trash2 size={16} />
                                </button>
                            )
                        )}
                    </div>
                    
                    {isMulti ? (
                        // Multi-selection AI analysis summary
                        <div className="space-y-3">
                            {/* Count of files with AI data */}
                            <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                <div className="text-gray-400 text-xs mb-1">{t('meta.aiFilesCount')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">
                                    {selectedFileIds.filter(id => files[id]?.aiData).length} / {selectedFileIds.length}
                                </div>
                            </div>
                            
                            {/* Scene Categories */}
                            {(() => {
                                // Get all unique scene categories from selected files
                                const sceneCategories = new Map<string, number>();
                                selectedFileIds.forEach(id => {
                                    const aiData = files[id]?.aiData;
                                    if (aiData?.sceneCategory) {
                                        const category = aiData.sceneCategory;
                                        sceneCategories.set(category, (sceneCategories.get(category) || 0) + 1);
                                    }
                                });
                                
                                if (sceneCategories.size > 0) {
                                    return (
                                        <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                            <div className="text-gray-400 text-xs mb-2 flex items-center">
                                                <span className="mr-1.5">{t('meta.aiScene')}</span>
                                                <span className="text-gray-500">({sceneCategories.size} {t('context.items')})</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Array.from(sceneCategories.entries())
                                                    .sort(([, a], [, b]) => b - a)
                                                    .slice(0, 8)
                                                    .map(([category, count]) => (
                                                        <span key={category} className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-[10px] rounded border border-gray-200 dark:border-gray-700 flex items-center">
                                                            <span className="mr-1 font-medium">{category}</span>
                                                            <span className="text-gray-500">({count})</span>
                                                        </span>
                                                    ))}
                                            </div>
                                        </div>
                                    );
                                }
                                return null;
                            })()}
                            
                            {/* Detected Faces */}
                            {(() => {
                                // Get all unique faces from selected files
                                const faceNames = new Set<string>();
                                selectedFileIds.forEach(id => {
                                    const aiData = files[id]?.aiData;
                                    if (aiData?.faces) {
                                        aiData.faces.forEach(face => {
                                            if (face.name) {
                                                faceNames.add(face.name);
                                            }
                                        });
                                    }
                                });
                                
                                if (faceNames.size > 0) {
                                    return (
                                        <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                            <div className="text-gray-400 text-xs mb-2 flex items-center">
                                                <span className="mr-1.5">{t('meta.aiFaces')}</span>
                                                <span className="text-gray-500">({faceNames.size} {t('context.items')})</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Array.from(faceNames)
                                                    .sort()
                                                    .slice(0, 8)
                                                    .map(name => {
                                                        const personEntry = people ? Object.values(people).find(p => p.name === name) : null;
                                                        return (
                                                            <span 
                                                                key={name} 
                                                                className={`px-2 py-1 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 text-[10px] rounded border border-purple-100 dark:border-purple-900/30 flex items-center transition-all ${personEntry ? 'cursor-pointer hover:bg-purple-100 dark:hover:bg-purple-800/30 active:scale-95' : ''}`}
                                                                onClick={() => personEntry && onSelectPerson && onSelectPerson(personEntry.id)}
                                                            >
                                                                {name}
                                                            </span>
                                                        );
                                                    })}
                                            </div>
                                        </div>
                                    );
                                }
                                return null;
                            })()}
                            
                            {/* Detected Objects */}
                            {(() => {
                                // Get all unique objects from selected files
                                const objects = new Map<string, number>();
                                selectedFileIds.forEach(id => {
                                    const aiData = files[id]?.aiData;
                                    if (aiData?.objects) {
                                        aiData.objects.forEach(obj => {
                                            objects.set(obj, (objects.get(obj) || 0) + 1);
                                        });
                                    }
                                });
                                
                                if (objects.size > 0) {
                                    return (
                                        <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                            <div className="text-gray-400 text-xs mb-2 flex items-center">
                                                <span className="mr-1.5">{t('meta.aiObjects')}</span>
                                                <span className="text-gray-500">({objects.size} {t('context.items')})</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Array.from(objects.entries())
                                                    .sort(([, a], [, b]) => b - a)
                                                    .slice(0, 12)
                                                    .map(([obj, count]) => (
                                                        <span key={obj} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[10px] rounded border border-gray-200 dark:border-gray-800 flex items-center">
                                                            <span className="mr-1">{obj}</span>
                                                            <span className="text-gray-500 text-[9px]">({count})</span>
                                                        </span>
                                                    ))}
                                            </div>
                                        </div>
                                    );
                                }
                                return null;
                            })()}
                            
                            
                        </div>
                    ) : (
                        // Single file AI analysis details
                        file && file.aiData && (
                            <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                        <div className="text-gray-400 mb-1">{t('meta.aiScene')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{file.aiData.sceneCategory}</div>
                                    </div>
                                    <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                        <div className="text-gray-400 mb-1">{t('meta.aiConfidence')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{Math.round(file.aiData.confidence * 100)}%</div>
                                    </div>
                                </div>

                                {file.aiData.faces.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-gray-400 font-bold mb-1.5 flex items-center"><Smile size={10} className="mr-1"/> {t('meta.aiFaces')}</div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {file.aiData.faces.map(face => (
                                                <div 
                                                    key={face.id} 
                                                    className={`flex items-center bg-white dark:bg-gray-800 px-2 py-1 rounded-full border border-purple-100 dark:border-purple-900/30 text-xs shadow-sm transition-all ${face.personId ? 'cursor-pointer hover:bg-purple-50 dark:hover:bg-purple-900/20 active:scale-95' : ''}`}
                                                    onClick={() => face.personId && onSelectPerson && onSelectPerson(face.personId)}
                                                >
                                                    <User size={10} className="mr-1 text-purple-500"/>
                                                    <span className="text-gray-700 dark:text-gray-300">{face.name}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {file.aiData.objects.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-gray-400 font-bold mb-1.5 flex items-center"><Scan size={10} className="mr-1"/> {t('meta.aiObjects')}</div>
                                        <div className="flex flex-wrap gap-1">
                                            {file.aiData.objects.map(obj => (
                                                <span key={obj} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[10px] rounded border border-gray-200 dark:border-gray-800">
                                                    {obj}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {file.aiData.extractedText && (
                                    <div className="mt-2 bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                        <div className="text-[10px] text-gray-400 font-bold mb-1 flex items-center justify-between">
                                            <div className="flex items-center"><FileText size={10} className="mr-1"/> {t('meta.aiExtractedText')}</div>
                                            <button
                                                onClick={() => copyToClipboard(file.aiData?.extractedText || '')}
                                                className="ml-2 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
                                                title={t('context.copy')}
                                                aria-label={t('context.copy')}
                                            >
                                                <Copy size={12}/>
                                            </button>
                                        </div>
                                        <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{file.aiData.extractedText}</p>
                                    </div>
                                )}

                                {file.aiData.translatedText && (
                                    <div className="mt-2 bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-800">
                                        <div className="text-[10px] text-gray-400 font-bold mb-1 flex items-center justify-between">
                                            <div className="flex items-center"><Languages size={10} className="mr-1"/> {t('meta.aiTranslatedText')}</div>
                                            <button
                                                onClick={() => copyToClipboard(file.aiData?.translatedText || '')}
                                                className="ml-2 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
                                                title={t('context.copy')}
                                                aria-label={t('context.copy')}
                                            >
                                                <Copy size={12}/>
                                            </button>
                                        </div>
                                        <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{file.aiData.translatedText}</p>
                                    </div>
                                )}
                                

                            </div>
                        )
                    )}
                </div>
            )
        )}

        {/* Open Folder Button */}
        {!isMulti && file && (
            <button 
                onClick={() => {
                    if (file.parentId && !(activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId)) {
                        onNavigateToFolder(file.parentId, { targetId: file.id });
                    }
                }}
                className={`w-full flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-colors border border-gray-200 dark:border-gray-800 group ${activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-50' : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200'}`}
                disabled={activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId}
            >
                <FolderOpen size={16} className={`mr-2 ${activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId ? 'text-gray-400 dark:text-gray-500' : 'text-blue-500 group-hover:text-blue-600 dark:group-hover:text-blue-400'}`}/>
                {t('context.openFolder')}
            </button>
        )}

        {/* Detailed Info Grid */}
        {!isMulti && file && (
            <div>
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                    {t('meta.details')}
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                    {file.type === FileType.IMAGE && file.meta && (
                        <>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><FileText size={10} className="mr-1"/> {t('meta.format')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{file.meta.format.toUpperCase()}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><HardDrive size={10} className="mr-1"/> {t('meta.size')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{formatSize(file.meta.sizeKb)}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><ImageIcon size={10} className="mr-1"/> {t('meta.dimensions')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{file.meta.width} x {file.meta.height}</div>
                            </div>
                        </>
                    )}
                    {file.type === FileType.FOLDER && folderStats && (
                        <>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><FolderIcon size={10} className="mr-1"/> {t('context.files')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{folderStats.fileCount}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><HardDrive size={10} className="mr-1"/> {t('meta.totalSize')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{formatSize(folderStats.size)}</div>
                            </div>
                        </>
                    )}
                    <div>
                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><Calendar size={10} className="mr-1"/> {t('meta.created')}</div>
                        <div className="text-xs text-gray-800 dark:text-gray-200 font-mono">{file.createdAt ? new Date(file.createdAt).toLocaleDateString() : '-'}</div>
                    </div>
                    <div>
                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><Clock size={10} className="mr-1"/> {t('meta.updated')}</div>
                        <div className="text-xs text-gray-800 dark:text-gray-200 font-mono">{file.updatedAt ? new Date(file.updatedAt).toLocaleString() : '-'}</div>
                    </div>
                </div>
            </div>
        )}

        {/* Folder Category Selector */}
        {((file && file.type === FileType.FOLDER) || (isMulti && selectedFileIds.every(id => files[id]?.type === FileType.FOLDER))) && (
            <CategorySelector 
                current={file ? file.category : (selectedFileIds.every(id => files[id]?.category === 'book') ? 'book' : 'general')}
                onChange={handleCategoryChange}
                t={t}
            />
        )}

        {/* Topic Display Button */}
        {!isMulti && file && fileTopic && (
            <div>
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center">
                    <Layout size={12} className="mr-1.5 text-indigo-500"/> {t('sidebar.topics')}
                </div>
                <button
                    onClick={() => onSelectTopic && onSelectTopic(fileTopic.sub?.id || fileTopic.main.id)}
                    className="flex w-full items-center justify-center px-4 py-2 bg-indigo-50/50 dark:bg-indigo-900/10 text-indigo-600 dark:text-indigo-400 rounded-full border border-indigo-100 dark:border-indigo-800/20 hover:bg-indigo-100 dark:hover:bg-indigo-800/20 transition-all group"
                >
                    <span className="text-xs font-bold tracking-tight truncate">
                        {fileTopic.main.name}
                        {fileTopic.sub && (
                            <>
                                <span className="mx-2 opacity-30">|</span>
                                {fileTopic.sub.name}
                            </>
                        )}
                    </span>
                </button>
            </div>
        )}

        {/* Tags Section */}
        {!isMulti && file && file.type !== FileType.FOLDER && (
            <div>
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center">
                    <Tag size={12} className="mr-1.5"/> {t('meta.tags')}
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                    {file?.tags?.map((tag) => (
                        <span key={tag} className="inline-flex items-center px-2 py-1 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 text-xs border border-blue-100 dark:border-blue-900/30 group">
                            <span className="cursor-pointer" onClick={() => onNavigateToTag(tag)}>{tag}</span>
                            <button onClick={() => handleRemoveTag(tag)} className="ml-1 text-blue-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                <X size={10} />
                            </button>
                        </span>
                    ))}
                    {file?.tags.length === 0 && (
                        <span className="text-xs text-gray-400 italic py-1">{t('context.noTags')}</span>
                    )}
                </div>
                <div className="relative">
                    <input
                        type="text"
                        value={newTagInput}
                        onChange={(e) => setNewTagInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddTag(newTagInput)}
                        placeholder={t('meta.addTagPlaceholder')}
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-md py-2 px-3 text-sm text-gray-700 dark:text-gray-300 focus:ring-2 ring-blue-500/50 placeholder-gray-400 focus:border-blue-500 outline-none transition-all"
                    />
                    {newTagInput && (
                        <button 
                            onClick={() => handleAddTag(newTagInput)}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 bg-blue-500 text-white rounded hover:bg-blue-600 dark:hover:bg-blue-700"
                        >
                            <Check size={12}/>
                        </button>
                    )}
                    
                    {/* Tag Autocomplete Suggestions */}
                    {newTagInput && systemTags.filter(t => t.toLowerCase().includes(newTagInput.toLowerCase()) && !file?.tags?.includes(t)).length > 0 && (
                         <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded shadow-lg z-10 max-h-32 overflow-y-auto">
                             {systemTags.filter(t => t.toLowerCase().includes(newTagInput.toLowerCase()) && !file?.tags?.includes(t)).map(tag => (
                                 <div 
                                    key={tag} 
                                    className="px-3 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer text-xs flex items-center text-gray-700 dark:text-gray-200"
                                    onClick={() => handleAddTag(tag)}
                                 >
                                     <Tag size={10} className="mr-2 opacity-50"/> {tag}
                                 </div>
                             ))}
                         </div>
                    )}
                </div>
            </div>
        )}

        {/* Description Section */}
        {!isMulti && (
            <div>
                <div className="flex items-center justify-between mb-2">
                     <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center">
                        <FileText size={12} className="mr-1.5"/> {t('meta.description')}
                     </div>
                     {showSavedDesc && <span className="text-green-500 flex items-center text-[10px] animate-fade-in"><Check size={10} className="mr-1"/>{t('meta.saved')}</span>}
                </div>
                {isMulti && isDescMixed ? (
                    <div className="text-xs text-orange-500 italic mb-2 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded">{t('meta.mixedValues')}</div>
                ) : null}
                <div className="relative">
                    <textarea
                        ref={textareaRef}
                        value={isMulti ? batchDesc : desc}
                        onChange={(e) => isMulti ? setBatchDesc(e.target.value) : setDesc(e.target.value)}
                        onBlur={handleUpdateMeta}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                                e.preventDefault();
                                handleUpdateMeta();
                            }
                        }}
                        placeholder={t('meta.addDesc')}
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300 resize-none focus:ring-2 ring-blue-500/50 min-h-[80px] leading-relaxed outline-none transition-all focus:border-blue-500"
                    />
                </div>
                <div className="flex justify-between items-center mt-2 text-[10px] text-gray-400">
                    <span>{t('meta.descSaveHint')}</span>
                    <button 
                        onClick={handleUpdateMeta}
                        className="flex items-center px-3 py-1.5 bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-400 text-white rounded-md font-medium transition-colors"
                    >
                        <Save size={12} className="mr-1.5"/> {t('meta.save')}
                    </button>
                </div>
            </div>
        )}

        {/* Source URL Section */}
        <div>
            <div className="flex items-center justify-between mb-2">
                 <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center">
                    <Globe size={12} className="mr-1.5"/> {t('meta.sourceUrl')}
                 </div>
                 {showSavedSource && <span className="text-green-500 flex items-center text-[10px] animate-fade-in"><Check size={10} className="mr-1"/>{t('meta.saved')}</span>}
            </div>
            {isMulti && isSourceMixed ? (
                <div className="text-xs text-orange-500 italic mb-2 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded">{t('meta.mixedValues')}</div>
            ) : null}
            <div className="flex items-center bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-800 focus-within:ring-2 focus-within:ring-blue-500/50 transition-all focus-within:border-blue-500">
                <input
                    type="text"
                    value={isMulti ? batchSource : source}
                    onChange={(e) => isMulti ? setBatchSource(e.target.value) : setSource(e.target.value)}
                    onBlur={handleUpdateMeta}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            handleUpdateMeta();
                        }
                    }}
                    placeholder="https://..."
                    className="flex-1 bg-transparent border-none py-2 px-3 text-sm text-blue-600 dark:text-blue-400 placeholder-gray-400 focus:outline-none"
                />
                {(isMulti ? batchSource : source) && (
                    <button 
                      onClick={() => window.open(isMulti ? batchSource : source, '_blank')}
                      className="p-2 text-gray-400 hover:text-blue-500"
                      title={t('meta.openSource')}
                    >
                        <ExternalLink size={14} />
                    </button>
                )}
            </div>
            {isMulti && (
                <div className="mt-3 space-y-2 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-gray-700 pr-1">
                    {selectedFileIds.map(id => {
                        const f = files[id];
                        if (!f || !f.sourceUrl) return null;
                        return (
                            <div key={id} className="flex items-center text-xs group bg-gray-50 dark:bg-gray-800/50 p-1.5 rounded border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-colors">
                                <div className="text-gray-500 dark:text-gray-400 w-20 truncate mr-2 font-medium shrink-0" title={f.name}>{f.name}</div>
                                <button 
                                    onClick={() => f.sourceUrl && window.open(f.sourceUrl, '_blank')}
                                    className="text-blue-500 dark:text-blue-400 truncate flex-1 text-left p-0 bg-transparent border-none hover:underline"
                                    title={f.sourceUrl}
                                >
                                    {f.sourceUrl}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
      </div>

      {/* Palette Context Menu */}
      {paletteMenu.visible && paletteMenu.color && createPortal(
          <div 
             className="fixed bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 z-[70] animate-zoom-in"
             style={{ 
               top: 'auto', 
               left: 'auto',
               position: 'fixed',
               zIndex: 70
             }}
             ref={(el) => {
               if (el) {
                 // 动态计算菜单位置，确保完全显示在屏幕内
                 const rect = el.getBoundingClientRect();
                 const menuWidth = rect.width;
                 const menuHeight = rect.height;
                 const screenWidth = window.innerWidth;
                 const screenHeight = window.innerHeight;
                 
                 // 计算X位置，确保菜单不超出左右边界
                 let x = paletteMenu.x;
                 if (x + menuWidth > screenWidth) {
                   x = screenWidth - menuWidth;
                 }
                 if (x < 0) {
                   x = 0;
                 }
                 
                 // 计算Y位置，确保菜单不超出上下边界
                 let y = paletteMenu.y;
                 if (y + menuHeight > screenHeight) {
                   y = screenHeight - menuHeight;
                 }
                 if (y < 0) {
                   y = 0;
                 }
                 
                 // 设置最终位�?
                 el.style.left = `${x}px`;
                 el.style.top = `${y}px`;
               }
             }}
          >
              <div 
                 className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center"
                 onClick={() => {
                     copyToClipboard(paletteMenu.color!);
                     setPaletteMenu({ ...paletteMenu, visible: false });
                 }}
              >
                  <Copy size={14} className="mr-2 opacity-70"/> {t('context.copyColor')}
              </div>
              <div 
                 className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center"
                 onClick={() => {
                     onSearch(`color:${paletteMenu.color!.replace('#', '')}`);
                     setPaletteMenu({ ...paletteMenu, visible: false });
                 }}
              >
                  <Search size={14} className="mr-2 opacity-70"/> {t('context.searchSimilarColor')}
              </div>
          </div>,
          document.body
      )}

      {/* Toast (rendered to body so it's fixed to panel bottom and doesn't scroll) */}
      {toast.visible && typeof document !== 'undefined' && createPortal(
          <div
              ref={toastRef}
              style={{
                  position: 'fixed',
                  left: toastPos && typeof toastPos.left === 'number' ? `${toastPos.left}px` : '50%',
                  bottom: toastPos && typeof toastPos.bottom === 'number' ? `${toastPos.bottom}px` : '16px',
              }}
              className="bg-black/80 text-white text-xs px-3 py-1.5 rounded-full shadow-lg z-50 pointer-events-none animate-toast-up"
          >
              {toast.msg}
          </div>,
          document.body
      )}

      {/* Backdrop for palette menu */}
      {paletteMenu.visible && (
          <div className="fixed inset-0 z-[69]" onClick={() => setPaletteMenu({...paletteMenu, visible: false})}></div>
      )}
    </div>
  );
};
