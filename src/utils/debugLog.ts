/**
 * 运行时调试日志开关（安卓真机调试用）。
 *
 * 真机上日志要经 WebView 的调试通道送到 chrome://inspect，每条 console.log 都是
 * 一次跨进程序列化；而 FLIP / 捏合这条链路上一次手势要打几十条（[Pinch] 每变化
 * 4% 一条、FLIP 每次过渡 6~8 条），高频 touchmove 期间尤其明显。要量"真实帧率"
 * 就必须能把这个变量摘掉。
 *
 * 实现方式是直接替换全局 console.log/debug/info（保留 warn/error）：参数根本不会
 * 进入原生绑定，序列化开销归零；同时也不会漏掉任何一处日志点。
 */
type ConsoleFn = (...args: any[]) => void;

const noop: ConsoleFn = () => {};

const nativeLog: ConsoleFn = typeof console !== 'undefined' ? console.log.bind(console) : noop;
const nativeInfo: ConsoleFn = typeof console !== 'undefined' ? console.info.bind(console) : noop;
const nativeDebug: ConsoleFn = typeof console !== 'undefined' ? console.debug.bind(console) : noop;

// 默认开启：与加开关之前的行为一致，不改变现有调试流程。
let enabled = true;

const listeners = new Set<(enabled: boolean) => void>();

function apply() {
    if (typeof console === 'undefined') return;
    console.log = enabled ? nativeLog : noop;
    console.info = enabled ? nativeInfo : noop;
    console.debug = enabled ? nativeDebug : noop;
    if (typeof window !== 'undefined') {
        (window as any).__AURORA_DEBUG_LOGS__ = enabled;
    }
}

export function isDebugLogEnabled(): boolean {
    return enabled;
}

export function setDebugLogEnabled(next: boolean): void {
    if (next === enabled) return;
    enabled = next;
    apply();
    for (const listener of listeners) {
        try { listener(enabled); } catch { /* ignore */ }
    }
}

export function subscribeDebugLog(listener: (enabled: boolean) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

// 初始化：同步 window 上的标志位，便于在 chrome://inspect 里直接改
if (typeof window !== 'undefined') {
    (window as any).__AURORA_DEBUG_LOGS__ = enabled;
    (window as any).__AURORA_SET_DEBUG_LOGS__ = setDebugLogEnabled;
}
