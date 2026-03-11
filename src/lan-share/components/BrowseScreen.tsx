import React, { useState, useEffect, useRef, useMemo } from 'react';
import { BrowseItem, lanShareApi } from '../api';

interface BrowseScreenProps {
  currentPath: string;
  folders: BrowseItem[];
  images: BrowseItem[];
  token: string;
  allowEdit: boolean;
  onNavigate: (path: string) => void;
  onViewImage: (image: BrowseItem, index: number) => void;
  onLogout: () => void;
}

const BrowseScreen: React.FC<BrowseScreenProps> = ({
  currentPath,
  folders,
  images,
  token,
  allowEdit,
  onNavigate,
  onViewImage,
  onLogout,
}) => {
  const [deviceCount, setDeviceCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 50 });

  useEffect(() => {
    lanShareApi.getDevices(token).then(data => {
      setDeviceCount(data.devices?.length || 0);
    }).catch(console.error);
  }, [token]);

  const pathParts = useMemo(() => {
    const parts = currentPath.split('/').filter(p => p);
    let accPath = '';
    return parts.map(part => {
      accPath += '/' + part;
      return { name: part, path: accPath };
    });
  }, [currentPath]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, clientHeight } = containerRef.current;
    const itemHeight = 180;
    const columns = Math.floor(containerRef.current.clientWidth / 180) || 1;
    const start = Math.floor(scrollTop / itemHeight) * columns;
    const end = start + Math.ceil(clientHeight / itemHeight) * columns + columns * 2;
    setVisibleRange({ start: Math.max(0, start), end: Math.min(images.length, end) });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      handleScroll();
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [images.length]);

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-gray-900">
      <header className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between shrink-0 z-30">
        <div className="flex items-center gap-2 overflow-hidden">
          <svg className="w-5 h-5 text-blue-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span className="font-medium truncate text-gray-900 dark:text-white">
            {currentPath === '/' || currentPath === '' ? 'Aurora Gallery' : currentPath}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {deviceCount} 个设备在线
          </span>
          <button
            onClick={onLogout}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-white rounded-lg transition-colors"
          >
            退出
          </button>
        </div>
      </header>

      <nav className="flex items-center gap-1 px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 overflow-x-auto shrink-0">
        <button
          onClick={() => onNavigate('/')}
          className={`px-2 py-1 text-sm rounded hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0 ${
            pathParts.length === 0 ? 'text-blue-500 font-medium' : 'text-gray-600 dark:text-gray-400'
          }`}
        >
          根目录
        </button>
        {pathParts.map((part, index) => (
          <React.Fragment key={part.path}>
            <span className="text-gray-400 dark:text-gray-600">/</span>
            <button
              onClick={() => onNavigate(part.path)}
              className={`px-2 py-1 text-sm rounded hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0 ${
                index === pathParts.length - 1 ? 'text-blue-500 font-medium' : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              {part.name}
            </button>
          </React.Fragment>
        ))}
      </nav>

      <main ref={containerRef} className="flex-1 overflow-y-auto p-4">
        {folders.length > 0 && (
          <section className="mb-6">
            <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
              文件夹 ({folders.length})
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
              {folders.map(folder => (
                <button
                  key={folder.path}
                  onClick={() => onNavigate(folder.path)}
                  className="flex flex-col items-center gap-2 p-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 
                    rounded-lg border border-gray-200 dark:border-gray-700 transition-all duration-200
                    hover:border-blue-300 dark:hover:border-blue-600 group"
                >
                  <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <svg className="w-6 h-6 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                    </svg>
                  </div>
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate w-full text-center">{folder.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {images.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
              图片 ({images.length})
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
              {images.slice(visibleRange.start, visibleRange.end).map((image, idx) => {
                const actualIndex = visibleRange.start + idx;
                return (
                  <ImageCard
                    key={image.path}
                    image={image}
                    token={token}
                    onClick={() => onViewImage(image, actualIndex)}
                  />
                );
              })}
            </div>
          </section>
        )}

        {folders.length === 0 && images.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
            <svg className="w-16 h-16 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <p className="text-lg">此文件夹为空</p>
          </div>
        )}
      </main>
    </div>
  );
};

interface ImageCardProps {
  image: BrowseItem;
  token: string;
  onClick: () => void;
}

const ImageCard: React.FC<ImageCardProps> = ({ image, token, onClick }) => {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && imgRef.current) {
            imgRef.current.src = lanShareApi.getThumbnailUrl(image.path, token);
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '100px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, [image.path, token]);

  return (
    <button
      onClick={onClick}
      className="relative aspect-square bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden 
        border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-all duration-200
        hover:shadow-lg group"
    >
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200 dark:bg-gray-700">
          <svg className="w-8 h-8 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
      ) : (
        <img
          ref={imgRef}
          alt={image.name}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/70 to-transparent">
        <p className="text-xs text-white truncate">{image.name}</p>
      </div>
    </button>
  );
};

export default BrowseScreen;
