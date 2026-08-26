import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Search, User, Check, Sparkles, X } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as RW from 'react-window';
import { FileNode, CharacterTag, DetectedCharacter, ClipSearchResult, Person } from '../../types';
import { cropToImgStyle, faceBoxToCrop } from '../../utils/cropStyle';
import { clipGetCharacterTags, clipSearchByCharacterTag, clipGetDetectedCharacters, getThumbnail } from '../../api/tauri-bridge';
import { ImageThumbnail } from '../ImageThumbnail';

const FixedSizeListComp: any = (() => {
  const mod: any = RW as any;
  if (mod.FixedSizeList) return mod.FixedSizeList;
  if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
  if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
  return null;
})();

interface SmartCreatePersonModalProps {
  files: Record<string, FileNode>;
  resourceRoot: string;
  cachePath: string;
  language: 'zh' | 'en';
  clipSettings: {
    minScore: number;
    modelName: string;
    enabled: boolean;
  };
  people: Record<string, Person>;
  onConfirm: (name: string, coverFileId: string, matchedFileIds: string[], faceBox?: { x: number; y: number; w: number; h: number }, characterTagName?: string, characterTagIndex?: number) => void;
  onClose: () => void;
  t: (key: string) => string;
}

const ITEM_HEIGHT = 48;

interface CharacterRowProps {
  index: number;
  style: React.CSSProperties;
  data: {
    characters: DetectedCharacter[];
    files: Record<string, FileNode>;
    onSelect: (char: DetectedCharacter) => void;
    selectedTagIndex: number | null;
    language: 'zh' | 'en';
    characterThumbnailUrls: Record<string, string>;
  };
}

const CharacterRow = React.memo(({ index, style, data }: CharacterRowProps) => {
  const { characters, files, onSelect, selectedTagIndex, language, characterThumbnailUrls } = data;
  const char = characters[index];
  const sampleFile = files[char.sample_file_id];
  const isSelected = selectedTagIndex === char.tag_index;
  
  const displayName = language === 'zh' && char.tag_name_cn ? char.tag_name_cn : char.tag_name;
  const thumbnailUrl = characterThumbnailUrls?.[char.sample_file_id];
  
  return (
    <div
      style={style}
      onClick={() => onSelect(char)}
      className={`flex items-center p-2 rounded cursor-pointer group ${
        isSelected
          ? 'bg-blue-100 dark:bg-blue-900/30'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      <div className="relative mr-3 flex-shrink-0">
        <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
          {sampleFile && thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={displayName}
              className="w-full h-full object-cover"
              decoding="async"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <User size={16} className="text-gray-400 dark:text-gray-500" />
            </div>
          )}
        </div>
        {isSelected && (
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center">
            <Check size={10} className="text-white" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${isSelected ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-800 dark:text-gray-200'}`}>
          {displayName}
        </div>
      </div>
    </div>
  );
});

CharacterRow.displayName = 'CharacterRow';

const THUMBNAIL_SIZE = 120;
const GRID_GAP = 8;

const VIEWPORT_SIZE = 400;
const CROP_SIZE = 250;
const CROP_OFFSET = (VIEWPORT_SIZE - CROP_SIZE) / 2;

