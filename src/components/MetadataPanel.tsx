import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { useAutoScrollbar } from '../hooks/useAutoScrollbar';

import { createPortal } from 'react-dom';
import { FileNode, FileType, Person, TabState, Topic, AppSettings, AppState } from '../types';
import { formatSize, getFolderStats, getFolderPreviewImages } from '../utils/mockFileSystem';
import { HardDrive, FileText, FolderOpen, Copy, Folder as FolderIcon, Calendar, Clock, Edit3, Check, Save, Search, ChevronDown, ChevronUp, Sparkles, User, ExternalLink, Image as ImageIcon, Trash2, Layout } from 'lucide-react';
import { useAIRename } from '../hooks/useAIRename';
import ImagePreview from './metadata/ImagePreview';
import PersonAvatar from './metadata/PersonAvatar';
import TopicCoverImage from './metadata/TopicCoverImage';
import CategorySelector from './metadata/CategorySelector';
import DistributionChart from './metadata/DistributionChart';
import FileInfoSection from './metadata/FileInfoSection';
import BatchStatsSection from './metadata/BatchStatsSection';
import PaletteSection from './metadata/PaletteSection';
import FolderInfoSection from './metadata/FolderInfoSection';
import AIAnalysisSection from './metadata/AIAnalysisSection';
import EditSection from './metadata/EditSection';
import { findImagesDeeply } from '../utils/fileTree';
import { getGlobalCache } from '../utils/thumbnailCache';
import { cropToBackgroundStyle, cropToImgStyle } from '../utils/cropStyle';


// 导入 ImageViewer 的高分辨率缓存和调色板缓存
import { getPaletteCacheSync, preloadPaletteToCache, PALETTE_CACHE_UPDATE_EVENT } from './ImageViewer';
import { dbFindTopicsContainingFile } from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';

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
    filesVersion?: number;
    settings?: AppSettings;
    aiConnectionStatus?: AppState['aiConnectionStatus'];
}





