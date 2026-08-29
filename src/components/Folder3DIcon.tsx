import React, { useMemo, useState, useEffect } from 'react';
import { Book, Film, Folder, ImageIcon } from 'lucide-react';
import { getFolderTilesPng, isDarkTheme } from '../utils/folderTilesRenderer';

function isAndroid(): boolean {
  try {
    if (typeof window !== 'undefined' && (window as any).__TAURI__) {
      return (window as any).__TAURI_INTERNALS?.platform === 'android' || 
             typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
    }
    return false;
  } catch {
    return false;
  }
}

const _isAndroid = isAndroid();

const AndroidLightweight: React.FC<{ count?: number }> = ({ count }) => (
  <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-200 dark:from-gray-800 dark:to-gray-750">
    <Folder size={48} className="text-gray-400 dark:text-gray-500" strokeWidth={1.2} />
    {count !== undefined && count > 0 && (
      <div className="mt-1 flex items-center gap-0.5 text-gray-400 dark:text-gray-500">
        <ImageIcon size={10} />
        <span className="text-[10px]">{count}</span>
      </div>
    )}
  </div>
);

// 预合成 PNG hook：三张缩略图齐备时，把瓷砖+渐变+角标合成单张 PNG。
// 合成统一走 folderTilesRenderer 的全局串行队列（仅滚动空闲时执行、逐张让出主线程），
// 本 hook 只负责发起请求与在组件卸载时取消；主题/图源/数量/分类变化时自动重新请求。
const useTilesPng = (previewSrcs: string[] | undefined, count: number | undefined, category: string) => {
  const srcs = useMemo(() => (previewSrcs || []).filter(s => !!s).slice(0, 3), [previewSrcs]);
  const ready = srcs.length === 3; // 缺图时占位本身极廉价，无需合成
  const dark = isDarkTheme();
  const [pngUrl, setPngUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) {
      setPngUrl(null);
      return;
    }
    const controller = new AbortController();
    getFolderTilesPng(srcs, count, controller.signal, category).then(url => {
      if (!controller.signal.aborted) setPngUrl(url);
    });
    return () => controller.abort();
  }, [ready, srcs, count, dark, category]);

  return pngUrl;
};

// 简洁瓷砖拼贴图标：无文件夹外形，仅三张图片瓷砖（左大右二小）+ 底部渐变遮罩。
// 渲染策略：
//   - 三图拼贴是文件夹识别的基本形态，滚动中照常渲染（不降级为单图、不做
//     1图↔3图 的速度切换，避免闪烁）；
//   - 掉帧的真正来源是缩略图在卡片进入视口那一刻才现场生成/解码，由
//     FolderThumbnailPrefetcher 提前 1.2 屏预热解决（见 utils/folderThumbnailPrefetch.ts）；
//   - 预合成 PNG 就绪后整卡替换为单张 <img>（圆角/渐变/角标已合成进图内），
//     稳态下进一步降低光栅成本。
const FolderTilesIcon = ({ previewSrcs, count, category = 'general', className = "", onImageError }: { previewSrcs?: string[], count?: number, category?: string, className?: string, onImageError?: (index: number) => void }) => {
  const images = (previewSrcs || []).filter(src => !!src).slice(0, 3);
  const pngUrl = useTilesPng(previewSrcs, count, category);
  const placeholderShades = [
    'bg-gray-300 dark:bg-gray-600',
    'bg-gray-400 dark:bg-gray-500',
    'bg-gray-300/80 dark:bg-gray-600/80',
  ];
  // 分类渐变（参考经典 3D 文件夹颜色：常规=深色、图书=琥珀黄、视频=紫），
  // 与 folderTilesRenderer 的 CATEGORY_GRADIENT 数值一致。
  const gradientClasses: Record<string, string> = {
    general: 'from-black/55 via-black/20 to-transparent',
    book: 'from-amber-500/70 via-amber-400/30 to-transparent',
    sequence: 'from-purple-600/70 via-purple-500/30 to-transparent',
  };
  const gradient = gradientClasses[category] || gradientClasses.general;

  // 预合成 PNG 就绪：整卡只渲染一张 <img>（三图拼贴已合成进图内）
  if (pngUrl) {
    return (
      <div className={`relative w-full h-full group select-none flex items-center justify-center ${className}`}>
        <img
          src={pngUrl}
          className="folder-tiles-img w-full aspect-square rounded-lg shadow-sm transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
          decoding="async"
          draggable="false"
        />
      </div>
    );
  }

  const tileContent = (i: number) =>
    images[i] ? (
      <img
        src={images[i]}
        className="folder-tiles-img w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
        loading="lazy"
        decoding="async"
        draggable="false"
        onError={() => onImageError?.(i)}
      />
    ) : (
      <div className={`folder-tiles-img w-full h-full transition-transform duration-300 group-hover:scale-105 ${placeholderShades[i]}`} />
    );

  return (
    <div className={`relative w-full h-full group select-none flex items-center justify-center ${className}`}>
      <div className="relative w-full aspect-square rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 shadow-sm">
        {/* 三张瓷砖拼贴：左侧大图 + 右侧上下两张 */}
        <div className="absolute inset-0 flex gap-0.5">
          <div className="w-[62%] h-full overflow-hidden">
            {tileContent(0)}
          </div>
          <div className="flex-1 flex flex-col gap-0.5">
            <div className="flex-1 overflow-hidden">{tileContent(1)}</div>
            <div className="flex-1 overflow-hidden">{tileContent(2)}</div>
          </div>
        </div>

        {/* 底部渐变（随分类变色） */}
        <div className={`absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-t ${gradient} pointer-events-none`} />

        {/* 数量角标 */}
        {count !== undefined && count > 0 && (
          <div className="absolute bottom-1.5 right-2 z-10 bg-black/40 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full ring-1 ring-white/20 backdrop-blur-sm">
            {count}
          </div>
        )}
      </div>
    </div>
  );
};