export const SmartCreatePersonModal: React.FC<SmartCreatePersonModalProps> = ({
  files,
  resourceRoot,
  cachePath,
  language,
  clipSettings,
  people,
  onConfirm,
  onClose,
  t
}) => {
  const [name, setName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [threshold, setThreshold] = useState(0.1);
  const [characterThreshold, setCharacterThreshold] = useState(0.1);
  const [detectedCharacters, setDetectedCharacters] = useState<DetectedCharacter[]>([]);
  const [allCharacterTags, setAllCharacterTags] = useState<CharacterTag[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<DetectedCharacter | null>(null);
  const [matchedResults, setMatchedResults] = useState<ClipSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCharacters, setLoadingCharacters] = useState(true);
  const [coverFileId, setCoverFileId] = useState<string | null>(null);
  const [coverFaceBox, setCoverFaceBox] = useState<{ x: number; y: number; w: number; h: number } | undefined>();
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [characterThumbnailUrls, setCharacterThumbnailUrls] = useState<Record<string, string>>({});
  
  const [isCropping, setIsCropping] = useState(false);
  const [cropScale, setCropScale] = useState(1);
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const cropImgRef = useRef<HTMLImageElement>(null);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerRect, setContainerRect] = useState({ width: 600, height: 300 });
  
  const characterListRef = useRef<HTMLDivElement>(null);
  const [characterListHeight, setCharacterListHeight] = useState(200);
  
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const characterDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const loadCharacters = async () => {
      if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') {
        setLoadingCharacters(false);
        return;
      }
      
      try {
        setLoadingCharacters(true);
        const [characters, tags] = await Promise.all([
          clipGetDetectedCharacters(0.1, 1, language),
          clipGetCharacterTags(language)
        ]);
        setDetectedCharacters(characters);
        setAllCharacterTags(tags);
      } catch (error) {
        console.error('Failed to load characters:', error);
      } finally {
        setLoadingCharacters(false);
      }
    };
    
    loadCharacters();
  }, [clipSettings.enabled, clipSettings.modelName, language]);

  useEffect(() => {
    const updateRect = () => {
      if (gridContainerRef.current) {
        const rect = gridContainerRef.current.getBoundingClientRect();
        setContainerRect({ width: rect.width, height: rect.height });
      }
    };
    
    updateRect();
    window.addEventListener('resize', updateRect);
    return () => window.removeEventListener('resize', updateRect);
  }, []);

  useEffect(() => {
    const updateCharacterListHeight = () => {
      if (characterListRef.current) {
        const rect = characterListRef.current.getBoundingClientRect();
        setCharacterListHeight(rect.height);
      }
    };
    
    updateCharacterListHeight();
    window.addEventListener('resize', updateCharacterListHeight);
    
    const observer = new ResizeObserver(updateCharacterListHeight);
    if (characterListRef.current) {
      observer.observe(characterListRef.current);
    }
    
    return () => {
      window.removeEventListener('resize', updateCharacterListHeight);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (coverFileId && resourceRoot) {
      const file = files[coverFileId];
      if (file && file.path) {
        getThumbnail(file.path, undefined, resourceRoot).then(url => {
          if (url) setThumbnailUrls(prev => ({ ...prev, [coverFileId]: url }));
        }).catch(e => console.error('Failed to load cover thumbnail:', e));
      }
    }
  }, [coverFileId, files, resourceRoot]);

  useEffect(() => {
    if (detectedCharacters.length > 0 && resourceRoot) {
      const loadCharacterThumbnails = async () => {
        const batchSize = 10;
        const chars = detectedCharacters.filter(char => files[char.sample_file_id]?.path);
        
        for (let i = 0; i < chars.length; i += batchSize) {
          const batch = chars.slice(i, i + batchSize);
          const results = await Promise.all(
            batch.map(async char => {
              const file = files[char.sample_file_id];
              if (file && file.path) {
                try {
                  const url = await getThumbnail(file.path, undefined, resourceRoot);
                  return { id: char.sample_file_id, url };
                } catch (e) {
                  console.error('Failed to load character thumbnail:', e);
                  return null;
                }
              }
              return null;
            })
          );
          
          const newUrls: Record<string, string> = {};
          results.forEach(r => {
            if (r && r.url) newUrls[r.id] = r.url;
          });
          
          if (Object.keys(newUrls).length > 0) {
            setCharacterThumbnailUrls(prev => ({ ...prev, ...newUrls }));
          }
        }
      };
      loadCharacterThumbnails();
    }
  }, [detectedCharacters, files, resourceRoot]);

  const handleSelectCharacter = useCallback(async (char: DetectedCharacter) => {
    setSelectedCharacter(char);
    const displayName = language === 'zh' && char.tag_name_cn ? char.tag_name_cn : char.tag_name;
    setName(displayName);
    setCoverFileId(char.sample_file_id);
    setCoverFaceBox(undefined);
    
    setLoading(true);
    try {
      const results = await clipSearchByCharacterTag(char.tag_index, threshold, 200);
      setMatchedResults(results);
      if (results.length > 0 && !char.sample_file_id) {
        setCoverFileId(results[0].file_id);
      }
    } catch (error) {
      console.error('Failed to search by character tag:', error);
    } finally {
      setLoading(false);
    }
  }, [threshold, language]);

  const handleSearchByName = useCallback(async () => {
    if (!name.trim()) return;
    
    const searchTerm = name.toLowerCase().trim();
    const matchedTag = allCharacterTags.find(tag => {
      const tagName = tag.name.toLowerCase();
      const tagNameCn = tag.name_cn.toLowerCase();
      return tagName.includes(searchTerm) || tagNameCn.includes(searchTerm);
    });
    
    if (matchedTag) {
      setLoading(true);
      try {
        const results = await clipSearchByCharacterTag(matchedTag.index, threshold, 200);
        setMatchedResults(results);
        if (results.length > 0) {
          setCoverFileId(results[0].file_id);
        }
        setSelectedCharacter({
          tag_name: matchedTag.name,
          tag_name_cn: matchedTag.name_cn,
          tag_index: matchedTag.index,
          file_count: results.length,
          max_score: results[0]?.score || 0,
          sample_file_id: results[0]?.file_id || ''
        });
      } catch (error) {
        console.error('Failed to search by character tag:', error);
      } finally {
        setLoading(false);
      }
    }
  }, [name, allCharacterTags, threshold]);

  const handleThresholdChange = useCallback((newThreshold: number) => {
    setThreshold(newThreshold);
    
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(async () => {
      if (!selectedCharacter) return;
      
      setLoading(true);
      try {
        const results = await clipSearchByCharacterTag(
          selectedCharacter.tag_index, 
          newThreshold, 
          200
        );
        setMatchedResults(results);
      } catch (error) {
        console.error('Failed to search with new threshold:', error);
      } finally {
        setLoading(false);
      }
    }, 200);
  }, [selectedCharacter]);

  const handleCharacterThresholdChange = useCallback((newThreshold: number) => {
    setCharacterThreshold(newThreshold);
    
    if (characterDebounceTimerRef.current) {
      clearTimeout(characterDebounceTimerRef.current);
    }
    
    characterDebounceTimerRef.current = setTimeout(async () => {
      if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') return;
      
      setLoadingCharacters(true);
      try {
        const [characters] = await Promise.all([
          clipGetDetectedCharacters(newThreshold, 1, language)
        ]);
        setDetectedCharacters(characters);
      } catch (error) {
        console.error('Failed to load characters with new threshold:', error);
      } finally {
        setLoadingCharacters(false);
      }
    }, 200);
  }, [clipSettings.enabled, clipSettings.modelName, language]);

  const handleAvatarClick = useCallback(() => {
    if (coverFileId) {
      setIsCropping(true);
      setCropScale(1);
      setCropPosition({ x: 0, y: 0 });
    }
  }, [coverFileId]);

  const handleCropMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX - cropPosition.x, y: e.clientY - cropPosition.y });
  }, [cropPosition]);

  const handleCropMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && cropImgRef.current) {
      let newX = e.clientX - dragStart.x;
      let newY = e.clientY - dragStart.y;

      const w = cropImgRef.current.naturalWidth * cropScale;
      const h = cropImgRef.current.naturalHeight * cropScale;

      const minX = CROP_OFFSET + CROP_SIZE - w;
      const maxX = CROP_OFFSET;
      const minY = CROP_OFFSET + CROP_SIZE - h;
      const maxY = CROP_OFFSET;

      if (newX > maxX) newX = maxX;
      if (newX < minX) newX = minX;
      if (newY > maxY) newY = maxY;
      if (newY < minY) newY = minY;

      setCropPosition({ x: newX, y: newY });
    }
  }, [isDragging, dragStart, cropScale]);

  const handleCropMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleCropImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    let initialScale;
    let initialPosition = { x: 0, y: 0 };

    if (coverFaceBox) {
      const boxWidth = img.naturalWidth * (coverFaceBox.w / 100);
      const boxHeight = img.naturalHeight * (coverFaceBox.h / 100);

      const scaleX = CROP_SIZE * 1.5 / boxWidth;
      const scaleY = CROP_SIZE * 1.5 / boxHeight;
      initialScale = Math.max(scaleX, scaleY);

      const boxCenterX = img.naturalWidth * (coverFaceBox.x / 100) + boxWidth / 2;
      const boxCenterY = img.naturalHeight * (coverFaceBox.y / 100) + boxHeight / 2;

      initialPosition = {
        x: VIEWPORT_SIZE / 2 - boxCenterX * initialScale,
        y: VIEWPORT_SIZE / 2 - boxCenterY * initialScale
      };
    } else {
      const minScale = CROP_SIZE / Math.min(img.naturalWidth, img.naturalHeight);
      initialScale = Math.max(minScale, 0.5);

      initialPosition = {
        x: (VIEWPORT_SIZE - img.naturalWidth * initialScale) / 2,
        y: (VIEWPORT_SIZE - img.naturalHeight * initialScale) / 2
      };
    }

    setCropScale(initialScale);
    setCropPosition(initialPosition);
  }, [coverFaceBox]);

  const handleCropWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!cropImgRef.current) return;

    const ZOOM_SPEED = 0.1;
    const direction = Math.sign(e.deltaY);
    let newScale = cropScale;

    if (direction < 0) {
      newScale = cropScale * (1 + ZOOM_SPEED);
    } else {
      newScale = cropScale / (1 + ZOOM_SPEED);
    }

    const minScale = CROP_SIZE / Math.min(cropImgRef.current.naturalWidth, cropImgRef.current.naturalHeight);
    newScale = Math.max(minScale, Math.min(newScale, 5));

    const w = cropImgRef.current.naturalWidth * newScale;
    const h = cropImgRef.current.naturalHeight * newScale;

    let newX = cropPosition.x;
    let newY = cropPosition.y;

    const cx = (CROP_OFFSET + CROP_SIZE / 2 - cropPosition.x) / cropScale;
    const cy = (CROP_OFFSET + CROP_SIZE / 2 - cropPosition.y) / cropScale;

    newX = CROP_OFFSET + CROP_SIZE / 2 - cx * newScale;
    newY = CROP_OFFSET + CROP_SIZE / 2 - cy * newScale;

    const minX = CROP_OFFSET + CROP_SIZE - w;
    const maxX = CROP_OFFSET;
    const minY = CROP_OFFSET + CROP_SIZE - h;
    const maxY = CROP_OFFSET;

    if (newX > maxX) newX = maxX;
    if (newX < minX) newX = minX;
    if (newY > maxY) newY = maxY;
    if (newY < minY) newY = minY;

    setCropScale(newScale);
    setCropPosition({ x: newX, y: newY });
  }, [cropScale, cropPosition]);

  const handleCropConfirm = useCallback(() => {
    if (!cropImgRef.current) return;
    const natW = cropImgRef.current.naturalWidth;
    const natH = cropImgRef.current.naturalHeight;

    const x = (CROP_OFFSET - cropPosition.x) / cropScale;
    const y = (CROP_OFFSET - cropPosition.y) / cropScale;
    const w = CROP_SIZE / cropScale;
    const h = CROP_SIZE / cropScale;

    setCoverFaceBox({
      x: (x / natW) * 100,
      y: (y / natH) * 100,
      w: (w / natW) * 100,
      h: (h / natH) * 100
    });
    setIsCropping(false);
  }, [cropScale, cropPosition]);

  const handleCropBack = useCallback(() => {
    setIsCropping(false);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!name.trim()) return;
    const characterTagName = selectedCharacter?.tag_name;
    const characterTagIndex = selectedCharacter?.tag_index;
    onConfirm(
      name.trim(),
      coverFileId || '',
      matchedResults.map(r => r.file_id),
      coverFaceBox,
      characterTagName,
      characterTagIndex
    );
  }, [name, coverFileId, matchedResults, coverFaceBox, onConfirm, selectedCharacter]);

  const filteredCharacters = useMemo(() => {
    const existingTagIndices = new Set(
      Object.values(people || {})
        .map(p => p.characterTagIndex)
        .filter((idx): idx is number => idx !== undefined)
    );
    
    let result = detectedCharacters.filter(char => !existingTagIndices.has(char.tag_index));
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(char => {
        const nameMatch = char.tag_name.toLowerCase().includes(query);
        const nameCnMatch = char.tag_name_cn.toLowerCase().includes(query);
        return nameMatch || nameCnMatch;
      });
    }
    
    return result;
  }, [detectedCharacters, searchQuery, people]);

  const visibleItems = useMemo(() => {
    const buffer = 400;
    const cols = Math.floor((containerRect.width - 32) / (THUMBNAIL_SIZE + GRID_GAP));
    const itemWidth = (containerRect.width - 32 - (cols - 1) * GRID_GAP) / cols;
    
    return matchedResults
      .map((result, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
          id: result.file_id,
          x: 16 + col * (itemWidth + GRID_GAP),
          y: row * (itemWidth + GRID_GAP),
          width: itemWidth,
          height: itemWidth,
          score: result.score,
          index
        };
      })
      .filter(item => {
        const minY = scrollTop - buffer;
        const maxY = scrollTop + containerRect.height + buffer;
        return item.y < maxY && item.y + item.height > minY;
      });
  }, [matchedResults, scrollTop, containerRect]);

  const totalHeight = useMemo(() => {
    const cols = Math.max(1, Math.floor((containerRect.width - 32) / (THUMBNAIL_SIZE + GRID_GAP)));
    const rows = Math.ceil(matchedResults.length / cols);
    return rows * (THUMBNAIL_SIZE + GRID_GAP) + 16;
  }, [matchedResults.length, containerRect.width]);

  const coverFile = coverFileId ? files[coverFileId] : null;
  const coverOriginalSrc = coverFile && coverFile.path ? convertFileSrc(coverFile.path) : null;
  const coverSrc = coverFile && coverFileId 
    ? (coverFaceBox 
        ? coverOriginalSrc 
        : thumbnailUrls[coverFileId] || coverOriginalSrc)
    : null;

  const characterItemData = useMemo(() => ({
    characters: filteredCharacters,
    files,
    onSelect: handleSelectCharacter,
    selectedTagIndex: selectedCharacter?.tag_index ?? null,
    language,
    characterThumbnailUrls
  }), [filteredCharacters, files, handleSelectCharacter, selectedCharacter, language, characterThumbnailUrls]);

  useEffect(() => {
    const el = cropContainerRef.current;
    if (el && isCropping) {
      const wheelListener = (e: WheelEvent) => {
        e.preventDefault();
      };
      el.addEventListener('wheel', wheelListener, { passive: false });
      return () => el.removeEventListener('wheel', wheelListener);
    }
  }, [isCropping]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (characterDebounceTimerRef.current) {
        clearTimeout(characterDebounceTimerRef.current);
      }
    };
  }, []);

  if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-[500px] animate-zoom-in">
        <div className="flex items-center justify-center h-40 text-gray-500 dark:text-gray-400">
          <div className="text-center">
            <Sparkles size={40} className="mx-auto mb-3 opacity-50" />
            <p>{t('smartCreate.wd14Required') || '此功能需要启用 WD14 模型'}</p>
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

  if (isCropping && coverFile && coverOriginalSrc) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-[600px] animate-zoom-in" onMouseUp={handleCropMouseUp} onMouseLeave={handleCropMouseUp}>
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">
            {t('smartCreate.cropAvatar') || '裁剪头像'}
          </h3>
          <button onClick={handleCropBack} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center justify-center bg-gray-100 dark:bg-black/20">
          <div
            ref={cropContainerRef}
            className="relative bg-gray-200 dark:bg-black overflow-hidden cursor-move select-none shadow-lg rounded-full mb-4"
            style={{ width: VIEWPORT_SIZE, height: VIEWPORT_SIZE }}
            onMouseDown={handleCropMouseDown}
            onMouseMove={handleCropMouseMove}
            onWheel={handleCropWheel}
          >
            <img
              ref={cropImgRef}
              src={coverOriginalSrc}
              draggable={false}
              onLoad={handleCropImageLoad}
              className="max-w-none absolute origin-top-left pointer-events-none"
              style={{
                transform: `translate(${cropPosition.x}px, ${cropPosition.y}px) scale(${cropScale})`
              }}
              alt="Avatar preview"
            />
            <div className="absolute inset-0 pointer-events-none">
              <svg width="100%" height="100%">
                <defs>
                  <mask id="cropMaskSmart">
                    <rect x="0" y="0" width="100%" height="100%" fill="white" />
                    <circle cx={VIEWPORT_SIZE / 2} cy={VIEWPORT_SIZE / 2} r={CROP_SIZE / 2} fill="black" />
                  </mask>
                </defs>
                <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#cropMaskSmart)" />
                <circle
                  cx={VIEWPORT_SIZE / 2}
                  cy={VIEWPORT_SIZE / 2}
                  r={CROP_SIZE / 2}
                  fill="none"
                  stroke="white"
                  strokeWidth="2"
                  style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }}
                />
              </svg>
            </div>
          </div>

          <div className="text-xs text-gray-500 text-center bg-white dark:bg-gray-800 px-3 py-1.5 rounded-full shadow-sm border border-gray-200 dark:border-gray-700 mb-4">
            {t('context.cropHint') || '拖拽图片调整位置 • 滚轮缩放'}
          </div>

          <div className="flex items-center space-x-3 bg-white dark:bg-gray-800 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm w-full max-w-sm">
            <span className="text-xs font-medium text-gray-500 whitespace-nowrap">{t('context.zoom') || '缩放'}</span>
            <input
              type="range"
              min="0.1"
              max="5"
              step="0.01"
              value={cropScale}
              onChange={(e) => {
                const newScale = parseFloat(e.target.value);
                if (cropImgRef.current) {
                  const minScale = CROP_SIZE / Math.min(cropImgRef.current.naturalWidth, cropImgRef.current.naturalHeight);
                  if (newScale >= minScale) setCropScale(newScale);
                } else {
                  setCropScale(newScale);
                }
              }}
              className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
          </div>
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button
            onClick={handleCropBack}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition shadow-sm"
          >
            {t('context.backToManualRename') || '返回'}
          </button>
          <button
            onClick={handleCropConfirm}
            className="px-8 py-2 text-sm font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition shadow-md hover:shadow-lg transform active:scale-95"
          >
            {t('settings.confirm') || '确认'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl h-[85vh] flex flex-col animate-zoom-in">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="font-bold text-lg text-gray-900 dark:text-white flex items-center gap-2">
          <Sparkles size={20} className="text-blue-500" />
          {t('smartCreate.title') || '智能创建人物'}
        </h3>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          <X size={18} className="text-gray-500" />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 p-4 flex flex-col overflow-y-auto">
          <div className="flex flex-col items-center mb-4">
            <div
              onClick={handleAvatarClick}
              className={`w-32 h-32 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden border-4 border-white dark:border-gray-600 shadow-lg cursor-pointer hover:ring-4 hover:ring-blue-300 dark:hover:ring-blue-600 transition-all ${coverSrc ? '' : 'flex items-center justify-center'}`}
            >
              {coverSrc ? (
                <div className="w-full h-full overflow-hidden relative">
                  <img
                    src={coverSrc}
                    alt={name || 'Avatar'}
                    className="absolute"
                    style={coverFaceBox ? cropToImgStyle(faceBoxToCrop(coverFaceBox)) : {
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      left: 0,
                      top: 0
                    }}
                  />
                </div>
              ) : (
                <User size={48} className="text-gray-400 dark:text-gray-500" />
              )}
            </div>
            {coverFileId && (
              <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('smartCreate.clickToCrop') || '点击设置头像'}
              </span>
            )}
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('smartCreate.characterName') || '角色名称'}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name.trim() && !selectedCharacter) {
                  handleSearchByName();
                }
              }}
              className="w-full border dark:border-gray-600 rounded px-3 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 text-sm"
              placeholder={t('smartCreate.enterName') || '输入角色名称'}
            />
          </div>

          <div className="mb-4 flex-1 min-h-0 flex flex-col">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('smartCreate.selectCharacter') || '选择角色'}
            </label>
            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full border dark:border-gray-600 rounded pl-8 pr-2 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 text-sm"
                placeholder={t('smartCreate.searchCharacter') || '搜索角色...'}
              />
            </div>
            <div ref={characterListRef} className="border border-gray-200 dark:border-gray-700 rounded flex-1 min-h-0 overflow-hidden">
              {loadingCharacters ? (
                <div className="flex items-center justify-center h-full">
                  <div className="w-6 h-6 border-2 border-gray-300 dark:border-gray-500 border-t-blue-500 dark:border-t-blue-400 rounded-full animate-spin" />
                </div>
              ) : filteredCharacters.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                  {t('smartCreate.noCharacters') || '暂无识别到的角色'}
                </div>
              ) : FixedSizeListComp ? (
                <FixedSizeListComp
                  height={characterListHeight}
                  itemCount={filteredCharacters.length}
                  itemSize={ITEM_HEIGHT}
                  width="100%"
                  itemData={characterItemData}
                  overscanCount={5}
                >
                  {CharacterRow}
                </FixedSizeListComp>
              ) : (
                <div className="overflow-y-auto h-full">
                  {filteredCharacters.map((char, index) => (
                    <CharacterRow
                      key={char.tag_index}
                      index={index}
                      style={{ height: ITEM_HEIGHT }}
                      data={characterItemData}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('smartCreate.characterThreshold') || '角色检测阈值'}: {characterThreshold.toFixed(3)}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.5"
              step="0.01"
              value={characterThreshold}
              onChange={(e) => handleCharacterThresholdChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div className="mt-auto pt-4 border-t border-gray-200 dark:border-gray-700">
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm"
              >
                {t('settings.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={!name.trim() || matchedResults.length === 0}
                className={`flex-1 px-4 py-2 rounded text-sm text-white transition-colors ${
                  name.trim() && matchedResults.length > 0
                    ? 'bg-blue-600 hover:bg-blue-700'
                    : 'bg-gray-400 cursor-not-allowed'
                }`}
              >
                {t('smartCreate.createPerson') || '创建人物'}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
          <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('smartCreate.preview') || '预览匹配图片'}
              </span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {matchedResults.length} {language === 'zh' ? '张图片' : 'images'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {t('smartCreate.similarityThreshold') || '相似度阈值'}: {threshold.toFixed(3)}
              </span>
              <input
                type="range"
                min="0.01"
                max="0.5"
                step="0.01"
                value={threshold}
                onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
                className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>
          <div
            ref={gridContainerRef}
            className="flex-1 overflow-auto p-4"
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          >
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-gray-300 dark:border-gray-500 border-t-blue-500 dark:border-t-blue-400 rounded-full animate-spin" />
              </div>
            ) : matchedResults.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <User size={48} className="mx-auto mb-3 opacity-30" />
                  <p>{t('smartCreate.noMatchedImages') || '没有匹配的图片'}</p>
                  <p className="text-sm mt-1">{t('smartCreate.selectOrSearch') || '请选择或输入角色名称'}</p>
                </div>
              </div>
            ) : (
              <div className="relative" style={{ height: totalHeight }}>
                {visibleItems.map((item) => {
                  const file = files[item.id];
                  
                  return (
                    <div
                      key={item.id}
                      className="absolute group cursor-pointer"
                      style={{
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height
                      }}
                      onClick={() => {
                        setCoverFileId(item.id);
                        setCoverFaceBox(undefined);
                      }}
                    >
                      <div className={`w-full h-full rounded overflow-hidden border-2 transition-all ${
                        coverFileId === item.id
                          ? 'border-blue-500 shadow-lg'
                          : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                      }`}>
                        {file?.path ? (
                          <ImageThumbnail
                            src=""
                            alt={file.name || ""}
                            isSelected={coverFileId === item.id}
                            filePath={file.path}
                            modified={file.updatedAt}
                            resourceRoot={resourceRoot}
                            cachePath={cachePath}
                          />
                        ) : (
                          <div className="w-full h-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                            <ImageIcon size={24} />
                          </div>
                        )}
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="text-xs text-white">{(item.score * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

function ImageIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}
