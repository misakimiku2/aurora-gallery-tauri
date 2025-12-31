/**
 * 性能监控工具类
 * 用于收集和分析应用性能指标
 */

// 添加performance.memory的类型声明
declare global {
  interface Performance {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  }
}

// 性能数据类型定义
export interface PerformanceMetric {
  id: string;
  type: 'timing' | 'count' | 'memory';
  name: string;
  value: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface PerformanceConfig {
  enabled: boolean;
  samplingRate: number; // 0-1 之间的小数，表示采样率
  maxHistorySize: number;
  retentionDays: number;
  enableMemoryMonitoring: boolean;
}

// 默认配置
const DEFAULT_CONFIG: PerformanceConfig = {
  enabled: true,
  samplingRate: 0.1, // 默认10%采样率
  maxHistorySize: 1000,
  retentionDays: 7,
  enableMemoryMonitoring: true
};

// 性能监控类
export class PerformanceMonitor {
  private config: PerformanceConfig;
  private currentTimers: Map<string, number>;
  private metrics: PerformanceMetric[];
  private counters: Map<string, number>;
  private memoryHistory: { timestamp: number; memory: number }[];
  private memoryTimer: number | null = null;

  constructor(config?: Partial<PerformanceConfig>) {
    // 从本地存储加载配置
    const savedConfig = this.loadConfig();
    this.config = { ...DEFAULT_CONFIG, ...savedConfig, ...config };
    this.currentTimers = new Map();
    this.metrics = [];
    this.counters = new Map();
    this.memoryHistory = [];

    // 如果启用内存监控，启动内存监控定时器
    if (this.config.enableMemoryMonitoring) {
      this.startMemoryMonitoring();
    }

    // 加载历史数据
    this.loadHistory();
    // 清理过期数据
    this.cleanupOldData();
  }

  /**
   * 从本地存储加载配置
   */
  private loadConfig(): Partial<PerformanceConfig> {
    try {
      const savedConfig = localStorage.getItem('aurora-performance-config');
      if (savedConfig) {
        return JSON.parse(savedConfig);
      }
    } catch (error) {
      console.error('Failed to load performance config:', error);
    }
    return {};
  }

  /**
   * 将配置保存到本地存储
   */
  private saveConfig(): void {
    try {
      localStorage.setItem('aurora-performance-config', JSON.stringify(this.config));
    } catch (error) {
      console.error('Failed to save performance config:', error);
    }
  }

