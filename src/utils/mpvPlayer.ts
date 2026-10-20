/**
 * 桌面端原生播放内核（libmpv）前端桥 —— 视频 P4/S1。
 *
 * 职责：
 *  ① invoke 封装（open / setRect / state / command / stop）
 *  ② 媒体区 rect 测量（getBoundingClientRect 口径，× devicePixelRatio = 物理像素，
 *     与 Rust 侧 ClientToScreen 配套；不用 GetDpiForWindow —— Win10+ API 会把
 *     无 manifest 的 test exe 炸成 0xc0000139）
 *  ③ 模块级状态缓存（音量滚轮等「无轮询上下文」的操作从缓存取当前值）
 *  ④ 会话令牌：StrictMode 双挂载 / 快速切文件时，cleanup 的 stop 晚于新 open
 *     到达会**误杀新会话的播放器**（真机复现：一帧画面后消失 + 尚未挂接 mpv）。
 *     session 贯穿 open/stop，Rust 只销毁完全匹配的会话；晚到的 open 自杀让位。
 *
 * 分派约定（与 ImageViewer 对齐）：
 *  - mpv 只管 **本地 + 桌面端 + WebView2 解不动** 的视频；
 *  - LAN（isRemotePath）与安卓同步端不进来；
 *  - open 失败（非 Windows / dll 缺失 / 坏文件）抛错给调用方显示错误卡；
 *  - 播放类命令吞错：surface 消失瞬间（切文件竞态窗口）操作本就无意义，
 *    抛出去只会变成 uncaught promise（控制台噪音），状态由轮询自愈。
 */

export interface MpvState {
  timePos: number | null;
  duration: number | null;
  paused: boolean;
  volume: number; // 0-100（mpv 原生口径）
  muted: boolean;
  speed: number; // 播放速率（1.0 = 原速）
  idle: boolean;
}

export interface MpvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ── 会话令牌 ───────────────────────────────────────────────────────

let sessionSeq = 0;

/**
 * 分配下一个会话令牌。**必须在 effect 函数体里同步调用**（cleanup 才拿得到自己的号）。
 */
export const nextMpvSession = (): number => ++sessionSeq;

// ── 模块级状态缓存（最近一次轮询结果） ─────────────────────────────

let lastState: MpvState | null = null;

/** 最近一次轮询到的 mpv 状态；从未轮询过 / 已 stop 返回 null。 */
export const getMpvStateCache = (): MpvState | null => lastState;

// ── 基础操作 ───────────────────────────────────────────────────────

/** 测量元素相对视口的 rect，并换算为**物理像素**（× devicePixelRatio）。 */
export const getViewportRect = (el: HTMLElement): MpvRect => {
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    w: Math.round(r.width * dpr),
    h: Math.round(r.height * dpr),
  };
};

/** 打开（或切换）文件。resolve 即已起播（FILE_LOADED）；失败抛错（错误卡用）。
 *  background = letterbox 背景色（#RRGGBB，与媒体区主题一致）。 */
export const mpvOpen = (
  path: string,
  rect: MpvRect,
  session: number,
  background?: string
): Promise<void> =>
  call<void>('mpv_player_open', {
    path, x: rect.x, y: rect.y, w: rect.w, h: rect.h, session,
    background: background ?? null,
  });

/** 媒体区 rect / 背景变化推送。失败静默（surface 消失的竞态窗口里无害）。 */
export const mpvSetRect = (rect: MpvRect, background?: string): Promise<void> =>
  call<void>('mpv_player_set_rect', {
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    background: background ?? null,
  }).catch(() => {});

/** 取元素实际渲染的背景色（#RRGGBB）；透明取不到时返回 null（Rust 端维持旧值）。
 *  口径 = getComputedStyle：亮/暗主题、沉浸/幻灯片/全屏的黑色容器全部自动正确。 */
export const getMediaBackground = (el: HTMLElement): string | undefined => {
  const raw = getComputedStyle(el).backgroundColor; // rgb(r, g, b) | rgba(...)
  const m = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (!m) return undefined;
  if (m[4] !== undefined && Number(m[4]) < 0.05) return undefined; // 全透明
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
};

