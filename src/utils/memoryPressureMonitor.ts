export type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

type MemoryPressureListener = (level: MemoryPressureLevel) => void;

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

declare global {
  interface Performance {
    memory?: MemoryInfo;
  }
}

class MemoryPressureMonitor {
  private listeners = new Set<MemoryPressureListener>();
  private currentLevel: MemoryPressureLevel = 'normal';
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private readonly WARNING_THRESHOLD = 0.7;
  private readonly CRITICAL_THRESHOLD = 0.85;
  private readonly DEFAULT_INTERVAL = 2000;

  private lastUsedMB = 0;
  private lastLimitMB = 0;

  start(intervalMs: number = this.DEFAULT_INTERVAL): void {
    if (this.isRunning) return;
    if (!performance.memory) return;

    this.isRunning = true;
    this.check();

    this.checkInterval = setInterval(() => {
      this.check();
    }, intervalMs);
  }

  stop(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
  }

  private check(): void {
    if (!performance.memory) return;

    const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory;
    this.lastUsedMB = usedJSHeapSize / (1024 * 1024);
    this.lastLimitMB = jsHeapSizeLimit / (1024 * 1024);

    const usageRatio = usedJSHeapSize / jsHeapSizeLimit;

    let newLevel: MemoryPressureLevel;
    if (usageRatio >= this.CRITICAL_THRESHOLD) {
      newLevel = 'critical';
    } else if (usageRatio >= this.WARNING_THRESHOLD) {
      newLevel = 'warning';
    } else {
      newLevel = 'normal';
    }

    if (newLevel !== this.currentLevel) {
      const prevLevel = this.currentLevel;
      this.currentLevel = newLevel;
      console.warn(
        `[MemoryPressure] Level changed: ${prevLevel} → ${newLevel} ` +
        `(used: ${this.lastUsedMB.toFixed(1)}MB / ${this.lastLimitMB.toFixed(1)}MB, ` +
        `${(usageRatio * 100).toFixed(1)}%)`
      );
      this.notifyListeners();
    }
  }

  getLevel(): MemoryPressureLevel {
    return this.currentLevel;
  }

  getMemoryInfo(): { usedMB: number; limitMB: number; usageRatio: number } {
    return {
      usedMB: this.lastUsedMB,
      limitMB: this.lastLimitMB,
      usageRatio: this.lastLimitMB > 0 ? this.lastUsedMB / this.lastLimitMB : 0,
    };
  }

  subscribe(listener: MemoryPressureListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  forceCleanup(): void {
    this.notifyListeners();
  }

  private notifyListeners(): void {
    const level = this.currentLevel;
    for (const listener of this.listeners) {
      try {
        listener(level);
      } catch {}
    }
  }

  isAvailable(): boolean {
    return typeof performance !== 'undefined' && !!performance.memory;
  }
}

export const memoryPressureMonitor = new MemoryPressureMonitor();
