import React, { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw, Share2, Trash2, Info } from 'lucide-react';
import { AndroidImageInfo } from '../types';

interface MobileImageViewerProps {
  image: AndroidImageInfo;
  imageUrl: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  currentIndex: number;
  totalCount: number;
}

export function MobileImageViewer({
  image,
  imageUrl,
  onClose,
  onPrev,
  onNext,
  currentIndex,
  totalCount,
}: MobileImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          onPrev?.();
          break;
        case 'ArrowRight':
          onNext?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onPrev, onNext]);

  const handleZoomIn = () => {
    setScale(prev => Math.min(prev * 1.5, 5));
  };

  const handleZoomOut = () => {
    setScale(prev => Math.max(prev / 1.5, 0.5));
  };

  const handleRotate = () => {
    setRotation(prev => (prev + 90) % 360);
  };

  const handleReset = () => {
    setScale(1);
    setRotation(0);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartRef.current && e.changedTouches.length === 1) {
      const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x;
      const deltaY = e.changedTouches[0].clientY - touchStartRef.current.y;
      
      if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX > 0) {
          onPrev?.();
        } else {
          onNext?.();
        }
      }
    }
    touchStartRef.current = null;
  };

  const toggleControls = () => {
    setShowControls(prev => !prev);
  };

  return (
    <div className="mobile-viewer-overlay">
      {showControls && (
        <div className="mobile-viewer-header">
          <button className="back-btn" onClick={onClose}>
            <ChevronLeft size={24} />
          </button>
          <span className="title">{image.name}</span>
          <button className="close-btn" onClick={onClose}>
            <X size={24} />
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="mobile-viewer-content"
        onClick={toggleControls}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <img
          src={imageUrl}
          alt={image.name}
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            transition: 'transform 0.3s ease',
          }}
        />
      </div>

      {showControls && (
        <>
          {onPrev && (
            <button 
              className="mobile-viewer-nav prev" 
              onClick={(e) => { e.stopPropagation(); onPrev(); }}
            >
              <ChevronLeft size={32} />
            </button>
          )}
          {onNext && (
            <button 
              className="mobile-viewer-nav next" 
              onClick={(e) => { e.stopPropagation(); onNext(); }}
            >
              <ChevronRight size={32} />
            </button>
          )}

          <div className="mobile-viewer-footer">
            <button onClick={handleZoomOut}>
              <ZoomOut size={24} />
              <span>缩小</span>
            </button>
            <button onClick={handleZoomIn}>
              <ZoomIn size={24} />
              <span>放大</span>
            </button>
            <button onClick={handleRotate}>
              <RotateCw size={24} />
              <span>旋转</span>
            </button>
            <button onClick={handleReset}>
              <span style={{ fontSize: '18px' }}>1:1</span>
              <span>重置</span>
            </button>
          </div>

          <div style={{
            position: 'absolute',
            bottom: '80px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0, 0, 0, 0.5)',
            padding: '4px 12px',
            borderRadius: '12px',
            fontSize: '14px',
          }}>
            {currentIndex} / {totalCount}
          </div>
        </>
      )}
    </div>
  );
}

export default MobileImageViewer;