  /**
   * 开始计时
   * @param name 计时名称
   * @param id 可选的唯一标识符，用于区分同名计时
   * @param bypassSampling 是否绕过采样率，默认为false
   */
  startTimer(name: string, id?: string, bypassSampling: boolean = false): string {
    if (!this.config.enabled || (!bypassSampling && Math.random() > this.config.samplingRate)) {
      return '';
    }

    const timerId = id || `${name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.currentTimers.set(timerId, performance.now());
    return timerId;
  }

  /**
   * 结束计时并记录指标
   * @param timerId 计时ID
   * @param name 计时名称
   * @param metadata 可选的元数据
   */
  endTimer(timerId: string, name: string, metadata?: Record<string, any>): void {
    if (!this.config.enabled || !timerId) {
      return;
    }

    const startTime = this.currentTimers.get(timerId);
    if (startTime) {
      const duration = performance.now() - startTime;
      this.currentTimers.delete(timerId);
      this.recordMetric('timing', name, duration, metadata);
    }
  }

  /**
   * 记录单次计时
   * @param name 计时名称
   * @param duration 持续时间（毫秒）
   * @param metadata 可选的元数据
   */
  recordTiming(name: string, duration: number, metadata?: Record<string, any>): void {
    if (!this.config.enabled || Math.random() > this.config.samplingRate) {
      return;
    }
    this.recordMetric('timing', name, duration, metadata);
  }

  /**
   * 增加计数器
   * @param name 计数器名称
   * @param increment 增加的值，默认为1
   * @param metadata 可选的元数据
   */
  incrementCounter(name: string, increment: number = 1, metadata?: Record<string, any>): void {
    if (!this.config.enabled) {
      return;
    }

    const currentValue = this.counters.get(name) || 0;
    const newValue = currentValue + increment;
    this.counters.set(name, newValue);
    // 计数器类型的指标不受采样率影响，总是记录
    this.recordMetric('count', name, newValue, metadata);
  }

  /**
   * 获取当前计数器值
   * @param name 计数器名称
   * @returns 计数器当前值
   */
  getCounterValue(name: string): number {
    return this.counters.get(name) || 0;
  }

  /**
   * 记录内存使用情况
   */
  recordMemory(): void {
    if (!this.config.enabled || !this.config.enableMemoryMonitoring) {
      return;
    }

    if (performance.memory) {
      const usedMemory = performance.memory.usedJSHeapSize / (1024 * 1024); // 转换为MB
      this.recordMetric('memory', 'usedJSHeapSize', usedMemory);
      this.memoryHistory.push({ timestamp: Date.now(), memory: usedMemory });
      
      // 限制内存历史记录大小
      if (this.memoryHistory.length > 100) {
        this.memoryHistory.shift();
      }
    }
  }

  /**
   * 记录性能指标
   * @param type 指标类型
   * @param name 指标名称
   * @param value 指标值
   * @param metadata 可选的元数据
   */
  private recordMetric(type: PerformanceMetric['type'], name: string, value: number, metadata?: Record<string, any>): void {
    const metric: PerformanceMetric = {
      id: `${type}-${name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      name,
      value,
      timestamp: Date.now(),
      metadata
    };

    this.metrics.push(metric);
    
    // 限制内存中指标数量
    if (this.metrics.length > this.config.maxHistorySize) {
      this.metrics.shift();
    }

    // 保存到本地存储
    this.saveHistory();
  }

  /**
   * 启动内存监控
   */
  private startMemoryMonitoring(): void {
    // 每5秒记录一次内存使用情况
    this.memoryTimer = window.setInterval(() => {
      this.recordMemory();
    }, 5000);
  }

  /**
   * 获取当前性能指标
   * @param type 可选的指标类型过滤
   * @param name 可选的指标名称过滤
   * @returns 性能指标数组
   */
  getMetrics(type?: PerformanceMetric['type'], name?: string): PerformanceMetric[] {
    return this.metrics.filter(metric => {
      if (type && metric.type !== type) return false;
      if (name && metric.name !== name) return false;
      return true;
    });
  }

