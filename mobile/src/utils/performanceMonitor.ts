interface FrameTimeStats {
  average: number;
  p95: number;
  p99: number;
  droppedFrames: number;
}

export class PerformanceMonitor {
  private frameTimes: number[] = [];
  private lastFrameTime: number = 0;
  private isMonitoring: boolean = false;
  
  startMonitoring(): void {
    this.isMonitoring = true;
    this.lastFrameTime = performance.now();
    this.scheduleFrame();
  }
  
  stopMonitoring(): void {
    this.isMonitoring = false;
  }
  
  private scheduleFrame(): void {
    if (!this.isMonitoring) return;
    
    requestAnimationFrame(() => {
      const now = performance.now();
      const frameTime = now - this.lastFrameTime;
      this.lastFrameTime = now;
      
      this.frameTimes.push(frameTime);
      
      if (this.frameTimes.length > 100) {
        this.frameTimes.shift();
      }
      
      if (frameTime > 33.33) {
        console.warn(`Frame drop detected: ${frameTime.toFixed(2)}ms`);
      }
      
      this.scheduleFrame();
    });
  }
  
  getStats(): FrameTimeStats {
    if (this.frameTimes.length === 0) {
      return { average: 0, p95: 0, p99: 0, droppedFrames: 0 };
    }
    
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    
    return {
      average: sum / sorted.length,
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      droppedFrames: sorted.filter(t => t > 33.33).length,
    };
  }
  
  getCurrentFPS(): number {
    if (this.frameTimes.length === 0) return 60;
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return Math.min(60, 1000 / avgFrameTime);
  }
}

export const performanceMonitor = new PerformanceMonitor();