export const MetadataPanel: React.FC<MetadataProps> = ({ selectedFileIds, files, people, topics, selectedPersonIds, selectedTopicIds, onUpdate, onUpdatePerson, onUpdateTopic, onDeleteTopic, onSelectTopic, onSelectPerson, onNavigateToFolder, onNavigateToTag, onSearch, t, activeTab, resourceRoot, cachePath, filesVersion, settings, aiConnectionStatus }) => {
    const isMulti = selectedFileIds.length > 1;
    const file = !isMulti && selectedFileIds.length === 1 ? files[selectedFileIds[0]] : null;

    // AI 重命名功能
    const { isGenerating, previewName, generateName, applyRename, cancelRename } = useAIRename({
        settings: settings || {} as AppSettings,
        people: people || {},
        onUpdate,
        showToast: (msg) => setToast({ msg, visible: true }),
        t,
    });

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
    const [toast, setToast] = useState<{ msg: string, visible: boolean }>({ msg: '', visible: false });
    const [paletteMenu, setPaletteMenu] = useState<{ visible: boolean, x: number, y: number, color: string | null }>({ visible: false, x: 0, y: 0, color: null });
    const panelRef = useRef<HTMLDivElement | null>(null);
    // 详情面板滚动条：滚动中显示、停止滚动后淡出，悬停滚动条区域时显示并放大（样式见 index.css）
    useAutoScrollbar(panelRef);
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
    const currentExtractFileRef = useRef<string | null>(null);

    const systemTags = useMemo(() => {
        const tags = new Set<string>();
        Object.values(files || {}).forEach((f: FileNode) => f.tags.forEach(tag => tags.add(tag)));
        return Array.from(tags).sort();
    }, [filesVersion]);

    // Find which topic the selected file belongs to
    // Phase 0：列表态 topic.fileIds 为空，改用 dbFindTopicsContainingFile 反查（走索引）
    const [fileTopic, setFileTopic] = useState<{ main: Topic; sub: Topic | null } | null>(null);
    useEffect(() => {
        if (!file || !topics) { setFileTopic(null); return; }
        let cancelled = false;
        (async () => {
            // 优先用内存中已加载的 fileIds（详情态/增删后）快速判断
            const topicList = Object.values(topics || {});
            const inMemory = topicList.find(t => t.fileIds?.includes(file.id) && t.parentId)
                || topicList.find(t => t.fileIds?.includes(file.id));
            if (inMemory) {
                if (!cancelled) {
                    if (inMemory.parentId && topics[inMemory.parentId]) {
                        setFileTopic({ main: topics[inMemory.parentId], sub: inMemory });
                    } else {
                        setFileTopic({ main: inMemory, sub: null });
                    }
                }
                return;
            }
            // 内存无（列表态），走 DB 反查
            if (!isTauriEnvironment()) { setFileTopic(null); return; }
            try {
                const topicIds = await dbFindTopicsContainingFile(file.id);
                if (cancelled || topicIds.length === 0) { setFileTopic(null); return; }
                // 优先子专题（有 parentId）
                const targetId = topicIds.find(tid => topics[tid]?.parentId) || topicIds[0];
                const targetTopic = topics[targetId];
                if (!targetTopic || cancelled) { setFileTopic(null); return; }
                if (targetTopic.parentId && topics[targetTopic.parentId]) {
                    setFileTopic({ main: topics[targetTopic.parentId], sub: targetTopic });
                } else {
                    setFileTopic({ main: targetTopic, sub: null });
                }
            } catch (e) {
                console.error('Failed to find topics containing file:', e);
                if (!cancelled) setFileTopic(null);
            }
        })();
        return () => { cancelled = true; };
    }, [file?.id, topics]);

    useEffect(() => {
        if (file) {
            setName(file.name);
            setDesc(file.description || '');
            setSource(file.sourceUrl || '');

            // 当文件选中时，如果元数据缺失（如尺寸为 0），尝试重新扫描单个文件以获取最新信息
            if (!isMulti && file.type === FileType.IMAGE && file.path) {
                const needsMeta = !file.meta || file.meta.width === 0 || file.meta.height === 0;
                if (needsMeta) {
                    (async () => {
                        try {
                            const { scanFile } = await import('../api/tauri-bridge');
                            const updatedNode = await scanFile(file.path!);
                            if (updatedNode && updatedNode.meta && updatedNode.meta.width > 0) {
                                onUpdate(file.id, { meta: updatedNode.meta });
                            }
                        } catch (err) {
                            console.error('Failed to auto-refresh file metadata:', err);
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
        setShowSavedPerson(false);
        setPaletteMenu({ visible: false, x: 0, y: 0, color: null });
    }, [file?.id, file?.description, file?.aiData, selectedFileIds.join(','), isMulti, person?.id, topic?.id, topics]);

    // 切换文件/选择时重置"已保存"提示（不随 description/sourceUrl 变化重置，避免保存后提示立即消失）
    useEffect(() => {
        setShowSavedDesc(false);
        setShowSavedSource(false);
    }, [file?.id, selectedFileIds.join(',')]);

    useEffect(() => {
        if (!file || isMulti || file.type !== FileType.IMAGE || !file.path) return;
        // 用户关闭了"浏览时自动提取主色调"设置
        if (settings && !settings.autoExtractPalette) return;
        // LAN 图片存在于远程服务器，本地无法提取主色调，跳过自动提取。
        if (file.path.startsWith('lan://')) return;

        const currentPalette = file.meta?.palette;
        let shouldExtract = false;

        if (!currentPalette || currentPalette.length === 0) {
            shouldExtract = true;
        } else if (currentPalette.every(c => c === '#000000')) {
            shouldExtract = true;
        } else if (currentPalette.length >= 2) {
            const hexToRgb = (hex: string) => {
                const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 0, g: 0, b: 0 };
            };
            const rgbs = currentPalette.map(hexToRgb);
            let maxDist = 0;
            let minDist = Infinity;
            for (let i = 0; i < rgbs.length; i++) {
                for (let j = i + 1; j < rgbs.length; j++) {
                    const d = Math.sqrt((rgbs[i].r - rgbs[j].r) ** 2 + (rgbs[i].g - rgbs[j].g) ** 2 + (rgbs[i].b - rgbs[j].b) ** 2);
                    if (d > maxDist) maxDist = d;
                    if (d < minDist) minDist = d;
                }
            }
            if (maxDist < 20 || minDist < 10) shouldExtract = true;
        }

        if (!shouldExtract || extractedCache.current.has(file.id)) return;

        const fileId = file.id;
        const filePath = file.path;
        const fileMeta = file.meta;
        extractedCache.current.add(fileId);
        currentExtractFileRef.current = fileId;
        setLoadingPalette(true);

        (async () => {
            try {
                const { getDominantColors } = await import('../api/tauri-bridge');

                let thumbnailPath: string | null = null;
                const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
                if (pathCache && pathCache.get) {
                    thumbnailPath = pathCache.get(filePath);
                }

                if (!thumbnailPath && resourceRoot) {
                    try {
                        const { getThumbnail } = await import('../api/tauri-bridge');
                        const thumbUrl = await getThumbnail(filePath, undefined, resourceRoot);
                        if (thumbUrl) {
                            thumbnailPath = pathCache.get(filePath);
                        }
                    } catch (_err) {}
                }

                const colors = await getDominantColors(filePath, 8, thumbnailPath || undefined);
                if (colors && colors.length > 0) {
                    const hexColors = colors.map(c => c.hex);
                    const currentHexColors = currentPalette || [];
                    const colorsChanged = JSON.stringify(hexColors) !== JSON.stringify(currentHexColors);

                    if (colorsChanged) {
                        onUpdate(fileId, {
                            meta: { ...fileMeta!, palette: hexColors }
                        });
                    }
                }
            } catch (err) {
                console.error('[Auto-extract] Failed to extract palette:', err);
            } finally {
                if (currentExtractFileRef.current === fileId) {
                    setLoadingPalette(false);
                }
            }
        })();
    }, [file?.id, file?.meta?.palette, settings?.autoExtractPalette]);

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

    // 使用状态来存储颜色，以便能响应缓存更新
    const [colors, setColors] = useState<string[]>([]);
    const [loadingPalette, setLoadingPalette] = useState(false);

    // 当文件变化时，检查缓存和文件数据来获取调色板
    // useLayoutEffect 确保在浏览器绘制前同步更新，避免首帧闪烁
    useLayoutEffect(() => {
        if (!file) {
            setColors([]);
            return;
        }

        if (file.meta?.palette && file.meta.palette.length > 0 && !file.meta.palette.every(c => c === '#000000')) {
            setColors(file.meta.palette);
            return;
        }

        if (file.path) {
            const cachedPalette = getPaletteCacheSync(file.path);
            if (cachedPalette && cachedPalette.length > 0) {
                setColors(cachedPalette);
                return;
            }
        }

        if (file.aiData?.dominantColors && file.aiData.dominantColors.length > 0) {
            setColors(file.aiData.dominantColors);
            return;
        }

        // 远程图片（桌面端服务/安卓设备）：browse 时不返回 palette，按需从服务端获取。
        // preloadPaletteToCache 会异步请求 /api/palette，结果通过
        // PALETTE_CACHE_UPDATE_EVENT 事件回传，由上方的 useEffect 监听更新。
        if (file.path && (file.source === 'lan' || file.source === 'android' || file.path.startsWith('android://'))) {
            preloadPaletteToCache(file.path);
        }

        setColors([]);
    }, [file?.id, file?.path, file?.meta?.palette, file?.aiData?.dominantColors, file?.source]);

    // 监听调色板缓存更新事件
    useEffect(() => {
        if (!file?.path) return;

        const handlePaletteCacheUpdate = (event: Event) => {
            const customEvent = event as CustomEvent<{ path: string; palette: string[] }>;
            if (customEvent.detail.path === file.path && customEvent.detail.palette.length > 0) {
                setColors(customEvent.detail.palette);
            }
        };

        window.addEventListener(PALETTE_CACHE_UPDATE_EVENT, handlePaletteCacheUpdate);
        return () => {
            window.removeEventListener(PALETTE_CACHE_UPDATE_EVENT, handlePaletteCacheUpdate);
        };
    }, [file?.path]);

    const folderDetails = useMemo(() => {
        if (file && file.type === FileType.FOLDER) {
            const types: Record<string, number> = {};
            let totalFiles = 0;
            let subFolderCount = 0;

            const stack = [file.id];

            while (stack.length) {
                const currentId = stack.pop()!;
                const node = files[currentId];
                if (!node) continue;

                if (currentId !== file.id) {
                    if (node.type === FileType.FOLDER) {
                        subFolderCount++;
                    } else if (node.type === FileType.IMAGE) {
                        totalFiles++;
                        const fmt = node.meta?.format?.toUpperCase() || 'OTHER';
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
    }, [file?.id, filesVersion]);

    const folderStats = useMemo(() => {
        if (file && file.type === FileType.FOLDER) {
            return getFolderStats(files, file.id);
        }
        return null;
    }, [file?.id, filesVersion]);

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

    /* render-count effect removed from here and reinserted after `personStats` to avoid TDZ */

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
        Object.values(files || {}).forEach((f: FileNode) => {
            if (f.type === FileType.IMAGE && f.aiData?.faces.some(face => face.personId === person.id)) {
                totalSize += f.meta?.sizeKb || 0;
                count++;
            }
        });
        return { totalSize, count };
    }, [person?.id, filesVersion]);

    // publish both logical and DOM-mounted "rendered items" counts for this panel
    useEffect(() => {
        const win = window as any;
        win.__AURORA_RENDER_COUNTS__ = win.__AURORA_RENDER_COUNTS__ || {};

        let logical = 0;
        if (!file && !isMulti) {
            logical = 0;
        } else if (isMulti) {
            logical = selectedFileIds.length;
        } else if (file && file.type === FileType.FOLDER) {
            logical = folderPreviewImages.length || 0;
        } else if (file) {
            logical = 1 + (file.aiData?.faces?.length || 0) + (colors?.length || 0);
        } else if (person) {
            logical = personStats?.count || 0;
        }

        win.__AURORA_RENDER_COUNTS__.metadataPanelLogical = logical;

        // DOM-mounted approximation: count images and obvious meta rows inside the panel
        try {
            const root = panelRef.current;
            const imgCount = root ? root.querySelectorAll('img').length : 0;
            const rowCount = root ? root.querySelectorAll('[data-meta-row]').length : 0; // conservative selector if present
            win.__AURORA_RENDER_COUNTS__.metadataPanelDOM = Math.max(imgCount, rowCount, logical ? 1 : 0);
        } catch (e) {
            win.__AURORA_RENDER_COUNTS__.metadataPanelDOM = logical ? 1 : 0;
        }
    }, [file?.id, file?.type, folderPreviewImages.length, selectedFileIds.join(','), colors.length, person?.id, personStats?.count, isMulti]);

    const batchStats = useMemo(() => {
        if (!isMulti) return null;
        const selectedNodes = selectedFileIds.map(id => files[id]).filter(Boolean);

        let totalSize = 0;
        const typeCount: Record<string, number> = {};
        const allTags = new Set<string>();

        selectedNodes.forEach(node => {
            if (node.type === FileType.IMAGE) {
                totalSize += node.meta?.sizeKb || 0;
                const fmt = node.meta?.format?.toUpperCase() || 'UNKNOWN';
                typeCount[fmt] = (typeCount[fmt] || 0) + 1;
            } else {
                typeCount['FOLDER'] = (typeCount['FOLDER'] || 0) + 1;
                const fs = getFolderStats(files, node.id);
                totalSize += fs.size;
            }
            node.tags.forEach(t => allTags.add(t));
        });

        return { totalSize, typeCount, allTags: Array.from(allTags).sort() };
    }, [selectedFileIds, filesVersion]);

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
        let descChanged = false;
        let sourceChanged = false;

        if (isMulti) {
            selectedFileIds.forEach(id => {
                const f = files[id];
                if (!f) return;
                const updates: Partial<FileNode> = {};
                if (!isDescMixed && batchDesc && batchDesc !== (f.description || '')) {
                    updates.description = batchDesc;
                    descChanged = true;
                }
                if (!isSourceMixed && batchSource && batchSource !== (f.sourceUrl || '')) {
                    updates.sourceUrl = batchSource;
                    sourceChanged = true;
                }
                if (Object.keys(updates).length > 0) onUpdate(id, updates);
            });
        } else if (file) {
            if (desc !== (file.description || '')) descChanged = true;
            if (source !== (file.sourceUrl || '')) sourceChanged = true;
            if (descChanged || sourceChanged) {
                onUpdate(file.id, { name, description: desc, sourceUrl: source });
            }
        }

        if (descChanged) setShowSavedDesc(true);
        if (sourceChanged) setShowSavedSource(true);
        if (descChanged || sourceChanged) {
            setTimeout(() => {
                setShowSavedDesc(false);
                setShowSavedSource(false);
            }, 2000);
        }
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
                    Object.values(topics || {}).forEach(sub => {
                        if (sub.parentId === tid) stack.push(sub.id);
                    });
                }
                topicPeople = Array.from(collected).map(id => people[id]).filter(Boolean);
            } else {
                topicPeople = topic.peopleIds.map(id => people[id]).filter(Boolean);
            }
        }

        // 计算文件数量
        const topicFileCount = topic.fileCount ?? topic.fileIds?.length ?? 0;

        // 获取封面样式 - 与 TopicModule 保持一致的算法
        const getCoverStyle = (t: Topic, overrideUrl?: string | null): React.CSSProperties => {
            const url = overrideUrl || getCoverUrlInternal(t);
            if (!url) return {};

            const style: React.CSSProperties = {
                backgroundImage: `url("${url}")`,
                backgroundRepeat: 'no-repeat'
            };

            const crop = t.coverCrop;
            if (crop && crop.width > 0 && crop.height > 0) {
                Object.assign(style, cropToBackgroundStyle(crop));
            } else {
                style.backgroundSize = 'cover';
                style.backgroundPosition = 'center';
            }
            return style;
        };

        return (
            <div ref={panelRef} className="h-full flex flex-col bg-panel overflow-y-auto custom-scrollbar relative">
                <div className="relative w-full aspect-[3/4] bg-surface group shrink-0 overflow-hidden">
                    <div className="w-full h-full transition-transform duration-700 group-hover:scale-105">
                        <TopicCoverImage topic={topic} coverUrl={coverUrl} className="w-full h-full" />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />
                </div>

                {/* 浮动内容面板 */}
                <div className="px-6 py-8 space-y-8 flex-1 relative bg-panel rounded-t-[2rem] -mt-8 shadow-2xl">
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
                                <div className="flex items-center gap-2 px-3.5 py-1.5 bg-surface text-gray-500 dark:text-gray-400 rounded-full border border-subtle text-[11px] font-bold uppercase tracking-wider">
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
                        <div className="bg-surface/50 rounded-2xl border border-subtle/50 p-1 group/desc relative overflow-hidden transition-all focus-within:ring-2 ring-blue-500/10">
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
                                <span className="text-[10px] font-bold bg-surface text-gray-500 px-2 py-0.5 rounded-full">
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
                                            <div className="relative w-20 h-20 rounded-full bg-surface border border-transparent group-hover/avatar:border-blue-500/50 transition-all shadow-sm">
                                                <div className="relative w-full h-full rounded-full overflow-hidden">
                                                    <div className="w-full h-full transition-transform duration-500 group-hover/avatar:scale-110">
                                                        <PersonAvatar person={p} coverFile={pCover} size={80} className="rounded-full" />
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
                                            <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-surface border border-subtle shadow-sm transition-all group-hover/sub:shadow-md group-hover/sub:border-blue-500/30">
                                                <div className="w-full h-full transition-transform duration-500 group-hover/sub:scale-110">
                                                    <TopicCoverImage topic={sub} coverUrl={subCoverUrl} className="w-full h-full rounded-2xl" />
                                                </div>
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
                                    className="w-full bg-surface/50 border border-subtle/50 rounded-2xl px-4 py-3 text-sm dark:text-white focus:outline-none focus:ring-2 ring-blue-500/20 focus:bg-white dark:focus:bg-gray-800 transition-all placeholder:text-gray-400/50"
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
                                    className="flex items-center justify-center w-12 h-12 bg-surface border border-subtle text-blue-500 hover:text-white hover:bg-blue-500 hover:border-blue-500 rounded-2xl shadow-sm transition-all active:scale-95"
                                    title={t('context.openInBrowser')}
                                >
                                    <ExternalLink size={20} />
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
                        <Check size={14} className="mr-2 text-green-500" />
                        {t('context.saved')}
                    </div>
                )}
            </div>
        );
    }

    // 多选专题的情况
    if (selectedTopicCount > 1 && topics && selectedTopicIds && selectedTopicIds.length > 0) {
        return (
            <div ref={panelRef} className="h-full flex flex-col bg-panel overflow-y-auto custom-scrollbar relative">
                <div className="p-5 flex-shrink-0 bg-panel">
                    <div className="font-bold text-lg text-gray-800 dark:text-white break-words leading-tight mb-1">
                        {selectedTopicCount} {t('context.selectedTopics') || t('sidebar.topics')}
                    </div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 font-medium">
                        {t('meta.multipleTopicsSelected') || 'Multiple topics selected'}
                    </div>
                </div>

                <div className="p-5 space-y-6">
                    <div className="bg-surface rounded-xl border border-subtle p-4 shadow-sm">
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
                                    ? Object.values(topics || {}).filter(sub => sub.parentId === topic.id)
                                        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                                    : [];

                                const isExpanded = expandedTopicIds.has(topicId);
                                const visibleSubtopics = isExpanded ? allSubTopics : allSubTopics.slice(0, 2);

                                return (
                                    <div
                                        key={topicId}
                                        className="flex items-start gap-3.5 p-3.5 bg-surface/60 rounded-xl border border-subtle hover:bg-surface transition-all cursor-pointer group/item active:scale-[0.98]"
                                        onClick={() => onSelectTopic && onSelectTopic(topicId)}
                                    >
                                        {/* Cover with 3:4 Ratio */}
                                        <div className="w-[66px] h-[88px] rounded-lg border border-subtle/60 shadow-sm overflow-hidden bg-surface flex-shrink-0 relative group-hover/item:border-blue-500/50 transition-all">
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
                                                                    ...cropToImgStyle(topic.coverCrop),
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
                                                    <Layout size={24} className="opacity-30" />
                                                </div>
                                            )}
                                        </div>

                                        {/* Info Area */}
                                        <div className="flex-1 min-w-0 flex flex-col py-0.5 relative">
                                            <div className="font-bold text-sm text-gray-900 dark:text-white truncate leading-tight mb-2 group-hover/item:text-blue-500 transition-colors flex items-center justify-between">
                                                <span className="truncate flex-1 mr-3">{topic.name}</span>
                                                {topic.type && (
                                                    <span className="ml-2 flex-shrink-0 px-1.5 py-0.5 bg-surface text-[9px] font-black text-gray-400 dark:text-gray-500 rounded uppercase tracking-widest border border-subtle/30">
                                                        {topic.type}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Stats Row */}
                                            <div className="flex items-center gap-3 text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-2.5">
                                                <span className="flex items-center bg-surface px-1.5 py-0.5 rounded" title={`${topic.peopleIds?.length || 0} People`}>
                                                    <User size={10} className="mr-1 opacity-70" /> {topic.peopleIds?.length || 0}
                                                </span>
                                                <span className="flex items-center bg-surface px-1.5 py-0.5 rounded" title={`${topic.fileCount ?? topic.fileIds?.length ?? 0} Files`}>
                                                    <ImageIcon size={10} className="mr-1 opacity-70" /> {topic.fileCount ?? topic.fileIds?.length ?? 0}
                                                </span>
                                                {isMainTopic && allSubTopics.length > 0 && (
                                                    <span className="flex items-center bg-blue-50 dark:bg-blue-900/20 text-blue-500 px-1.5 py-0.5 rounded" title={`${allSubTopics.length} Subtopics`}>
                                                        <FolderIcon size={10} className="mr-1 opacity-70" /> {allSubTopics.length}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Subtopics List (Vertical List) */}
                                            {isMainTopic && allSubTopics.length > 0 && (
                                                <div className="space-y-1.5 pt-1.5 border-t border-subtle/50 relative">
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
                                                            className="absolute bottom-0 right-0 p-1 hover:bg-surface rounded-md transition-colors text-blue-500/80 hover:text-blue-600"
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
                        <div className="mt-4 pt-4 border-t border-subtle">
                            <button
                                onClick={() => {
                                    if (window.confirm(`${t('context.delete')} ${selectedTopicIds.length} ${t('sidebar.topics')}?`)) {
                                        selectedTopicIds.forEach(id => onDeleteTopic(id));
                                    }
                                }}
                                className="w-full flex items-center justify-center px-4 py-2.5 bg-red-50 hover:bg-red-100 dark:bg-red-900/10 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl transition-all text-sm font-bold group"
                            >
                                <Trash2 size={16} className="mr-2 group-hover:scale-110 transition-transform" />
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
            <div ref={panelRef} className="h-full flex flex-col bg-panel overflow-y-auto custom-scrollbar relative">
                <div className="p-5 flex-shrink-0 bg-panel">
                    <div className="font-bold text-lg text-gray-800 dark:text-white break-words leading-tight mb-1">
                        {selectedPeopleCount} {t('context.selectedPeople')}
                    </div>
                </div>

                <div className="p-5 space-y-6">
                    {/* Selected People List */}
                    <div className="bg-surface rounded-lg border border-subtle p-4 shadow-sm">
                        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                            <User size={12} className="mr-1.5" /> {t('context.selectedPeople')}
                        </div>
                        <div className="flex flex-col gap-3 overflow-y-auto">
                            {selectedPersonIds?.map(personId => {
                                const selectedPerson = people?.[personId];
                                if (!selectedPerson) return null;

                                const coverFile = files[selectedPerson.coverFileId];

                                return (
                                    <div
                                        key={personId}
                                        className="flex items-center gap-3 p-3 bg-surface/50 rounded-lg border border-subtle hover:bg-surface transition-all cursor-pointer group/item active:scale-[0.98]"
                                        onClick={() => onSelectPerson && onSelectPerson(personId)}
                                    >
                                        {/* Avatar */}
                                        <div className="w-14 h-14 rounded-full border-2 border-white dark:border-gray-800 shadow-md overflow-hidden bg-surface flex-shrink-0 relative group-hover/item:border-blue-500/50 transition-colors">
                                            <PersonAvatar person={selectedPerson} coverFile={coverFile} size={56} className="rounded-full" />
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
            <div ref={panelRef} className="h-full flex flex-col bg-panel overflow-y-auto custom-scrollbar relative">

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
                        <div className="w-32 h-32 rounded-full border-4 border-white dark:border-gray-800 shadow-xl overflow-hidden bg-surface mb-4 relative group">
                            <div className="w-full h-full transition-transform duration-300 group-hover:scale-110">
                                <PersonAvatar person={person} coverFile={coverFile} size={128} className="rounded-full" />
                            </div>
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
                                    className="text-2xl font-bold text-center text-gray-800 dark:text-white bg-transparent border-b border-transparent hover:border-subtle focus:border-blue-500 focus:outline-none block mx-auto py-1 transition-all"
                                    placeholder={t('context.enterNewPersonName')}
                                    style={{ width: nameWidth }}
                                />
                                <Edit3 size={14} onClick={() => nameInputRef.current?.focus()} className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer" />
                            </div>
                        </div>

                        {/* Stats */}
                        <div className="flex items-center gap-3">
                            <div className="flex flex-col items-center px-4 py-2 bg-surface/80 rounded-xl border border-subtle shadow-sm backdrop-blur-sm min-w-[90px]">
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-bold tracking-wider mb-0.5">{t('context.files')}</span>
                                <span className="text-lg font-mono font-bold text-blue-600 dark:text-blue-400">{person.count}</span>
                            </div>
                            <div className="flex flex-col items-center px-4 py-2 bg-surface/80 rounded-xl border border-subtle shadow-sm backdrop-blur-sm min-w-[90px]">
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
                        <div className="bg-surface/50 rounded-2xl border border-subtle/50 p-1 group/desc relative overflow-hidden transition-all focus-within:ring-2 ring-blue-500/10">
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
                        <Check size={14} className="mr-2 text-green-500" />
                        {t('context.saved')}
                    </div>
                )}
            </div>
        );
    }

    if (!file && !isMulti) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4 text-center">
                <Sparkles size={48} className="mb-4 opacity-20" />
                <p>{t('meta.selectHint')}</p>
            </div>
        );
    }

    return (
        <div ref={panelRef} className="h-full flex flex-col bg-panel overflow-y-auto custom-scrollbar relative">
            <FileInfoSection
                isMulti={isMulti}
                file={file}
                files={files}
                selectedCount={selectedFileIds.length}
                t={t}
                settings={settings}
                aiConnectionStatus={aiConnectionStatus}
                previewName={previewName}
                isGenerating={isGenerating}
                onGenerateName={generateName}
                onApplyRename={applyRename}
                onCancelRename={cancelRename}
            />

            <div className="p-5 space-y-6">

                {/* Multi-Selection Composition Chart */}
                {isMulti && (
                    <BatchStatsSection
                        batchStats={batchStats}
                        batchChartData={batchChartData}
                        totalFiles={selectedFileIds.length}
                        t={t}
                    />
                )}

                {/* Large Preview Image (Single Image Only) */}
                {!isMulti && file && file.type === FileType.IMAGE && (
                    <ImagePreview file={file} resourceRoot={resourceRoot} cachePath={cachePath} />
                )}

                {/* Color Palette (8 Card Grid) */}
                {!isMulti && file && file.type === FileType.IMAGE && (
                    <PaletteSection
                        file={file}
                        colors={colors}
                        loadingPalette={loadingPalette}
                        resourceRoot={resourceRoot}
                        t={t}
                        onSearch={onSearch}
                        onUpdate={onUpdate}
                        extractedCache={extractedCache}
                        currentExtractFileRef={currentExtractFileRef}
                        onPaletteMenu={setPaletteMenu}
                        onLoadingPalette={setLoadingPalette}
                    />
                )}

                {/* Folder Thumbnail */}
                <FolderInfoSection
                    file={file}
                    folderPreviewImages={folderPreviewImages}
                    folderDetails={folderDetails}
                    chartData={chartData}
                    t={t}
                />

                {/* AI Analysis Section */}
                <AIAnalysisSection
                    isMulti={isMulti}
                    file={file}
                    files={files}
                    selectedFileIds={selectedFileIds}
                    people={people}
                    onUpdate={onUpdate}
                    onSelectPerson={onSelectPerson}
                    onCopyToClipboard={copyToClipboard}
                    t={t}
                />

                {/* Open Folder Button */}
                {!isMulti && file && (
                    <button
                        onClick={() => {
                            if (file.parentId && !(activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId)) {
                                onNavigateToFolder(file.parentId, { targetId: file.id });
                            }
                        }}
                        className={`w-full flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-colors border border-subtle group ${activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId ? 'bg-surface text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-50' : 'bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-200'}`}
                        disabled={activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId}
                    >
                        <FolderOpen size={16} className={`mr-2 ${activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId ? 'text-gray-400 dark:text-gray-500' : 'text-blue-500 group-hover:text-blue-600 dark:group-hover:text-blue-400'}`} />
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
                                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><FileText size={10} className="mr-1" /> {t('meta.format')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{file.meta.format?.toUpperCase() || '---'}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><HardDrive size={10} className="mr-1" /> {t('meta.size')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{file.meta.sizeKb !== undefined ? formatSize(file.meta.sizeKb) : '---'}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><ImageIcon size={10} className="mr-1" /> {t('meta.dimensions')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">
                                            {(file.meta.width || file.meta.height) ? `${file.meta.width || 0} x ${file.meta.height || 0}` : '---'}
                                        </div>
                                    </div>
                                </>
                            )}
                            {file.type === FileType.FOLDER && folderStats && (
                                <>
                                    <div>
                                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><FolderIcon size={10} className="mr-1" /> {t('context.files')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{folderStats.fileCount}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><HardDrive size={10} className="mr-1" /> {t('meta.totalSize')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{formatSize(folderStats.size)}</div>
                                    </div>
                                </>
                            )}
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><Calendar size={10} className="mr-1" /> {t('meta.created')}</div>
                                <div className="text-xs text-gray-800 dark:text-gray-200 font-mono">{file.createdAt ? new Date(file.createdAt).toLocaleDateString() : '-'}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5 flex items-center"><Clock size={10} className="mr-1" /> {t('meta.updated')}</div>
                                <div className="text-xs text-gray-800 dark:text-gray-200 font-mono">{file.updatedAt ? new Date(file.updatedAt).toLocaleString() : '-'}</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Folder Category Selector */}
                {((file && file.type === FileType.FOLDER) || (isMulti && selectedFileIds.every(id => files[id]?.type === FileType.FOLDER))) && (
                    <CategorySelector
                        current={file
                            ? (file.category || 'general')
                            : (selectedFileIds.every(id => files[id]?.category === 'book')
                                ? 'book'
                                : selectedFileIds.every(id => files[id]?.category === 'sequence')
                                    ? 'sequence'
                                    : 'general')}
                        onChange={handleCategoryChange}
                        t={t}
                    />
                )}

                {/* Topic Display Button */}
                {!isMulti && file && fileTopic && (
                    <div>
                        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center">
                            <Layout size={12} className="mr-1.5 text-indigo-500" /> {t('sidebar.topics')}
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

                {/* Tags / Description / Source URL Sections */}
                <EditSection
                    isMulti={isMulti}
                    file={file}
                    files={files}
                    selectedFileIds={selectedFileIds}
                    newTagInput={newTagInput}
                    onNewTagInputChange={setNewTagInput}
                    systemTags={systemTags}
                    onAddTag={handleAddTag}
                    onRemoveTag={handleRemoveTag}
                    onNavigateToTag={onNavigateToTag}
                    desc={desc}
                    onDescChange={setDesc}
                    batchDesc={batchDesc}
                    onBatchDescChange={setBatchDesc}
                    isDescMixed={isDescMixed}
                    showSavedDesc={showSavedDesc}
                    textareaRef={textareaRef}
                    source={source}
                    onSourceChange={setSource}
                    batchSource={batchSource}
                    onBatchSourceChange={setBatchSource}
                    isSourceMixed={isSourceMixed}
                    showSavedSource={showSavedSource}
                    onUpdateMeta={handleUpdateMeta}
                    t={t}
                />
            </div>

            {/* Palette Context Menu */}
            {paletteMenu.visible && paletteMenu.color && createPortal(
                <div
                    className="fixed bg-panel border border-subtle rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 z-[70] animate-zoom-in"
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
                        <Copy size={14} className="mr-2 opacity-70" /> {t('context.copyColor')}
                    </div>
                    <div
                        className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center"
                        onClick={() => {
                            onSearch(`color:${paletteMenu.color!.replace('#', '')}`);
                            setPaletteMenu({ ...paletteMenu, visible: false });
                        }}
                    >
                        <Search size={14} className="mr-2 opacity-70" /> {t('context.searchSimilarColor')}
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
                <div className="fixed inset-0 z-[69]" onClick={() => setPaletteMenu({ ...paletteMenu, visible: false })}></div>
            )}
        </div>
    );
};
