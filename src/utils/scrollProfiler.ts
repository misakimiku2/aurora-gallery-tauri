/**
 * 滚动性能记录器 (Scroll Profiler)
 *
 * 用途：记录一次「滚动会话」期间的主线程帧耗时、滚动事件、Long Task、
 *       Layout Shift、FileGrid 重渲染次数、缩略图请求量等，用于针对性优化滚动卡顿。
 *
 * 接入方式（FileGrid 内）：
 *   import { scrollProfiler } from '../utils/scrollProfiler';
 *   scrollProfiler.attach(containerRef.current);  // 挂载
 *   scrollProfiler.detach();                      // 卸载
 *
 * 全局开关与工具（DevTools 控制台）：
 *   window.__AURORA_SCROLL_PERF__ = false;   // 关闭记录（默认开启）
 *   window.__scrollPerfReport();             // 重新打印最近一次会话报告
 *   window.__scrollPerfEnable(true);         // 开启记录
 *
 * 报告输出：
 *   1) DevTools Console（始终输出）
 *   2) 文件：{cacheRoot 上级目录}/scroll-perf/scroll-perf-<时间戳>.txt（桌面端 Tauri）
 *
 * 判断卡顿的快速参考：
 *   - 帧耗时 p95 > 16.7ms，或掉帧率（>16.7ms 帧占比）> 10%：主线程单帧成本过高
 *   - Long Task 多且长：多为图片解码 / IPC / 大规模布局
 *   - Layout Shift 频繁：缩略图加载导致卡片尺寸变化，引发重排
 *   - FileGrid 重渲染次数高：状态更新风暴（scrollTop / visibleItems 抖动）
 *   - thumbnailCacheMiss 增量大：滚动时大量缩略图未命中，需要并发/预取控制
 */
import { isTauriEnvironment } from './environment';
import { writeFileFromBytes, getGlobalCacheRoot } from '../api/tauri-bridge';
import { performanceMonitor } from './performanceMonitor';

export interface ScrollPerfReport {
  id: number;
  durationMs: number;
  scrollEventCount: number;
  totalDistance: number;
  maxVelocityPxPerMs: number;
  frameCount: number;
  frameAvgMs: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameP99Ms: number;
  frameMaxMs: number;
  droppedOver17: number;
  droppedOver33: number;
  droppedOver50: number;
  droppedOver100: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  layoutShiftCount: number;
  layoutShiftTotal: number;
  fileGridRenders: number;
  fileGridDOMStart: number;
  fileGridDOMEnd: number;
  thumbHitDelta: number;
  thumbMissDelta: number;
}

interface ScrollSession {
  id: number;
  startTs: number;
  lastScrollTs: number;
  lastScrollTop: number;
  scrollEventCount: number;
  totalDistance: number;
  maxVelocity: number;
  frameTimes: number[];
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  layoutShiftCount: number;
  layoutShiftTotal: number;
  renderCountStart: number;
  domCountStart: number;
  thumbHitStart: number;
  thumbMissStart: number;
}

const IDLE_MS = 800;
const MIN_REPORT_DURATION_MS = 300;

/**
 * 总开关：默认关闭（不打印日志、不监听滚动、不写文件，零开销）。
 * 未来需要诊断时，改为 true 即可恢复全部功能；也可在 DevTools 控制台
 * 通过 window.__scrollPerfEnable(true) 动态开启（无需改代码）。
 */
let _profilerEnabled = false;

function isGloballyEnabled(): boolean {
  return _profilerEnabled ||
    (typeof window !== 'undefined' && (window as any).__AURORA_SCROLL_PERF__ === true);
}

export function setScrollProfilerEnabled(enabled: boolean): void {
  _profilerEnabled = enabled;
  if (typeof window !== 'undefined') {
    (window as any).__AURORA_SCROLL_PERF__ = enabled;
  }
  // 同步挂载状态：开启时开始监听滚动，关闭时停止监听
  // （scrollProfiler 为模块级单例，运行时已初始化，此处安全）
  scrollProfiler.refresh();
}

