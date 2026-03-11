import React, { useState, useEffect } from 'react';
import { BrowseItem, lanShareApi } from '../api';

interface ImageViewerProps {
  image: BrowseItem;
  currentIndex: number;
  totalCount: number;
  allowEdit: boolean;
  token: string;
  onClose: () => void;
  onNavigate: (direction: number) => void;
  onDelete: () => void;
}

const ImageViewer: React.FC<ImageViewerProps> = ({
  image,
  currentIndex,
  totalCount,
  allowEdit,
  token,
  onClose,
  onNavigate,
  onDelete,
}) => {
  const [loaded, setLoaded] = useState(false);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setLoaded(false);
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [image.path]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale(prev => Math.min(Math.max(prev + delta, 0.5), 5));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    if (scale === 1) {
      setScale(2);
    } else {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
      {/* Header */}
      <header className="h-14 bg-gray-900/80 backdrop-blur-sm border-b border-gray-800 flex items-center px-4 justify-between shrink-0">
        <button
          onClick={onClose}
          className="flex items-center gap-2 px-3 py-1.5 text-gray-300 hover:text-white 
            bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span>返回</span>
        </button>
        
        <span className="text-gray-300 truncate max-w-[50%] text-center text-sm">
          {image.name}
        </span>
        
        <div className="flex items-center gap-2">
          {allowEdit && (
            <button
              onClick={onDelete}
              className="px-3 py-1.5 text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors text-sm"
            >
              删除
            </button>
          )}
        </div>
      </header>

      {/* Main Image Area */}
      <main 
        className="flex-1 relative overflow-hidden flex items-center justify-center"
        onWheel={handleWheel}
      >
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 border-3 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        <img
          src={lanShareApi.getImageUrl(image.path, token)}
          alt={image.name}
          onLoad={() => setLoaded(true)}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          className={`max-w-full max-h-full object-contain transition-transform duration-200 select-none
            ${loaded ? 'opacity-100' : 'opacity-0'}
            ${isDragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : 'cursor-default'}`}
          style={{
            transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
          }}
          draggable={false}
        />

        {/* Navigation Buttons */}
        {currentIndex > 0 && (
          <button
            onClick={() => onNavigate(-1)}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center
              bg-white/10 hover:bg-white/20 rounded-full text-white text-2xl transition-colors"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        {currentIndex < totalCount - 1 && (
          <button
            onClick={() => onNavigate(1)}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center
              bg-white/10 hover:bg-white/20 rounded-full text-white text-2xl transition-colors"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </main>

      {/* Footer */}
      <footer className="h-12 bg-gray-900/80 backdrop-blur-sm border-t border-gray-800 flex items-center justify-center shrink-0">
        <span className="px-4 py-1.5 bg-gray-800 rounded-full text-sm text-gray-300">
          {currentIndex + 1} / {totalCount}
        </span>
      </footer>
    </div>
  );
};

export default ImageViewer;