  /**
   * 获取聚合后的性能指标
   * @param name 指标名称
   * @returns 聚合后的指标
   */
  getAggregatedMetrics(name: string): {
    average: number;
    min: number;
    max: number;
    count: number;
    values: number[];
  } | null {
    const metrics = this.getMetrics(undefined, name);
    if (metrics.length === 0) return null;

    const values = metrics.map(m => m.value);
    return {
      average: values.reduce((sum, val) => sum + val, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      values
    };
  }

  /**
   * 获取内存使用历史
   */
  getMemoryHistory(): { timestamp: number; memory: number }[] {
    return this.memoryHistory;
  }

  /**
   * 清除所有指标
   */
  clearMetrics(): void {
    this.metrics = [];
    this.currentTimers.clear();
    this.counters.clear();
    this.memoryHistory = [];
    this.saveHistory();
  }

  /**
   * 保存历史数据到本地存储
   */
  private saveHistory(): void {
    try {
      const data = {
        metrics: this.metrics,
        memoryHistory: this.memoryHistory
      };
      localStorage.setItem('aurora-performance-history', JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save performance history:', error);
    }
  }

  /**
   * 从本地存储加载历史数据
   */
  private loadHistory(): void {
    try {
      const data = localStorage.getItem('aurora-performance-history');
      if (data) {
        const parsed = JSON.parse(data);
        this.metrics = parsed.metrics || [];
        this.memoryHistory = parsed.memoryHistory || [];
      }
    } catch (error) {
      console.error('Failed to load performance history:', error);
    }
  }

  /**
   * 清理过期数据
   */
  private cleanupOldData(): void {
    const cutoffTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    this.metrics = this.metrics.filter(metric => metric.timestamp > cutoffTime);
    this.saveHistory();
  }

  /**
   * 更新配置
   * @param config 新的配置
   */
  updateConfig(config: Partial<PerformanceConfig>): void {
    this.config = { ...this.config, ...config };

    // 如果内存监控配置改变，更新定时器
    if (this.config.enableMemoryMonitoring && !this.memoryTimer) {
      this.startMemoryMonitoring();
    } else if (!this.config.enableMemoryMonitoring && this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }

    // 保存配置到本地存储
    this.saveConfig();
  }

  /**
   * 获取当前配置
   */
  getConfig(): PerformanceConfig {
    return { ...this.config };
  }

  /**
   * 销毁性能监控实例
   */
  destroy(): void {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
    this.clearMetrics();
  }

  /**
   * 获取当前内存使用情况
   */
  getCurrentMemory(): number | null {
    if (performance.memory) {
      return performance.memory.usedJSHeapSize / (1024 * 1024); // 转换为MB
    }
    return null;
  }
}

// 创建单例实例
let monitorInstance: PerformanceMonitor | null = null;

export function getPerformanceMonitor(config?: Partial<PerformanceConfig>): PerformanceMonitor {
  if (!monitorInstance) {
    monitorInstance = new PerformanceMonitor(config);
  } else if (config) {
    monitorInstance.updateConfig(config);
  }
  return monitorInstance;
}

// 导出便捷方法
export const performanceMonitor = {
  /**
   * 开始计时
   */
  start: (name: string, id?: string, bypassSampling?: boolean) => {
    return getPerformanceMonitor().startTimer(name, id, bypassSampling);
  },

  /**
   * 结束计时
   */
  end: (timerId: string, name: string, metadata?: Record<string, any>) => {
    getPerformanceMonitor().endTimer(timerId, name, metadata);
  },

  /**
   * 记录计时
   */
  timing: (name: string, duration: number, metadata?: Record<string, any>) => {
    getPerformanceMonitor().recordTiming(name, duration, metadata);
  },

  /**
   * 增加计数器
   */
  increment: (name: string, increment: number = 1, metadata?: Record<string, any>) => {
    getPerformanceMonitor().incrementCounter(name, increment, metadata);
  },

  /**
   * 获取当前计数器值
   */
  getCounter: (name: string) => {
    return getPerformanceMonitor().getCounterValue(name);
  },

  /**
   * 记录内存
   */
  recordMemory: () => {
    getPerformanceMonitor().recordMemory();
  },

  /**
   * 获取指标
   */
  getMetrics: (type?: PerformanceMetric['type'], name?: string) => {
    return getPerformanceMonitor().getMetrics(type, name);
  },

  /**
   * 获取聚合指标
   */
  getAggregated: (name: string) => {
    return getPerformanceMonitor().getAggregatedMetrics(name);
  },

  /**
   * 清除指标
   */
  clearMetrics: () => {
    getPerformanceMonitor().clearMetrics();
  },

  /**
   * 更新配置
   */
  updateConfig: (config: Partial<PerformanceConfig>) => {
    getPerformanceMonitor().updateConfig(config);
  },

  /**
   * 获取当前配置
   */
  getConfig: () => {
    return getPerformanceMonitor().getConfig();
  },

  /**
   * 获取内存使用历史
   */
  getMemoryHistory: () => {
    return getPerformanceMonitor().getMemoryHistory();
  },

  /**
   * 获取当前内存使用情况
   */
  getCurrentMemory: () => {
    return getPerformanceMonitor().getCurrentMemory();
  }
};