/** popup 上的原生鼠标交互（WH_MOUSE_LL 钩子转发）。 */
export interface MpvSurfaceEvent {
  kind: 'click' | 'contextmenu' | 'wheel';
  /** wheel 滚动量（正 = 滚轮向上 = 音量增） */
  delta: number;
}

/** 订阅 popup 鼠标事件（点击 = 播放/暂停、右键 = 菜单、滚轮 = 音量）。返回取消函数。 */
export const onMpvSurface = async (
  handler: (e: MpvSurfaceEvent) => void
): Promise<() => void> => {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<MpvSurfaceEvent>('mpv-surface', (e) => handler(e.payload));
    return unlisten;
  } catch {
    return () => {};
  }
};

/** 轮询播放状态；同时写入模块级缓存。 */
export const mpvPollState = async (): Promise<MpvState | null> => {
  try {
    const st = await call<MpvState>('mpv_player_state', {});
    lastState = st;
    return st;
  } catch {
    lastState = null;
    return null;
  }
};

/** 透传 mpv 命令。失败静默（同上：竞态窗口内操作无意义，状态由轮询自愈）。 */
export const mpvCommand = (args: string[]): Promise<void> =>
  call<void>('mpv_player_command', { args }).catch(() => {});

/** 停止播放并销毁渲染窗口。只杀**完全匹配自己会话**的 surface（Rust 侧把关），
 *  未挂接 / 已被新会话替换时 Rust no-op，这里再把 invoke 层错误吞掉，保证幂等。 */
export const mpvStop = async (session: number): Promise<void> => {
  lastState = null;
  try {
    await call<void>('mpv_player_stop', { session });
  } catch {
    // 尚未挂接 / 非 Windows：无需停止
  }
};

// ── 播放操作（命令式，供控制条 / 键盘 / 滚轮调用；mpvCommand 已吞错） ──

export const mpvTogglePlay = async (): Promise<void> => {
  const paused = lastState?.paused ?? true;
  await mpvCommand(['set', 'pause', paused ? 'no' : 'yes']);
};

export const mpvSetPaused = (paused: boolean): Promise<void> =>
  mpvCommand(['set', 'pause', paused ? 'yes' : 'no']);

/** 绝对 seek（秒）。 */
export const mpvSeekAbsolute = (t: number): Promise<void> =>
  mpvCommand(['seek', String(Math.max(0, t)), 'absolute']);

/** 相对 seek（±秒，±5s 键位用）。 */
export const mpvSeekRelative = (delta: number): Promise<void> =>
  mpvCommand(['seek', String(delta), 'relative']);

/** 逐帧（mpv 原生 frame-step / frame-back-step，无需 fps 元数据）。 */
export const mpvFrameStep = (dir: 1 | -1): Promise<void> =>
  mpvCommand(dir > 0 ? ['frame-step'] : ['frame-back-step']);

/** 音量（0-1 前端口径 → 0-100 mpv 口径）。 */
export const mpvSetVolume = (v01: number): Promise<void> =>
  mpvCommand(['set', 'volume', String(Math.round(Math.max(0, Math.min(1, v01)) * 100))]);

/** 滚轮音量步进（±0.05，与 <video> 滚轮口径一致）。 */
export const mpvVolumeNudge = (delta: number): Promise<void> => {
  const cur = lastState ? (lastState.muted ? 0 : lastState.volume / 100) : 1;
  const next = Math.round(Math.max(0, Math.min(1, cur + delta)) * 100) / 100;
  return mpvSetVolume(next);
};

export const mpvSetMuted = (muted: boolean): Promise<void> =>
  mpvCommand(['set', 'mute', muted ? 'yes' : 'no']);

export const mpvSetLoop = (loopOn: boolean): Promise<void> =>
  mpvCommand(['set', 'loop', loopOn ? 'inf' : 'no']);

/** 倍速（1.0 = 原速）。 */
export const mpvSetSpeed = (rate: number): Promise<void> =>
  mpvCommand(['set', 'speed', String(Math.max(0.25, Math.min(4, rate)))]);
