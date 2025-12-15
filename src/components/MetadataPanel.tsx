import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FileNode, FileType, Person, TabState } from '../types';
import { formatSize, getFolderStats, getFolderPreviewImages } from '../utils/mockFileSystem';
import { Tag, Link, HardDrive, FileText, Globe, FolderOpen, Copy, X, MoreHorizontal, Folder as FolderIcon, Calendar, Clock, PieChart, Edit3, Check, Save, Search, ChevronDown, ChevronRight, Scan, Sparkles, Smile, User, Languages, Book, Film, Folder, ExternalLink, Image as ImageIcon, Palette as PaletteIcon, Trash2 } from 'lucide-react';
import { Folder3DIcon } from './FileGrid';

interface MetadataProps {
  files: Record<string, FileNode>;
  selectedFileIds: string[];
  people?: Record<string, Person>;
  selectedPersonIds?: string[];
  onUpdate: (id: string, updates: Partial<FileNode>) => void;
  onUpdatePerson?: (id: string, updates: Partial<Person>) => void;
  onNavigateToFolder: (folderId: string) => void;
  onNavigateToTag: (tag: string) => void;
  onSearch: (query: string) => void;
  t: (key: string) => string;
  activeTab: TabState;
}

// Image Preview Component for Tauri
const ImagePreview = ({ file }: { file: FileNode }) => {
  const [imageUrl, setImageUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    const loadImage = async () => {
      if (!file.path) {
        setImageUrl('');
        setIsLoading(false);
        return;
      }
      
      setIsLoading(true);
      try {
        // Use getThumbnail for preview (smaller, faster)
        const { getThumbnail } = await import('../api/tauri-bridge');
        const dataUrl = await getThumbnail(file.path);
        if (dataUrl) {
          setImageUrl(dataUrl);
        } else {
          setImageUrl('');
        }
      } catch (error) {
        console.error('Failed to load preview image:', error);
        setImageUrl('');
      } finally {
        setIsLoading(false);
      }
    };
    
    loadImage();
  }, [file.path, file.id]);
  
  return (
    <div className="flex flex-col items-center">
      <div className="w-full rounded-lg overflow-hidden bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-800 flex justify-center items-center p-2 mb-2 shadow-sm min-h-[200px]">
        {isLoading ? (
          <div className="flex items-center justify-center">
            <ImageIcon className="animate-pulse text-gray-400" size={32} />
          </div>
        ) : imageUrl ? (
          <img src={imageUrl} className="max-w-full max-h-[300px] object-contain rounded" alt={file.name} />
        ) : (
          <div className="flex items-center justify-center">
            <ImageIcon className="text-gray-400" size={32} />
          </div>
        )}
      </div>
    </div>
  );
};