/** 获取当前滚动性能记录是否启用（供设置界面展示开关状态） */
export function isScrollProfilerEnabled(): boolean {
  return isGloballyEnabled();
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return round1(sorted[idx]);
}

class ScrollProfiler {
  private el: HTMLElement | null = null;
  private attached = false;
  private session: ScrollSession | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private prevFrameTs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private layoutShiftObserver: PerformanceObserver | null = null;
  private sessionSeq = 0;
  private lastReport: ScrollPerfReport | null = null;

  attach(el: HTMLElement) {
    if (this.attached) return;
    this.attached = true;
    this.el = el;
    this.installGlobals();
    // 未启用时只记录目标元素、不监听滚动（设置界面开启后再 refresh 挂载）
    if (!isGloballyEnabled()) return;
    this.startListening();
  }

  /** 监听滚动与创建 Observer */
  private startListening() {
    if (!this.el) return;
    this.el.addEventListener('scroll', this.handleScroll, { passive: true });
    try {
      this.longTaskObserver = new PerformanceObserver(list => {
        this.recordLongTasks(list.getEntries() as unknown as PerformanceEntry[]);
      });
      this.longTaskObserver.observe({ entryTypes: ['longtask'] } as PerformanceObserverInit);
    } catch {
      this.longTaskObserver = null;
    }
    try {
      this.layoutShiftObserver = new PerformanceObserver(list => {
        this.recordLayoutShifts(list.getEntries() as unknown as PerformanceEntry[]);
      });
      this.layoutShiftObserver.observe({ entryTypes: ['layout-shift'] } as PerformanceObserverInit);
    } catch {
      this.layoutShiftObserver = null;
    }
  }

  /** 停止监听与销毁 Observer */
  private stopListening() {
    if (this.el) this.el.removeEventListener('scroll', this.handleScroll);
    this.endSession();
    this.longTaskObserver?.disconnect();
    this.layoutShiftObserver?.disconnect();
    this.longTaskObserver = null;
    this.layoutShiftObserver = null;
  }

  /** 根据当前开关状态同步监听：设置界面切换开关后调用 */
  refresh() {
    if (!this.attached) return;
    if (isGloballyEnabled()) {
      this.stopListening();
      this.startListening();
    } else {
      this.stopListening();
    }
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.stopListening();
    this.el = null;
  }

  private isEnabled(): boolean {
    return isGloballyEnabled();
  }

