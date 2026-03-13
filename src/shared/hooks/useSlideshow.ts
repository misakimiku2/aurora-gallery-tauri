import { useState, useRef, useCallback, useEffect } from 'react';

export type TransitionType = 'none' | 'fade' | 'slide';

export interface SlideshowConfig {
  interval: number;
  transition: TransitionType;
  enableZoom: boolean;
  isRandom: boolean;
}

export interface UseSlideshowOptions {
  initialConfig?: Partial<SlideshowConfig>;
  onNavigate?: (random: boolean) => void;
  containerRef?: React.RefObject<HTMLElement>;
}

export interface UseSlideshowReturn {
  isActive: boolean;
  config: SlideshowConfig;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  updateConfig: (config: Partial<SlideshowConfig>) => void;
  isFullscreen: boolean;
  isTransitioning: boolean;
  prevImageUrl: string;
  setPrevImageUrl: (url: string) => void;
  currentTransform: string;
  setCurrentTransform: (transform: string) => void;
}

const DEFAULT_CONFIG: SlideshowConfig = {
  interval: 3000,
  transition: 'fade',
  enableZoom: true,
  isRandom: false,
};

export const useSlideshow = (
  options: UseSlideshowOptions = {}
): UseSlideshowReturn => {
  const {
    initialConfig = {},
    onNavigate,
    containerRef,
  } = options;

  const [isActive, setIsActive] = useState(false);
  const [config, setConfig] = useState<SlideshowConfig>({
    ...DEFAULT_CONFIG,
    ...initialConfig,
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [prevImageUrl, setPrevImageUrl] = useState<string>('');
  const [currentTransform, setCurrentTransform] = useState<string>('none');

  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const isActiveRef = useRef(isActive);
  const configRef = useRef(config);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const enterFullscreen = useCallback(async () => {
    const element = containerRef?.current || document.documentElement;
    try {
      if (element.requestFullscreen) {
        await element.requestFullscreen();
        setIsFullscreen(true);
      }
    } catch (err) {
      console.warn('Failed to enter fullscreen:', err);
    }
  }, [containerRef]);

  const exitFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
      setIsFullscreen(false);
    } catch (err) {
      console.warn('Failed to exit fullscreen:', err);
    }
  }, []);

  const start = useCallback(async () => {
    setIsActive(true);
    if (!document.fullscreenElement) {
      await enterFullscreen();
    }
  }, [enterFullscreen]);

  const stop = useCallback(async () => {
    setIsActive(false);
    if (document.fullscreenElement) {
      await exitFullscreen();
    }
    setIsTransitioning(false);
    setPrevImageUrl('');
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
    }
  }, [exitFullscreen]);

  const toggle = useCallback(async () => {
    if (isActive) {
      await stop();
    } else {
      await start();
    }
  }, [isActive, start, stop]);

  const updateConfig = useCallback((newConfig: Partial<SlideshowConfig>) => {
    setConfig(prev => ({ ...prev, ...newConfig }));
  }, []);

  useEffect(() => {
    if (isActive && onNavigate) {
      intervalRef.current = setInterval(() => {
        onNavigate(configRef.current.isRandom);
      }, configRef.current.interval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isActive, onNavigate]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && isActiveRef.current) {
        stop();
      } else if (document.fullscreenElement) {
        setIsFullscreen(true);
      } else {
        setIsFullscreen(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [stop]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  return {
    isActive,
    config,
    start,
    stop,
    toggle,
    updateConfig,
    isFullscreen,
    isTransitioning,
    prevImageUrl,
    setPrevImageUrl,
    currentTransform,
    setCurrentTransform,
  };
};

export default useSlideshow;