const extractPalette = async (url: string): Promise<string[]> => {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = url;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if(!ctx) return resolve([]);
            
            // Scale down for performance
            const maxDim = 128;
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(img, 0, 0, w, h);
            
            try {
                const data = ctx.getImageData(0, 0, w, h).data;
                const colorCounts: Record<string, number> = {};
                
                // Quantize more aggressively to group noise/gradients (Bin size 16)
                const quantization = 16;
                
                for(let i=0; i<data.length; i+=4) {
                    const r = data[i];
                    const g = data[i+1];
                    const b = data[i+2];
                    const a = data[i+3];
                    
                    if(a < 128) continue; // Ignore transparent

                    // Center the quantized value
                    const qr = Math.floor(r / quantization) * quantization + quantization/2;
                    const qg = Math.floor(g / quantization) * quantization + quantization/2;
                    const qb = Math.floor(b / quantization) * quantization + quantization/2;
                    
                    // Clamp to 0-255
                    const fqr = Math.min(255, Math.max(0, qr));
                    const fqg = Math.min(255, Math.max(0, qg));
                    const fqb = Math.min(255, Math.max(0, qb));
                    
                    const key = `${Math.floor(fqr)},${Math.floor(fqg)},${Math.floor(fqb)}`;
                    colorCounts[key] = (colorCounts[key] || 0) + 1;
                }
                
                // Sort by frequency
                const sorted = Object.entries(colorCounts)
                    .map(([key, count]) => {
                        const [r,g,b] = key.split(',').map(Number);
                        return { 
                            r, g, b, count, 
                            hex: `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}` 
                        };
                    })
                    .sort((a,b) => b.count - a.count);
                
                const finalPalette: typeof sorted = [];
                
                const getDist = (c1: typeof sorted[0], c2: typeof sorted[0]) => {
                    return Math.sqrt((c1.r-c2.r)**2 + (c1.g-c2.g)**2 + (c1.b-c2.b)**2);
                };

                // Perceived luminance
                const getLuma = (c: typeof sorted[0]) => (c.r*0.299 + c.g*0.587 + c.b*0.114);
                
                // Is the color effectively "black" or very dark gray?
                const isDark = (c: typeof sorted[0]) => getLuma(c) < 45;

                const addColor = (candidate: typeof sorted[0], distanceThreshold: number) => {
                     // 1. Distance Check
                     if (finalPalette.some(p => getDist(p, candidate) < distanceThreshold)) return false;
                     
                     // 2. Dark Color Limiter (Max 2 dark colors allowed)
                     if (isDark(candidate)) {
                         const existingDarkCount = finalPalette.filter(p => isDark(p)).length;
                         if (existingDarkCount >= 2) return false; 
                     }
                     
                     finalPalette.push(candidate);
                     return true;
                };

                // Pass 1: Strict (Diversity priority). Distance ~45 is significant.
                // e.g., (30,30,30) vs (60,60,60) is dist ~52. 
                for (const c of sorted) {
                    if (finalPalette.length >= 8) break;
                    addColor(c, 45);
                }
                
                // Pass 2: Relax slightly only if we have very few colors
                if (finalPalette.length < 5) {
                    for (const c of sorted) {
                        if (finalPalette.length >= 8) break;
                        addColor(c, 30);
                    }
                }
                
                // We DO NOT force 8 colors. If we only found 4 distinct ones, we return 4.

                resolve(finalPalette.map(p => p.hex));
                
            } catch(e) {
                console.error("Pixel access failed", e);
                resolve([]);
            }
        };
        img.onerror = () => resolve([]);
    });
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
                    <div className="flex-1 mx-3 h-2 bg-gray-100 dark:bg-gray-700/50 rounded-full overflow-hidden">
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