export const Folder3DIcon = ({ previewSrcs, count, category = 'general', className = "", onImageError, variant = 'classic' }: { previewSrcs?: string[], count?: number, category?: string, className?: string, onImageError?: (index: number) => void, variant?: 'classic' | 'tiles' }) => {
  if (_isAndroid) {
    return <AndroidLightweight count={count} />;
  }

  if (variant === 'tiles') {
    return <FolderTilesIcon previewSrcs={previewSrcs} count={count} category={category} className={className} onImageError={onImageError} />;
  }

  const styles: any = {
    general: { back: 'text-blue-600 dark:text-blue-500', front: 'text-blue-400 dark:text-blue-400' },
    book: { back: 'text-amber-600 dark:text-amber-500', front: 'text-amber-400 dark:text-amber-400' },
    sequence: { back: 'text-purple-600 dark:text-purple-500', front: 'text-purple-400 dark:text-purple-400' },
  };
  const style = styles[category] || styles.general;
  
  const Icon = category === 'book' ? Book : (category === 'sequence' ? Film : Folder);

  // Use whatever valid URLs are passed (base64 or asset://)
  const images = (previewSrcs || []).filter(src => !!src);
  // 多张图（>=2）时，悬停改为"摊牌"式扇形展开，而不是整体平移
  const fan = images.length >= 2;

  // 每张图在「堆叠态」与「悬停摊开态」下的变换（索引对应 images[0]=前, [1]=中, [2]=后）
  const cardBase = [
    'rotate-0 scale-100',
    '-rotate-3 -translate-x-1 -translate-y-1.5 scale-95',
    'rotate-6 translate-x-2 -translate-y-3 scale-90 opacity-80',
  ];
  const cardHover = [
    // 前卡 -> 扇形右侧（小幅度，留在背景内）
    'group-hover:rotate-[14deg] group-hover:translate-x-[18%] group-hover:translate-y-[-4%] group-hover:scale-90 group-hover:opacity-100',
    // 中卡 -> 居中上抬
    'group-hover:rotate-0 group-hover:translate-x-0 group-hover:translate-y-[-10%] group-hover:scale-100 group-hover:opacity-100',
    // 后卡 -> 扇形左侧
    'group-hover:rotate-[-14deg] group-hover:translate-x-[-18%] group-hover:translate-y-[-4%] group-hover:scale-90 group-hover:opacity-100',
  ];
  
  return (
    <div className={`relative w-full h-full group select-none flex items-center justify-center ${className}`}>
      {/* Square container to maintain aspect ratio */}
      <div className="relative w-full aspect-square">
        {/* Back Plate */}
        <svg viewBox="0 0 100 100" className={`absolute w-full h-full drop-shadow-sm dark:drop-shadow-none transition-colors ${style.back}`} preserveAspectRatio="none">
          <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" fill="currentColor" />
        </svg>

        {/* Preview Images */}
        <div className="absolute left-[15%] right-[15%] top-[20%] bottom-[20%] z-10 transition-transform duration-300 group-hover:-translate-y-3 group-hover:scale-105">
          {images.length === 0 && (
            /* 占位矩形：无缩略图时用三张灰阶矩形模拟卡片堆叠，
               最前方为白色、越往后越灰，形成层次；缩略图生成后无缝替换。
               悬停时与真实三张缩略图一样扇形展开（cardBase + cardHover）。 */
            <>
              <div className={`absolute inset-0 shadow-md z-0 border-[2px] border-white rounded-sm transition-transform duration-300 ${cardBase[2]} ${cardHover[2]}`}>
                <div className="w-full h-full bg-gray-400 dark:bg-gray-600" />
              </div>
              <div className={`absolute inset-0 shadow-md z-10 border-[2px] border-white rounded-sm transition-transform duration-300 ${cardBase[1]} ${cardHover[1]}`}>
                <div className="w-full h-full bg-gray-300 dark:bg-gray-700" />
              </div>
              <div className={`absolute inset-0 shadow-md z-20 border-[2px] border-white rounded-sm transition-transform duration-300 ${cardBase[0]} ${cardHover[0]}`}>
                <div className="w-full h-full bg-white dark:bg-gray-500" />
              </div>
            </>
          )}
          {images[2] && (
            <div className={`absolute inset-0 bg-white shadow-md z-0 border-[2px] border-white rounded-sm overflow-hidden transition-transform duration-300 ${cardBase[2]} ${fan ? cardHover[2] : ''}`}>
              <img 
                src={images[2]} 
                className="w-full h-full object-cover" 
                loading="lazy" 
                decoding="async"
                draggable="false"
                onError={() => onImageError?.(2)}
              />
            </div>
          )}
          {images[1] && (
            <div className={`absolute inset-0 bg-white shadow-md z-10 border-[2px] border-white rounded-sm overflow-hidden transition-transform duration-300 ${cardBase[1]} ${fan ? cardHover[1] : ''}`}>
              <img 
                src={images[1]} 
                className="w-full h-full object-cover" 
                loading="lazy" 
                decoding="async"
                draggable="false"
                onError={() => onImageError?.(1)}
              />
            </div>
          )}
          {images[0] && (
            <div className={`absolute inset-0 bg-white shadow-md z-20 border-[2px] border-white rounded-sm overflow-hidden transition-transform duration-300 ${cardBase[0]} ${fan ? cardHover[0] : ''}`}>
              <img 
                src={images[0]} 
                className="w-full h-full object-cover" 
                loading="lazy" 
                decoding="async"
                draggable="false"
                onError={() => onImageError?.(0)}
              />
            </div>
          )}
        </div>

        {/* Front Plate */}
        <div 
          className="absolute left-0 right-0 bottom-0 h-[60%] z-20 transition-transform duration-300 origin-bottom"
          style={{ transform: 'perspective(800px) rotateX(-10deg)' }}
        >
          <svg viewBox="0 0 100 65" className={`w-full h-full drop-shadow-lg dark:drop-shadow-none ${style.front}`} preserveAspectRatio="none">
            <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" fill="currentColor" />
          </svg>
          
          <div className="absolute inset-0 flex items-center justify-center opacity-40 text-blue-900/70 dark:text-white/80">
            <Icon size={32} strokeWidth={1.5} />
          </div>

          {count !== undefined && (
            <div className="absolute bottom-2 right-3 bg-black/35 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full ring-1 ring-white/15">
              {count}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
