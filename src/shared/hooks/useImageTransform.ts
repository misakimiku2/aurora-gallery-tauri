import { useState, useRef, useCallback, useEffect } from 'react';

export interface ImageTransformState {
  scale: number;
  rotation: number;
  x: number;
  y: number;
}

export interface UseImageTransformOptions {
  minScale?: number;
  maxScale?: number;
  zoomSpeed?: number;
}

export interface UseImageTransformReturn {
  transform: ImageTransformState;
  isDragging: boolean;
  isWheeling: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  imgRef: React.RefObject<HTMLImageElement>;
  handleWheel: (e: WheelEvent) => void;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: () => void;
  handleDoubleClick: (e: React.MouseEvent) => void;
  handleMiddleClick: (e: React.MouseEvent) => void;
  reset: () => void;
  setScale: (scale: number) => void;
  setRotation: (rotation: number) => void;
  rotate: (deg: number) => void;
  animateTo: (targetScale: number, targetX: number, targetY: number, duration?: number) => void;
  toggleOriginalFit: (clientX?: number, clientY?: number) => void;
  fitToWindow: () => void;
  setToOriginalSize: () => void;
}

const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const useImageTransform = (
  options: UseImageTransformOptions = {}
): UseImageTransformReturn => {
  const {
    minScale = 0.01,
    maxScale = 15,
    zoomSpeed = 0.3,
  } = options;

  const [transform, setTransform] = useState<ImageTransformState>({
    scale: 1,
    rotation: 0,
    x: 0,
    y: 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isWheeling, setIsWheeling] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const transformRef = useRef(transform);
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const animationRef = useRef<number>();
  const dragRafRef = useRef<number>();
  const pendingPositionRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);

  transformRef.current = transform;

  const applyTransformToDOM = useCallback(() => {
    if (imgRef.current) {
      const { x, y, scale, rotation } = transformRef.current;
      imgRef.current.style.transform = `translate(${x}px, ${y}px) rotate(${rotation}deg) scale(${scale})`;
    }
  }, []);

  const animateTo = useCallback((
    targetScale: number,
    targetX: number,
    targetY: number,
    duration: number = 280,
    easing: 'smooth' | 'back' = 'smooth'
  ) => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    const startScale = transformRef.current.scale;
    const startX = transformRef.current.x;
    const startY = transformRef.current.y;
    const startRotation = transformRef.current.rotation;
    const startTime = performance.now();

    const ease = easing === 'back' ? easeOutBack : easeOutQuint;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = ease(progress);

      const newScale = startScale + (targetScale - startScale) * eased;
      const newX = startX + (targetX - startX) * eased;
      const newY = startY + (targetY - startY) * eased;

      transformRef.current = {
        scale: newScale,
        rotation: startRotation,
        x: newX,
        y: newY,
      };
      
      if (imgRef.current) {
        imgRef.current.style.transform = `translate(${newX}px, ${newY}px) rotate(${startRotation}deg) scale(${newScale})`;
      }
      
      setTransform({ scale: newScale, rotation: startRotation, x: newX, y: newY });

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    animationRef.current = requestAnimationFrame(animate);
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!imgRef.current || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const { naturalWidth, naturalHeight } = imgRef.current;
    if (!naturalWidth || !naturalHeight) return;

    const containerW = rect.width;
    const containerH = rect.height;
    const fitScale = Math.min(containerW / naturalWidth, containerH / naturalHeight);

    const currentScale = transformRef.current.scale;
    const currentPos = transformRef.current;

    const logicalW = naturalWidth * fitScale * currentScale;
    const logicalH = naturalHeight * fitScale * currentScale;
    const centerX = containerW / 2;
    const centerY = containerH / 2;

    const imgCenterX = centerX + currentPos.x;
    const imgCenterY = centerY + currentPos.y;

    const imgLeft = imgCenterX - logicalW / 2;
    const imgTop = imgCenterY - logicalH / 2;
    const imgRight = imgCenterX + logicalW / 2;
    const imgBottom = imgCenterY + logicalH / 2;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const anchorX = Math.min(Math.max(mouseX, imgLeft), imgRight);
    const anchorY = Math.min(Math.max(mouseY, imgTop), imgBottom);

    const direction = Math.sign(e.deltaY);
    let newScale = direction < 0 
      ? currentScale * (1 + zoomSpeed) 
      : currentScale / (1 + zoomSpeed);
    newScale = Math.max(minScale, Math.min(newScale, maxScale));

    const scaleFactor = newScale / currentScale;
    if (scaleFactor === 1) return;

    const vecX = anchorX - imgCenterX;
    const vecY = anchorY - imgCenterY;

    const targetX = currentPos.x + vecX * (1 - scaleFactor);
    const targetY = currentPos.y + vecY * (1 - scaleFactor);

    setIsWheeling(true);
    if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    wheelTimeoutRef.current = setTimeout(() => setIsWheeling(false), 350);

    animateTo(newScale, targetX, targetY, 280, 'smooth');
  }, [animateTo, zoomSpeed, minScale, maxScale]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      handleMiddleClick(e);
      return;
    }
    
    if (e.button !== 0) return;
    e.preventDefault();
    
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = undefined;
    }
    
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - transformRef.current.x,
      y: e.clientY - transformRef.current.y,
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    e.preventDefault();
    
    const newX = e.clientX - dragStartRef.current.x;
    const newY = e.clientY - dragStartRef.current.y;
    
    pendingPositionRef.current = { x: newX, y: newY };
    
    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        transformRef.current = {
          ...transformRef.current,
          x: pendingPositionRef.current.x,
          y: pendingPositionRef.current.y,
        };
        
        if (imgRef.current) {
          const { scale, rotation } = transformRef.current;
          imgRef.current.style.transform = `translate(${pendingPositionRef.current.x}px, ${pendingPositionRef.current.y}px) rotate(${rotation}deg) scale(${scale})`;
        }
        
        dragRafRef.current = undefined;
      });
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      
      if (dragRafRef.current) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = undefined;
      }
      
      setTransform({ ...transformRef.current });
    }
    setIsDragging(false);
  }, []);

  const getFitScale = useCallback((): number => {
    if (!imgRef.current || !containerRef.current) return 1;
    const { naturalWidth, naturalHeight } = imgRef.current;
    const rect = containerRef.current.getBoundingClientRect();
    return Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentScale = transformRef.current.scale;
    const fitScale = getFitScale();
    const originalScale = 1 / fitScale;
    
    const toOriginal = Math.abs(currentScale - originalScale) > Math.abs(currentScale - 1);
    
    if (toOriginal) {
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      const targetX = (centerX - mouseX) * (originalScale - 1);
      const targetY = (centerY - mouseY) * (originalScale - 1);
      
      animateTo(originalScale, targetX, targetY, 360, 'back');
    } else {
      animateTo(1, 0, 0, 260, 'smooth');
    }
  }, [animateTo, getFitScale]);

  const handleMiddleClick = useCallback((e: React.MouseEvent) => {
    toggleOriginalFit(e.clientX, e.clientY);
  }, []);

  const toggleOriginalFit = useCallback((clientX?: number, clientY?: number) => {
    if (!imgRef.current || !containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const fitScale = getFitScale();
    const originalScale = 1 / fitScale;
    const currentScale = transformRef.current.scale;
    
    const toOriginal = Math.abs(currentScale - originalScale) > Math.abs(currentScale - 1);
    
    if (toOriginal) {
      const imgRect = imgRef.current.getBoundingClientRect();
      const isMouseInImage =
        clientX !== undefined && clientY !== undefined &&
        clientX >= imgRect.left &&
        clientX <= imgRect.right &&
        clientY >= imgRect.top &&
        clientY <= imgRect.bottom;

      if (isMouseInImage && clientX !== undefined && clientY !== undefined) {
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const dx = clientX - (rect.left + centerX);
        const dy = clientY - (rect.top + centerY);
        
        const targetX = dx * (1 - originalScale);
        const targetY = dy * (1 - originalScale);
        animateTo(originalScale, targetX, targetY, 360, 'back');
      } else {
        animateTo(originalScale, 0, 0, 360, 'back');
      }
    } else {
      animateTo(1, 0, 0, 260, 'smooth');
    }
  }, [animateTo, getFitScale]);

  const fitToWindow = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    transformRef.current = { scale: 1, rotation: 0, x: 0, y: 0 };
    applyTransformToDOM();
    setTransform({ scale: 1, rotation: 0, x: 0, y: 0 });
  }, [applyTransformToDOM]);

  const setToOriginalSize = useCallback(() => {
    if (!imgRef.current || !containerRef.current) return;
    
    const fitScale = getFitScale();
    const originalScale = 1 / fitScale;
    
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    transformRef.current = { ...transformRef.current, scale: originalScale, x: 0, y: 0 };
    applyTransformToDOM();
    setTransform({ ...transformRef.current });
  }, [applyTransformToDOM, getFitScale]);

  const reset = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    transformRef.current = {
      scale: 1,
      rotation: 0,
      x: 0,
      y: 0,
    };
    applyTransformToDOM();
    setTransform({ ...transformRef.current });
  }, [applyTransformToDOM]);

  const setScale = useCallback((scale: number) => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
    transformRef.current = { ...transformRef.current, scale };
    applyTransformToDOM();
    setTransform({ ...transformRef.current });
  }, [applyTransformToDOM]);

  const setRotation = useCallback((rotation: number) => {
    transformRef.current = { ...transformRef.current, rotation };
    applyTransformToDOM();
    setTransform({ ...transformRef.current });
  }, [applyTransformToDOM]);

  const rotate = useCallback((deg: number) => {
    transformRef.current = { ...transformRef.current, rotation: transformRef.current.rotation + deg };
    applyTransformToDOM();
    setTransform({ ...transformRef.current });
  }, [applyTransformToDOM]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
    };
  }, [handleWheel]);

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current) {
        handleMouseUp();
      }
    };
    
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('mouseleave', handleGlobalMouseUp);
    
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('mouseleave', handleGlobalMouseUp);
    };
  }, [handleMouseUp]);

  return {
    transform,
    isDragging,
    isWheeling,
    containerRef,
    imgRef,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClick,
    handleMiddleClick,
    reset,
    setScale,
    setRotation,
    rotate,
    animateTo,
    toggleOriginalFit,
    fitToWindow,
    setToOriginalSize,
  };
};

export default useImageTransform;
