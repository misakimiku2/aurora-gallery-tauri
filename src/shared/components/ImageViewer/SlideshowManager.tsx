import React, { useEffect, useRef } from 'react';
import { TransitionType } from '../../hooks/useSlideshow';

export interface SlideshowManagerProps {
  currentUrl: string;
  prevUrl: string;
  isTransitioning: boolean;
  transition: TransitionType;
  enableZoom: boolean;
  onTransitionEnd: () => void;
  currentTransform?: string;
  prevTransform?: string;
  imageName?: string;
}

const TRANSITION_DURATION = 600;

export const SlideshowManager: React.FC<SlideshowManagerProps> = ({
  currentUrl,
  prevUrl,
  isTransitioning,
  transition,
  enableZoom,
  onTransitionEnd,
  currentTransform = 'none',
  prevTransform = 'none',
  imageName = '',
}) => {
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (isTransitioning && transition !== 'none') {
      transitionTimerRef.current = setTimeout(() => {
        onTransitionEnd();
      }, TRANSITION_DURATION);
    }

    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, [isTransitioning, transition, onTransitionEnd]);

  const getTransitionClass = (isPrev: boolean): string => {
    if (!isTransitioning || transition === 'none') return '';
    
    if (isPrev) {
      switch (transition) {
        case 'fade':
          return 'animate-slideshow-fade-out';
        case 'slide':
          return 'animate-slideshow-slide-out';
        default:
          return '';
      }
    } else {
      switch (transition) {
        case 'fade':
          return 'animate-slideshow-fade-in';
        case 'slide':
          return 'animate-slideshow-slide-in';
        default:
          return '';
      }
    }
  };

  const kenBurnsClass = enableZoom && !isTransitioning ? 'animate-ken-burns' : '';

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-none relative overflow-hidden">
      {prevUrl && isTransitioning && (
        <img
          key={`prev-${prevUrl}`}
          src={prevUrl}
          alt=""
          className={`max-w-none absolute inset-0 m-auto ${getTransitionClass(true)}`}
          loading="eager"
          decoding="sync"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
            zIndex: 1,
            transform: transition === 'fade' ? prevTransform : undefined,
          }}
          draggable={false}
        />
      )}

      <img
        key={`current-${currentUrl}`}
        src={currentUrl}
        alt={imageName}
        className={`max-w-none absolute inset-0 m-auto ${kenBurnsClass} ${getTransitionClass(false)}`}
        loading="eager"
        decoding="sync"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          pointerEvents: 'none',
          transformOrigin: 'center center',
          zIndex: 2,
        }}
        draggable={false}
      />
    </div>
  );
};

export default SlideshowManager;
