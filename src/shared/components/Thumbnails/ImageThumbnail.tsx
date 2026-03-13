import React, { useState, useEffect } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { useInView } from '../../hooks/useInView';
import { ImageApi } from '../../api/types';

const thumbnailCache = new Map<string, string>();

export interface ImageThumbnailProps {
  path: string;
  alt: string;
  api: ImageApi;
  width?: number;
  height?: number;
  className?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

export const ImageThumbnail: React.FC<ImageThumbnailProps> = ({
  path,
  alt,
  api,
  width,
  height,
  className = '',
  onClick,
  onDoubleClick,
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '400px' });
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() => {
    return thumbnailCache.get(path) || null;
  });
  const [loading, setLoading] = useState(!thumbnailCache.has(path));
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isInView && !wasInView) return;
    
    if (thumbnailCache.has(path)) {
      setThumbnailSrc(thumbnailCache.get(path) || null);
      setLoading(false);
      return;
    }

    const url = api.getThumbnailUrl(path);
    const urlStr = typeof url === 'string' ? url : null;
    
    if (urlStr) {
      thumbnailCache.set(path, urlStr);
      setThumbnailSrc(urlStr);
    }
  }, [path, api, isInView, wasInView]);

  return (
    <div
      ref={ref}
      className={`w-full h-full relative overflow-hidden cursor-pointer ${className}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
        {loading && !thumbnailSrc && !error && (
          <ImageIcon className="text-gray-400 dark:text-gray-600 animate-pulse" size={24} />
        )}
        {error && (
          <ImageIcon className="text-gray-400 dark:text-gray-600" size={24} />
        )}
        {thumbnailSrc && !error && (
          <img
            src={thumbnailSrc}
            alt={alt}
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
            style={{ opacity: loading ? 0 : 1 }}
            loading="lazy"
            draggable="false"
            onLoad={() => setLoading(false)}
            onError={() => setError(true)}
          />
        )}
      </div>
      {width && height && (
        <div className="absolute bottom-1 right-1 text-[9px] bg-black/60 text-white px-1 rounded shadow-sm">
          {width}x{height}
        </div>
      )}
    </div>
  );
};

export default ImageThumbnail;
