import type { MutableRefObject } from 'react';
import { Palette as PaletteIcon, Sparkles, RefreshCw } from 'lucide-react';
import { FileNode, FileType } from '../../types';
import { isAndroidPlatformCached } from '../../api/tauri-bridge';

interface PaletteMenuState {
    visible: boolean;
    x: number;
    y: number;
    color: string | null;
}

interface PaletteSectionProps {
    file: FileNode;
    colors: string[];
    loadingPalette: boolean;
    resourceRoot?: string;
    t: (key: string) => string;
    onSearch: (query: string) => void;
    onUpdate: (id: string, updates: Partial<FileNode>) => void;
    extractedCache: MutableRefObject<Set<string>>;
    currentExtractFileRef: MutableRefObject<string | null>;
    onPaletteMenu: (menu: PaletteMenuState) => void;
    onLoadingPalette: (loading: boolean) => void;
}

const PaletteSection = ({ file, colors, loadingPalette, resourceRoot, t, onSearch, onUpdate, extractedCache, currentExtractFileRef, onPaletteMenu, onLoadingPalette }: PaletteSectionProps) => {
    return (
        <div>
            <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                <div className="flex items-center">
                    <PaletteIcon size={12} className="mr-1.5" /> {t('meta.palette')}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={async () => {
                            if (colors.length > 0) {
                                const atmosphereColors = colors.slice(0, 5);
                                const searchQuery = `palette:${atmosphereColors.map(c => c.replace('#', '')).join(',')}`;
                                onSearch(searchQuery);
                            }
                        }}
                        className="p-1 px-2 flex items-center gap-1 hover:bg-surface rounded-md transition-colors text-[10px] text-gray-500 font-medium"
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
                                        let hexColors: string[] = [];
                                        if (file.path.startsWith('lan://') || file.path.startsWith('android://')) {
                                            const { getRemotePalette } = await import('../../utils/remoteSource');
                                            hexColors = await getRemotePalette(file.path);
                                        } else {
                                            const { getDominantColors } = await import('../../api/tauri-bridge');

                                            let thumbnailPath: string | null = null;
                                            const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
                                            if (pathCache && pathCache.get) {
                                                thumbnailPath = pathCache.get(file.path!);
                                            }

                                            if (!thumbnailPath && resourceRoot) {
                                                try {
                                                    const { getThumbnail } = await import('../../api/tauri-bridge');
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
                                                hexColors = colors.map(c => c.hex);
                                            }
                                        }

                                        onUpdate(file.id, {
                                            meta: { ...file.meta!, palette: hexColors }
                                        });
                                    } catch (err) {
                                        console.error('Failed to extract palette:', err);
                                        onUpdate(file.id, {
                                            meta: { ...file.meta!, palette: [] }
                                        });
                                    }
                                })();
                            }
                        }}
                        className="p-1.5 hover:bg-surface rounded-md transition-colors flex items-center justify-center"
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
                                const menuWidth = 180;
                                const isRightmost = i === 7;
                                const x = isRightmost ? e.clientX - menuWidth : e.clientX;
                                onPaletteMenu({ visible: true, x, y: e.clientY, color });
                            }}
                            title={color}
                        />
                    ))
                ) : isAndroidPlatformCached() ? (
                    loadingPalette ? (
                        Array.from({ length: 8 }).map((_, i) => (
                            <div
                                key={i}
                                className="w-6 h-6 rounded-full bg-surface animate-pulse ring-1 ring-black/5 dark:ring-white/5"
                            />
                        ))
                    ) : (
                        <button
                            onClick={async () => {
                                if (!file?.path) return;
                                const fileId = file.id;
                                currentExtractFileRef.current = fileId;
                                onLoadingPalette(true);
                                try {
                                    let hexColors: string[] = [];
                                    if (file.path.startsWith('lan://') || file.path.startsWith('android://')) {
                                        const { getRemotePalette } = await import('../../utils/remoteSource');
                                        hexColors = await getRemotePalette(file.path);
                                    } else {
                                        const { getDominantColors } = await import('../../api/tauri-bridge');
                                        const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
                                        let thumbnailPath: string | undefined = undefined;
                                        if (pathCache?.get) {
                                            thumbnailPath = pathCache.get(file.path);
                                        }
                                        const result = await getDominantColors(file.path, 8, thumbnailPath);
                                        if (result && result.length > 0) {
                                            hexColors = result.map(c => c.hex);
                                        }
                                    }
                                    if (hexColors.length > 0) {
                                        onUpdate(file.id, {
                                            meta: { ...file.meta!, palette: hexColors }
                                        });
                                    }
                                } catch (err) {
                                    console.error('[Single-extract] Failed to extract palette:', err);
                                } finally {
                                    if (currentExtractFileRef.current === fileId) {
                                        onLoadingPalette(false);
                                    }
                                }
                            }}
                            className="px-4 py-1.5 text-xs font-medium rounded-full border border-subtle text-gray-600 dark:text-gray-400 hover:bg-surface hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
                        >
                            {t('meta.extractColor')}
                        </button>
                    )
                ) : (
                    Array.from({ length: 8 }).map((_, i) => (
                        <div
                            key={i}
                            className="w-6 h-6 rounded-full bg-surface animate-pulse ring-1 ring-black/5 dark:ring-white/5"
                        />
                    ))
                )}
            </div>
        </div>
    );
};

export default PaletteSection;