  private handleScroll = () => {
    if (!this.isEnabled() || !this.el) return;
    const now = performance.now();
    const scrollTop = this.el.scrollTop;

    if (!this.session) {
      this.beginSession(scrollTop);
    } else {
      const s = this.session;
      const dy = Math.abs(scrollTop - s.lastScrollTop);
      const dt = now - s.lastScrollTs;
      s.totalDistance += dy;
      if (dt > 0) {
        const vel = dy / dt;
        if (vel > s.maxVelocity) s.maxVelocity = vel;
        // 滚动事件间隔本身就是可靠的帧节奏采样：事件之间的时间差
        // 直接反映主线程处理两帧的成本（主线程被解码/渲染阻塞时 dt 会异常大）
        if (s.frameTimes.length > 0 || dt < 500) {
          s.frameTimes.push(dt);
        }
      }
      s.scrollEventCount++;
      s.lastScrollTop = scrollTop;
      s.lastScrollTs = now;
    }

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.endSession(), IDLE_MS);
  };

  private beginSession(scrollTop: number) {
    const counters = (window as any).__AURORA_RENDER_COUNTS__ || {};
    this.session = {
      id: ++this.sessionSeq,
      startTs: performance.now(),
      lastScrollTs: performance.now(),
      lastScrollTop: scrollTop,
      scrollEventCount: 0,
      totalDistance: 0,
      maxVelocity: 0,
      frameTimes: [],
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longTaskMaxMs: 0,
      layoutShiftCount: 0,
      layoutShiftTotal: 0,
      renderCountStart: counters.fileGridRenders || 0,
      domCountStart: counters.fileGridDOM || 0,
      thumbHitStart: performanceMonitor.getCounter('thumbnailCacheHit'),
      thumbMissStart: performanceMonitor.getCounter('thumbnailCacheMiss'),
    };
    this.prevFrameTs = performance.now();
    // 双通道帧采样：
    // 1) 滚动事件间隔（handleScroll 内记录）——最可靠，滚动过程中必然触发
    // 2) setInterval 16ms 兜底采样——在极少数“滚动事件被浏览器合并/稀释”时补充节奏数据
    this.sampleTimer = setInterval(() => this.sampleTick(), 16);
  }

  private sampleTick = () => {
    if (!this.session) return;
    const now = performance.now();
    const dt = now - this.prevFrameTs;
    this.prevFrameTs = now;
    // 忽略首帧间隔；仅当滚动事件采样过少时用 interval 补充
    if (dt > 0 && dt < 1000 && this.session.frameTimes.length > 0 && (this.session.frameTimes.length < 4 || dt > 40)) {
      // 只补充“疑似掉帧”的间隔，避免 interval 与滚动事件双通道重复采样
      if (dt > 60) this.session.frameTimes.push(dt);
    }
  };

  private recordLongTasks(entries: PerformanceEntry[]) {
    const s = this.session;
    if (!s) return;
    for (const e of entries) {
      if (e.startTime < s.startTs) continue;
      const dur = e.duration;
      s.longTaskCount++;
      s.longTaskTotalMs += dur;
      if (dur > s.longTaskMaxMs) s.longTaskMaxMs = dur;
    }
  }

  private recordLayoutShifts(entries: PerformanceEntry[]) {
    const s = this.session;
    if (!s) return;
    for (const e of entries) {
      if (e.startTime < s.startTs) continue;
      const value = (e as any).value || 0;
      s.layoutShiftCount++;
      s.layoutShiftTotal += value;
    }
  }

  private endSession() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.session) return;
    const s = this.session;
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.session = null;

    const counters = (window as any).__AURORA_RENDER_COUNTS__ || {};
    const frames = s.frameTimes;
    const sorted = [...frames].sort((a, b) => a - b);
    const report: ScrollPerfReport = {
      id: s.id,
      durationMs: round1(performance.now() - s.startTs),
      scrollEventCount: s.scrollEventCount,
      totalDistance: Math.round(s.totalDistance),
      maxVelocityPxPerMs: round1(s.maxVelocity),
      frameCount: frames.length,
      frameAvgMs: frames.length ? round1(frames.reduce((a, b) => a + b, 0) / frames.length) : 0,
      frameP50Ms: percentile(sorted, 50),
      frameP95Ms: percentile(sorted, 95),
      frameP99Ms: percentile(sorted, 99),
      frameMaxMs: sorted.length ? round1(sorted[sorted.length - 1]) : 0,
      droppedOver17: frames.filter(t => t > 16.7).length,
      droppedOver33: frames.filter(t => t > 33.4).length,
      droppedOver50: frames.filter(t => t > 50).length,
      droppedOver100: frames.filter(t => t > 100).length,
      longTaskCount: s.longTaskCount,
      longTaskTotalMs: round1(s.longTaskTotalMs),
      longTaskMaxMs: round1(s.longTaskMaxMs),
      layoutShiftCount: s.layoutShiftCount,
      layoutShiftTotal: Math.round(s.layoutShiftTotal * 1000) / 1000,
      fileGridRenders: (counters.fileGridRenders || 0) - s.renderCountStart,
      fileGridDOMStart: s.domCountStart,
      fileGridDOMEnd: counters.fileGridDOM || 0,
      thumbHitDelta: performanceMonitor.getCounter('thumbnailCacheHit') - s.thumbHitStart,
      thumbMissDelta: performanceMonitor.getCounter('thumbnailCacheMiss') - s.thumbMissStart,
    };
    this.lastReport = report;
    this.emit(report);
  }

  private emit(report: ScrollPerfReport) {
    const text = this.formatReport(report);
    console.groupCollapsed(`%c[ScrollPerf] 会话 #${report.id} 滚动 ${report.durationMs}ms 距离 ${report.totalDistance}px`, 'color:#4f8cff;font-weight:bold');
    console.log(text);
    console.groupEnd();

    const meaningful =
      report.durationMs >= MIN_REPORT_DURATION_MS &&
      (report.totalDistance >= 50 || report.scrollEventCount >= 5);
    if (!meaningful || !isTauriEnvironment()) return;

    const cacheRoot = getGlobalCacheRoot();
    if (!cacheRoot) return;
    const norm = cacheRoot.replace(/[\\/]+$/, '');
    const sep = norm.includes('\\') ? '\\' : '/';
    const parent = norm.lastIndexOf(sep) > 0 ? norm.slice(0, norm.lastIndexOf(sep)) : norm;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = `${parent}${sep}scroll-perf${sep}scroll-perf-${ts}.txt`;

    writeFileFromBytes(filePath, new TextEncoder().encode(text))
      .then(() => {
        console.log(`%c[ScrollPerf] 报告已写入: ${filePath}`, 'color:#4f8cff');
      })
      .catch(err => {
        console.warn('[ScrollPerf] 报告写入失败:', err);
      });
  }

  private formatReport(r: ScrollPerfReport): string {
    const frameDropRate = r.frameCount > 0 ? Math.round((r.droppedOver17 / r.frameCount) * 100) : 0;
    return [
      `[ScrollPerf] 滚动会话 #${r.id}  ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `  时长: ${r.durationMs}ms | 滚动事件: ${r.scrollEventCount} 次 | 总距离: ${r.totalDistance}px | 峰值速度: ${r.maxVelocityPxPerMs}px/ms`,
      `  帧: ${r.frameCount} 帧 | 平均 ${r.frameAvgMs}ms | p50 ${r.frameP50Ms}ms | p95 ${r.frameP95Ms}ms | p99 ${r.frameP99Ms}ms | 最大 ${r.frameMaxMs}ms`,
      `  掉帧(>16.7ms): ${r.droppedOver17} | >33ms: ${r.droppedOver33} | >50ms: ${r.droppedOver50} | >100ms: ${r.droppedOver100}  (掉帧率 ${frameDropRate}%)`,
      `  Long Task: ${r.longTaskCount} 次 | 合计 ${r.longTaskTotalMs}ms | 最长 ${r.longTaskMaxMs}ms`,
      `  Layout Shift: ${r.layoutShiftCount} 次 | 累计 ${r.layoutShiftTotal}`,
      `  FileGrid 重渲染: ${r.fileGridRenders} 次 | DOM 卡片: ${r.fileGridDOMStart} → ${r.fileGridDOMEnd}`,
      `  缩略图: 命中 ${r.thumbHitDelta} | 未命中 ${r.thumbMissDelta}`,
    ].join('\n');
  }

  private installGlobals() {
    const win = window as any;
    if (win.__scrollPerfReport) return;
    win.__scrollPerfReport = () => {
      if (this.lastReport) {
        console.log(this.formatReport(this.lastReport));
      } else {
        console.log('[ScrollPerf] 尚无滚动会话记录，请先滚动文件网格');
      }
    };
    win.__scrollPerfEnable = (on: boolean) => {
      const enabled = !!on;
      win.__AURORA_SCROLL_PERF__ = enabled;
      _profilerEnabled = enabled;
      console.log(`[ScrollPerf] 记录${enabled ? '已开启' : '已关闭'}`);
      // 同步监听状态（与设置界面开关一致）
      this.refresh();
    };
  }
}

export const scrollProfiler = new ScrollProfiler();