export const MetadataPanel: React.FC<MetadataProps> = ({ selectedFileIds, files, people, selectedPersonIds, onUpdate, onUpdatePerson, onNavigateToFolder, onNavigateToTag, onSearch, t, activeTab }) => {
  const isMulti = selectedFileIds.length > 1;
  const file = !isMulti && selectedFileIds.length === 1 ? files[selectedFileIds[0]] : null;
  const person = selectedPersonIds && selectedPersonIds.length === 1 && people ? people[selectedPersonIds[0]] : null;

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [source, setSource] = useState('');
  
  const [personName, setPersonName] = useState('');
  const [personDesc, setPersonDesc] = useState('');
  const [originalPersonName, setOriginalPersonName] = useState('');
  const [originalPersonDesc, setOriginalPersonDesc] = useState('');
  const [showSavedPerson, setShowSavedPerson] = useState(false);
  
  const [batchDesc, setBatchDesc] = useState('');
  const [batchSource, setBatchSource] = useState('');
  const [isDescMixed, setIsDescMixed] = useState(false);
  const [isSourceMixed, setIsSourceMixed] = useState(false);

  const [showSavedDesc, setShowSavedDesc] = useState(false);
  const [showSavedSource, setShowSavedSource] = useState(false);

  const [newTagInput, setNewTagInput] = useState('');
  const [toast, setToast] = useState<{msg: string, visible: boolean}>({ msg: '', visible: false });
  const [paletteMenu, setPaletteMenu] = useState<{ visible: boolean, x: number, y: number, color: string | null }>({ visible: false, x: 0, y: 0, color: null });
  
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
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const personDescRef = useRef<HTMLTextAreaElement>(null);
  
  // Cache to prevent infinite re-extraction loops for the same file ID
  const extractedCache = useRef<Set<string>>(new Set());

  const systemTags = useMemo(() => {
    const tags = new Set<string>();
    Object.values(files).forEach((f: FileNode) => f.tags.forEach(tag => tags.add(tag)));
    return Array.from(tags).sort();
  }, [files]);

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
           // In Tauri, we need to read the file as base64 first
           (async () => {
             try {
               const { readFileAsBase64 } = await import('../api/tauri-bridge');
               const dataUrl = await readFileAsBase64(file.path!);
               if (dataUrl) {
                 const palette = await extractPalette(dataUrl);
                 if (palette && palette.length > 0) {
                   onUpdate(file.id, {
                     meta: { ...file.meta!, palette }
                   });
                 }
               }
             } catch (err) {
               console.error('Failed to extract palette:', err);
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
  }, [file?.id, selectedFileIds, isMulti, files, person?.id, onUpdate]);

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
  }, [file]);

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

  const folderPreviewImages = useMemo(() => {
    if (file && file.type === FileType.FOLDER) {
        return getFolderPreviewImages(files, file.id, 3);
    }
    return [];
  }, [file, files]);

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
          onUpdatePerson(person.id, { name: personName, description: personDesc });
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

  if (person) {
      const coverFile = files[person.coverFileId];
      // Note: In Tauri, file.url and file.previewUrl are file paths, not usable URLs
      const coverUrl = null; // Disabled in Tauri - would need to load thumbnail separately

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
                       person.faceBox ? (
                          <div 
                              className="w-full h-full transition-transform duration-300 group-hover:scale-110"
                              style={{
                                  backgroundImage: `url("${coverUrl}")`,
                                  backgroundSize: `${10000 / Math.min(person.faceBox.w, 99.9)}% ${10000 / Math.min(person.faceBox.h, 99.9)}%`,
                                  backgroundPosition: `${person.faceBox.x / (100 - Math.min(person.faceBox.w, 99.9)) * 100}% ${person.faceBox.y / (100 - Math.min(person.faceBox.h, 99.9)) * 100}%`,
                                  backgroundRepeat: 'no-repeat'
                              }}
                           />
                       ) : (
                           <img 
                               src={coverUrl} 
                               className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                           />
                       )
                    ) : (
                       <div className="w-full h-full flex items-center justify-center text-gray-400"><User size={32}/></div>
                    )}
                </div>

                {/* Name Input */}
                <div className="w-full max-w-[200px] relative group mb-4">
                    <input 
                      value={personName}
                      onChange={(e) => setPersonName(e.target.value)}
                      onBlur={handleUpdatePersonMeta}
                      className="text-2xl font-bold text-center text-gray-800 dark:text-white bg-transparent border-b border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 focus:outline-none w-full py-1 transition-all"
                      placeholder={t('context.enterNewPersonName')}
                    />
                    <Edit3 size={14} className="absolute right-0 top-1/2 -translate-y-1/2 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center px-4 py-2 bg-white/80 dark:bg-gray-800/80 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm backdrop-blur-sm min-w-[90px]">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-bold tracking-wider mb-0.5">{t('context.files')}</span>
                        <span className="text-lg font-mono font-bold text-blue-600 dark:text-blue-400">{person.count}</span>
                    </div>
                    <div className="flex flex-col items-center px-4 py-2 bg-white/80 dark:bg-gray-800/80 rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm backdrop-blur-sm min-w-[90px]">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-bold tracking-wider mb-0.5">{t('meta.size')}</span>
                        <span className="text-lg font-mono font-bold text-purple-600 dark:text-purple-400">{personStats ? formatSize(personStats.totalSize) : '-'}</span>
                    </div>
                </div>
             </div>
          </div>

          <div className="p-5 space-y-6 flex-1">
              {/* Description Card */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden flex flex-col">
                  <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between">
                     <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center">
                        <FileText size={14} className="mr-1.5"/> {t('meta.description')}
                     </div>
                     {showSavedPerson && <span className="text-green-500 flex items-center text-[10px] animate-fade-in"><Check size={12} className="mr-1"/>{t('meta.saved')}</span>}
                  </div>
                  <div className="p-0">
                      <textarea
                          ref={personDescRef}
                          value={personDesc}
                          onChange={(e) => setPersonDesc(e.target.value)}
                          onBlur={handleUpdatePersonMeta}
                          placeholder={t('meta.addDesc')}
                          className="w-full bg-transparent border-none p-4 text-sm text-gray-700 dark:text-gray-300 resize-none focus:ring-0 leading-relaxed min-h-[200px]"
                      />
                  </div>
                  <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800/30 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2">
                      <button
                          onClick={handleUpdatePersonMeta}
                          className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded shadow-sm transition-colors flex items-center"
                      >
                          <Save size={12} className="mr-1.5"/> {t('meta.save')}
                      </button>
                  </div>
              </div>

              {/* Danger Zone */}
              <div className="pt-6 mt-2">
                  <button className="w-full flex items-center justify-center px-4 py-3 bg-white dark:bg-gray-800 border border-red-200 dark:border-red-900/30 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 hover:border-red-300 dark:hover:border-red-900/50 rounded-xl transition-all text-sm font-medium group shadow-sm">
                      <Trash2 size={16} className="mr-2 group-hover:scale-110 transition-transform"/>
                      {t('context.deletePerson')}
                  </button>
              </div>
          </div>
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
    <div className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-y-auto custom-scrollbar relative">
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
             <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                    <PieChart size={12} className="mr-1.5" /> {t('meta.typeDistribution')}
                </div>
                <DistributionChart data={batchChartData} totalFiles={selectedFileIds.length} />
                
                {/* Total Files Summary */}
                <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-3 mt-3 border-t border-gray-100 dark:border-gray-700">
                    <span>{t('meta.totalFiles')}</span>
                    <span className="font-bold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">{selectedFileIds.length}</span>
                </div>
            </div>
        )}

        {/* Large Preview Image (Single Image Only) */}
        {!isMulti && file && file.type === FileType.IMAGE && (
            <ImagePreview file={file} />
        )}

        {/* Color Palette (8 Card Grid) */}
        {!isMulti && file && file.type === FileType.IMAGE && colors.length > 0 && (
            <div>
                <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center">
                    <PaletteIcon size={12} className="mr-1.5"/> {t('meta.palette')}
                </div>
                <div className="grid grid-cols-4 gap-2">
                    {colors.slice(0, 8).map((color, i) => (
                        <div 
                            key={i} 
                            className="h-8 rounded-md cursor-pointer hover:scale-105 transition-transform shadow-sm ring-1 ring-black/10 dark:ring-white/10 relative group flex items-center justify-center overflow-hidden"
                            style={{ backgroundColor: color }}
                            onClick={() => onSearch(`color:${color.replace('#', '')}`)}
                            onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                // 计算菜单宽度（根据菜单项内容估算）
                                const menuWidth = 180;
                                // 对于最右边一列的色块（索引3和7），将菜单显示在鼠标左边
                                const isRightmostColumn = i === 3 || i === 7; // 4列网格，第4列索引为3和7
                                const x = isRightmostColumn ? e.clientX - menuWidth : e.clientX;
                                setPaletteMenu({ visible: true, x, y: e.clientY, color });
                            }}
                            title={color}
                        >
                             <span className="text-[9px] font-mono font-bold text-white/90 opacity-0 group-hover:opacity-100 bg-black/30 px-1 py-0.5 rounded backdrop-blur-sm transition-opacity">
                                {color.toUpperCase()}
                             </span>
                        </div>
                    ))}
                </div>
            </div>
        )}
        
        {/* Folder Thumbnail */}
        {!isMulti && file && file.type === FileType.FOLDER && (
            <div className="flex flex-col">
                <div className="w-full rounded-lg overflow-hidden bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-800 flex justify-center items-center py-8 mb-4 shadow-sm relative group">
                    <div className="w-24 h-24">
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
                    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
                        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                            <PieChart size={12} className="mr-1.5" /> {t('meta.fileDistribution')}
                        </div>
                        <DistributionChart data={chartData} totalFiles={folderDetails.totalFiles + folderDetails.subFolderCount} />
                        
                        {/* Total Files Summary */}
                        <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-3 mt-3 border-t border-gray-100 dark:border-gray-700">
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
                    <div className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider mb-3 flex items-center">
                        <Sparkles size={12} className="mr-1.5"/> {t('meta.aiSection')}
                    </div>
                    
                    {isMulti ? (
                        // Multi-selection AI analysis summary
                        <div className="space-y-3">
                            {/* Count of files with AI data */}
                            <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
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
                                        <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                            <div className="text-gray-400 text-xs mb-2 flex items-center">
                                                <span className="mr-1.5">{t('meta.aiScene')}</span>
                                                <span className="text-gray-500">({sceneCategories.size} {t('context.items')})</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Array.from(sceneCategories.entries())
                                                    .sort(([, a], [, b]) => b - a)
                                                    .slice(0, 8)
                                                    .map(([category, count]) => (
                                                        <span key={category} className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-[10px] rounded border border-gray-200 dark:border-gray-600 flex items-center">
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
                                        <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                            <div className="text-gray-400 text-xs mb-2 flex items-center">
                                                <span className="mr-1.5">{t('meta.aiFaces')}</span>
                                                <span className="text-gray-500">({faceNames.size} {t('context.items')})</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Array.from(faceNames)
                                                    .sort()
                                                    .slice(0, 8)
                                                    .map(name => (
                                                        <span key={name} className="px-2 py-1 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 text-[10px] rounded border border-purple-100 dark:border-purple-900/30 flex items-center">
                                                            {name}
                                                        </span>
                                                    ))}
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
                                        <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                            <div className="text-gray-400 text-xs mb-2 flex items-center">
                                                <span className="mr-1.5">{t('meta.aiObjects')}</span>
                                                <span className="text-gray-500">({objects.size} {t('context.items')})</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {Array.from(objects.entries())
                                                    .sort(([, a], [, b]) => b - a)
                                                    .slice(0, 12)
                                                    .map(([obj, count]) => (
                                                        <span key={obj} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[10px] rounded border border-gray-200 dark:border-gray-700 flex items-center">
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
                            
                            {/* Clear All AI Data Button */}
                            <div className="mt-2 pt-3 border-t border-gray-200 dark:border-gray-800 flex justify-end">
                                <button 
                                    onClick={() => {
                                        selectedFileIds.forEach(id => {
                                            if (files[id]?.aiData) {
                                                onUpdate(id, { aiData: undefined });
                                            }
                                        });
                                    }} 
                                    className="flex items-center px-3 py-1.5 bg-red-600 dark:bg-red-500 hover:bg-red-700 dark:hover:bg-red-400 text-white rounded-md font-medium transition-colors text-sm"
                                    title={t('meta.clearAllAiData')}
                                >
                                    <X size={12} className="mr-1.5"/> {t('meta.clearAll')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        // Single file AI analysis details
                        file && file.aiData && (
                            <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                        <div className="text-gray-400 mb-1">{t('meta.aiScene')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{file.aiData.sceneCategory}</div>
                                    </div>
                                    <div className="bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                        <div className="text-gray-400 mb-1">{t('meta.aiConfidence')}</div>
                                        <div className="font-medium text-gray-800 dark:text-gray-200">{Math.round(file.aiData.confidence * 100)}%</div>
                                    </div>
                                </div>

                                {file.aiData.faces.length > 0 && (
                                    <div>
                                        <div className="text-[10px] text-gray-400 font-bold mb-1.5 flex items-center"><Smile size={10} className="mr-1"/> {t('meta.aiFaces')}</div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {file.aiData.faces.map(face => (
                                                <div key={face.id} className="flex items-center bg-white dark:bg-gray-800 px-2 py-1 rounded-full border border-purple-100 dark:border-purple-900/30 text-xs shadow-sm">
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
                                                <span key={obj} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-[10px] rounded border border-gray-200 dark:border-gray-700">
                                                    {obj}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {file.aiData.extractedText && (
                                    <div className="mt-2 bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                        <div className="text-[10px] text-gray-400 font-bold mb-1 flex items-center">
                                            <FileText size={10} className="mr-1"/> {t('meta.aiExtractedText')}
                                        </div>
                                        <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{file.aiData.extractedText}</p>
                                    </div>
                                )}

                                {file.aiData.translatedText && (
                                    <div className="mt-2 bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-700">
                                        <div className="text-[10px] text-gray-400 font-bold mb-1 flex items-center">
                                            <Languages size={10} className="mr-1"/> {t('meta.aiTranslatedText')}
                                        </div>
                                        <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{file.aiData.translatedText}</p>
                                    </div>
                                )}
                                
                                {/* Clear AI Data Button */}
                                <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-800 flex justify-end">
                                    <button 
                                        onClick={() => onUpdate(file.id, { aiData: undefined })} 
                                        className="flex items-center px-3 py-1.5 bg-red-600 dark:bg-red-500 hover:bg-red-700 dark:hover:bg-red-400 text-white rounded-md font-medium transition-colors text-sm"
                                        title={t('meta.clearAiData')}
                                    >
                                        <X size={12} className="mr-1.5"/> {t('meta.clear')}
                                    </button>
                                </div>
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
                        onNavigateToFolder(file.parentId);
                    }
                }}
                className={`w-full flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-colors border border-gray-200 dark:border-gray-700 group ${activeTab.viewMode === 'browser' && activeTab.folderId === file.parentId ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-50' : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200'}`}
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
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5">{t('meta.format')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{file.meta.format.toUpperCase()}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5">{t('meta.size')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{formatSize(file.meta.sizeKb)}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5">{t('meta.dimensions')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{file.meta.width} x {file.meta.height}</div>
                            </div>
                        </>
                    )}
                    {file.type === FileType.FOLDER && folderStats && (
                        <>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5">{t('context.files')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{folderStats.fileCount}</div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 mb-0.5">{t('meta.totalSize')}</div>
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
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md py-2 px-3 text-sm text-gray-700 dark:text-gray-300 focus:ring-2 ring-blue-500/50 placeholder-gray-400 focus:border-blue-500 outline-none transition-all"
                    />
                    {newTagInput && (
                        <button 
                            onClick={() => handleAddTag(newTagInput)}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                        >
                            <Check size={12}/>
                        </button>
                    )}
                    
                    {/* Tag Autocomplete Suggestions */}
                    {newTagInput && systemTags.filter(t => t.toLowerCase().includes(newTagInput.toLowerCase()) && !file?.tags?.includes(t)).length > 0 && (
                         <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10 max-h-32 overflow-y-auto">
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
                        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300 resize-none focus:ring-2 ring-blue-500/50 min-h-[80px] leading-relaxed outline-none transition-all focus:border-blue-500"
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
            <div className="flex items-center bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 focus-within:ring-2 focus-within:ring-blue-500/50 transition-all focus-within:border-blue-500">
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
                      onClick={() => window.electron?.openExternal(isMulti ? batchSource : source)}
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
                                    onClick={() => f.sourceUrl && window.electron?.openExternal(f.sourceUrl)}
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
             className="fixed bg-white dark:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 z-[70] animate-zoom-in"
             style={{ top: paletteMenu.y, left: paletteMenu.x }}
          >
              <div 
                 className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center"
                 onClick={() => {
                     copyToClipboard(paletteMenu.color!);
                     setPaletteMenu({ ...paletteMenu, visible: false });
                 }}
              >
                  <Copy size={14} className="mr-2 opacity-70"/> {t('context.copyColor')}
              </div>
              <div 
                 className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center"
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

      {/* Toast */}
      {toast.visible && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black/80 text-white text-xs px-3 py-1.5 rounded-full shadow-lg z-50 pointer-events-none animate-toast-up">
              {toast.msg}
          </div>
      )}

      {/* Backdrop for palette menu */}
      {paletteMenu.visible && (
          <div className="fixed inset-0 z-[69]" onClick={() => setPaletteMenu({...paletteMenu, visible: false})}></div>
      )}
    </div>
  );
};