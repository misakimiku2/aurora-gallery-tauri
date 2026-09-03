// Canvas 文件夹图标「缩略图不显示 / 长期停在灰卡占位」问题的诊断记录器。
//
// 现象：重启后偶发部分文件夹图标只显示灰白占位卡（staticBody），真缩略图一直出不来；
//       DOM 版（Folder3DIcon）同一时刻却能正常显示。难以稳定复现，故先埋点取证再改逻辑。
//
// 本模块负责区分以下几条「现象相同、根因不同」的失败路径：
//   (a) no-srcs      ：上游 previewSrcs 为空 → composeFull 走占位分支并【返回成功位图】，
//                      组件据此认为成功、不再重试，于是长期停在灰卡（无失败、无重试记录）。
//   (b) partial-fail ：3 张里只要有 1 张解码失败，composeFull 就整张返回 null（all-or-nothing），
//                      而 DOM 版会照常显示另外 2 张 —— 两者表现不一致的头号嫌疑。
//   (c) cooldown     ：src 失败后进入 8s 冷却，前几次退避重试(400/1200/3000/6000ms)全落在
//                      冷却窗口内直接返回 null，等于白重试；7 次预算（约 56s）耗尽后彻底停止。
//   (d) worker-route ：worker 用 fetch 解码，自定义协议(asset://)可能不被支持 → 回退主线程。
//
// 设计约束：
//   - 纯模块：不 import 任何 Tauri / window / DOM API。sprite-worker 会经 spriteComposer
//     间接 import 本模块，一旦引入 Tauri 就会被打进 worker bundle。写文件由 spriteCache 接线。
//   - 环形缓冲有界(3000)；成功路径默认不写 buffer（只更新聚合状态），避免高频滚动刷爆日志。
//   - asset:// URL 很长，日志内统一替换为短 id（S1/S2/...），dump 末尾输出对照表。
//
// 用法（桌面端控制台）：
//   __SPRITE_DIAG__.print()          // 打印完整诊断
//   __SPRITE_DIAG__.stuck()          // 只看当前卡在灰卡的文件夹
//   __SPRITE_DIAG__.save()           // 写文件到 {cacheRoot 上级}/sprite-diag/
//   __SPRITE_DIAG__.verbose(true)    // 打开成功路径日志（默认关，避免刷屏）
//   __SPRITE_DIAG__.reset()          // 清空记录（复现前先 reset 一次更干净）

const MAX_EVENTS = 3000;
const MAX_FOLDERS = 500;

export type DiagLevel = 'err' | 'warn' | 'info';

export interface DiagEvent {
  t: number; // 相对模块加载的毫秒
  wall: string; // 本地墙上时间 HH:MM:SS.mmm
  level: DiagLevel;
  tag: string;
  folder?: string;
  msg: string;
}

// ---------- src 短 id 图例 ----------
// 主线程用 S1/S2/...，worker 用 W1/W2/...（前缀不同，避免两端各自编号撞车导致图例错位）。
let _srcIdPrefix = 'S';

export const setDiagSrcPrefix = (prefix: string): void => {
  _srcIdPrefix = prefix;
};

const _srcToId = new Map<string, string>();
const _idToSrc = new Map<string, string>();
let _srcSeq = 0;

export const shortSrc = (src: string): string => {
  if (!src) return '-';
  let id = _srcToId.get(src);
  if (id === undefined) {
    id = `${_srcIdPrefix}${++_srcSeq}`;
    _srcToId.set(src, id);
    _idToSrc.set(id, src);
  }
  return id;
};

export const shortSrcs = (srcs: (string | null | undefined)[] | undefined): string =>
  (srcs || []).map(s => shortSrc(s || '')).join(',');

// ---------- 环形缓冲 ----------
const _events: DiagEvent[] = [];
const _t0: number = typeof performance !== 'undefined' ? performance.now() : Date.now();
let _verbose = false;
let _enabled = true;
// Folder3DIconCanvas 的累计挂载数。这是"当前到底走没走 Canvas 版"的最可靠信号：
// 若图标样式不是 canvas，FolderThumbnail 会渲染 DOM 版 Folder3DIcon，埋点一条都不会触发。
let _canvasMounts = 0;

const _now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;

const _wall = (): string => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const push = (level: DiagLevel, tag: string, msg: string, folder?: string): void => {
  if (!_enabled) return;
  if (level === 'info' && !_verbose) return; // 成功路径默认不进 buffer
  _events.push({ t: _now(), wall: _wall(), level, tag, folder, msg });
  if (_events.length > MAX_EVENTS) _events.splice(0, _events.length - MAX_EVENTS);
  // 自动镜像到 console：让 warn/err 事件直接落进 webview 控制台日志文件，
  // 复现时无需卡点执行 print()。console.log 可能被 debugLog.ts 摘除，故统一用 warn。
  if (_consoleMirror && level !== 'info' && typeof console !== 'undefined') {
    const f = folder ? `[folder=${folder}] ` : '';
    console.warn(`[SPRITE_DIAG] ${tag} ${f}${msg}`);
  }
};

let _consoleMirror = true;

// ---------- 每文件夹聚合状态 ----------
interface SrcStat {
  oks: number;
  fails: number;
  lastReason?: string;
}

interface FolderStat {
  folderId: string;
  firstSeen: number;
  lastSeen: number;
  srcs: string;
  reqs: number;
  oks: number; // 真图合成成功数
  grayOks: number; // 0 图源合成"成功"数（灰卡占位位图，极易被误判为正常）
  nulls: number;
  noSrcs: number;
  upstreamSrcs: number; // 上游(FolderThumbnail)实际给出的预览 URL 数
  imgChildren: number; // 文件夹内图片子节点数（>0 却没有 URL = 上游没产出）
  // 上游预览加载过程（FolderThumbnail 的 loadPreviews effect）：
  // 该 effect 每次重跑都会 controller.abort() 掉上一次在途请求，而 getThumbnail 被 abort 时
  // 返回的同样是 null。初屏大量重渲染 → 请求被反复打断 → 图源永远填不进去 → 灰卡。
  previewStarts: number; // effect 启动加载次数
  previewAborts: number; // 被 cleanup 打断的次数（关键证据）
  previewNulls: number; // getThumbnail 返回 null 的次数
  lastNullReason?: string;
  retries: number;
  gaveUp: boolean;
  gaveUpAt?: number;
  srcStats: Map<string, SrcStat>;
}

const _folders = new Map<string, FolderStat>();

const folderStat = (folderId: string): FolderStat => {
  let s = _folders.get(folderId);
  if (!s) {
    s = {
      folderId,
      firstSeen: _now(),
      lastSeen: _now(),
      srcs: '-',
      reqs: 0,
      oks: 0,
      grayOks: 0,
      nulls: 0,
      noSrcs: 0,
      upstreamSrcs: 0,
      imgChildren: 0,
      previewStarts: 0,
      previewAborts: 0,
      previewNulls: 0,
      retries: 0,
      gaveUp: false,
      srcStats: new Map(),
    };
    _folders.set(folderId, s);
    if (_folders.size > MAX_FOLDERS) {
      const oldest = _folders.keys().next().value;
      if (oldest !== undefined) _folders.delete(oldest);
    }
  }
  s.lastSeen = _now();
  return s;
};

const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

// ---------- worker → 主线程 诊断回传 ----------
// worker 与主线程各自持有一份本模块状态（模块实例不共享，不是 SharedWorker）。
// composeFull 在 worker 内执行，因此 case (a) no-srcs / case (b) all-or-nothing 这些
// 【合成级】判定，以及解码结果、每文件夹聚合，全都写在 worker 自己的副本里 —— 主线程的
// dump() 永远看不到。故每次合成结束后由 worker 把本地记录整体排空并回传，主线程重放合并。
export interface FolderStatSnapshot {
  folderId: string;
  oks: number;
  grayOks: number;
  nulls: number;
  noSrcs: number;
  lastNullReason?: string;
  srcStats: [string, { oks: number; fails: number }][];
}

export interface DiagSnapshot {
  events: DiagEvent[];
  stats: FolderStatSnapshot[];
  legend: [string, string][];
}

// ---------- 对外 API ----------
export const spriteDiag = {
  enable(on: boolean): void {
    _enabled = on;
  },
  verbose(on: boolean): void {
    _verbose = on;
  },
  /** warn/err 事件是否自动镜像到 console.warn（默认开，便于自动落 webview 日志文件） */
  mirror(on: boolean): void {
    _consoleMirror = on;
  },
  isEnabled(): boolean {
    return _enabled;
  },

  /** 组件发起一次 full 合成请求 */
  req(folderId: string, size: number, srcs: string[]): void {
    const s = folderStat(folderId);
    s.reqs++;
    s.srcs = srcs.length ? srcs.map(shortSrc).join(',') : '(空)';
    push('info', 'req', `请求合成 size=${Math.round(size)} srcs=[${s.srcs}]`, folderId);
  },

  /** 合成成功（真图） */
  ok(folderId: string | undefined, note?: string): void {
    if (!folderId) return;
    const s = folderStat(folderId);
    s.oks++;
    if (s.gaveUp) {
      s.gaveUp = false;
      s.gaveUpAt = undefined;
    }
    push('info', 'compose', `合成成功${note ? ` (${note})` : ''}`, folderId);
  },

  /**
   * 0 图源合成：composeFull 走占位分支返回的是【灰卡占位位图】，且被当作"成功"（组件据此
   * 停止重试，fullCache 也会缓存这份灰卡位图）——这是灰卡的头号机制。count>0 说明文件夹
   * 本应有图却没拿到任何图源 → 记 err 级别（镜像到控制台），否则只是正常空文件夹。
   */
  grayOk(folderId: string | undefined, count: number | undefined): void {
    if (!folderId) return;
    const s = folderStat(folderId);
    s.grayOks++;
    if ((count ?? 0) > 0) {
      push(
        'err',
        'compose',
        `0 图源合成"成功"（灰卡占位位图）count=${count} → 组件视为完成、停止重试，且 fullCache 缓存了灰卡`,
        folderId
      );
    } else {
      push('info', 'compose', '0 图源合成成功（文件夹无图，灰卡属正常）', folderId);
    }
  },

  /** 合成返回 null → 组件保持灰卡占位 */
  fail(folderId: string | undefined, reason: string): void {
    if (!folderId) return;
    const s = folderStat(folderId);
    s.nulls++;
    s.lastNullReason = reason;
    push('warn', 'compose', `合成返回 null (${reason}) → 保持灰卡占位`, folderId);
  },

  /**
   * 上游有图却没有给出任何预览 URL（case a）。
   * composeFull 会用灰卡占位并【返回成功位图】，组件因此不再重试 —— 极易被误判为"正常"。
   */
  noSrcs(folderId: string | undefined, count: number): void {
    if (!folderId) return;
    const s = folderStat(folderId);
    s.noSrcs++;
    push(
      'err',
      'no-srcs',
      `文件夹有 ${count} 张图但 previewSrcs 为空 → 合成灰卡占位位图并被判定为成功（不会再重试）`,
      folderId
    );
  },

  /**
   * 上游（FolderThumbnail）给出的预览图源数量变化。
   * 用于区分「上游压根没产出 URL」与「给了 URL 但 canvas 解码失败」——两者现象都是灰卡。
   */
  upstreamSrcs(folderId: string, srcCount: number, imgChildCount: number): void {
    const s = folderStat(folderId);
    s.upstreamSrcs = srcCount;
    s.imgChildren = imgChildCount;
    const suspicious = imgChildCount > 0 && srcCount === 0;
    push(
      suspicious ? 'err' : 'info',
      'upstream',
      `预览图源 ${srcCount} 个（文件夹内图片子节点 ${imgChildCount} 个）` +
        (suspicious ? ' ← 有图却无图源，canvas 会合成灰卡占位且被判定为成功（不再重试）' : ''),
      folderId
    );
  },

  /**
   * 上游预览加载（FolderThumbnail 的 loadPreviews effect）关键节点。
   * 背景：该 effect 依赖数组里含 loaded / localImageChildren 等，初屏高频重渲染时
   * effect 会反复重跑，每次 cleanup 都 controller.abort() 掉上一次在途请求；
   * 而 getThumbnail 被 abort 时返回的同样是 null（与"缩略图没就绪"无法区分）。
   * 结果：previewSrcs 一直填不进去 → canvas 收到 0 个图源 → 合成灰卡并判定成功 → 不再重试。
   * 表现：硬刷新后灰卡；悬停无效（无图源可画）；滚动后重新挂载从 getGlobalCache() 拿到 URL 即恢复。
   */
  previewLoad(folderId: string, stage: string, srcCount: number, detail?: string): void {
    const s = folderStat(folderId);
    const suffix = detail ? ` (${detail})` : '';
    if (stage === 'start') {
      s.previewStarts++;
      push('info', 'preview', `开始加载预览图（${srcCount} 张）`, folderId);
      return;
    }
    if (stage.startsWith('abort')) {
      s.previewAborts++;
      push('warn', 'preview', `在途请求被 cleanup abort${suffix} → 结果被丢弃`, folderId);
      return;
    }
    if (stage === 'null') {
      s.previewNulls++;
      push('warn', 'preview', `getThumbnail 返回 null（未就绪/生成中/被中断，三种语义合并）${suffix}`, folderId);
      return;
    }
    if (stage.startsWith('throw')) {
      s.previewAborts++;
      push('err', 'preview', `加载抛错${suffix}`, folderId);
      return;
    }
    push('info', 'preview', `${stage}${suffix}`, folderId);
  },

  /** 单个 src 的解码结果（loadImage / worker decode 共用） */
  srcResult(src: string, ok: boolean, reason: string, ms?: number): void {
    const id = shortSrc(src);
    const cost = ms === undefined ? '' : ` ${Math.round(ms)}ms`;
    push(
      ok ? 'info' : 'warn',
      'decode',
      `${id}${ok ? ' 解码成功' : ' 解码失败'}${reason ? ` (${reason})` : ''}${cost}`
    );
  },

  /** 整批解码结果：记录哪些下标没解出来（case b：部分失败即整张作废） */
  decodeBatch(folderId: string | undefined, srcs: string[], imgs: unknown[]): void {
    const failed = srcs.map((_, i) => (imgs[i] ? -1 : i)).filter(i => i >= 0);
    if (folderId) {
      const st = folderStat(folderId);
      srcs.forEach((s, i) => {
        const id = shortSrc(s);
        const cur = st.srcStats.get(id) || { oks: 0, fails: 0 };
        if (imgs[i]) cur.oks++;
        else cur.fails++;
        st.srcStats.set(id, cur);
      });
    }
    if (failed.length === 0) return;
    const ids = failed.map(i => shortSrc(srcs[i]));
    push(
      'warn',
      'decode',
      `${failed.length}/${srcs.length} 张未解出 failedIdx=[${failed}] src=[${ids}]` +
        (failed.length < srcs.length ? ' ← 部分失败即整张作废(all-or-nothing)' : ''),
      folderId
    );
  },

  /** 组件安排第 n 次退避重试 */
  retry(folderId: string, n: number, delay: number): void {
    const s = folderStat(folderId);
    s.retries = n;
    push('warn', 'retry', `第 ${n} 次退避重试，${delay}ms 后（注意：若处于 8s 冷却窗口内会直接返回 null）`, folderId);
  },

  /**
   * 悬停时图源为空。悬停动画 drawHoverFrame 也依赖 srcsRef：图源为空时只能画灰卡占位，
   * 因此「悬停无法让缩略图出现」是 previewSrcs 上游未产出的直接旁证（而非合成/解码失败）。
   */
  hoverNoSrcs(folderId: string): void {
    const s = folderStat(folderId);
    push('warn', 'hover', `悬停触发但 previewSrcs 为空 → 只能画灰卡占位（图源缺失，非解码失败）`, folderId);
    void s;
  },

  /** 重试预算耗尽 → 停止重试（case c） */
  giveUp(folderId: string): void {
    const s = folderStat(folderId);
    s.gaveUp = true;
    s.gaveUpAt = _now();
    push(
      'err',
      'giveUp',
      `重试预算耗尽，彻底停止重试 → 若此刻仍未拿到真图，该文件夹将永久停在灰卡`,
      folderId
    );
  },

  /** 合成路由（worker / inline 主线程）结果（case d） */
  route(folderId: string, route: string, ok: boolean): void {
    push(ok ? 'info' : 'warn', 'route', `${route} ${ok ? '成功' : '失败或返回 null'}`, folderId);
  },

  /** Worker 被永久禁用（探测到无法解码当前资源协议） */
  workerDisabled(reason: string): void {
    push('err', 'worker', `Worker 已永久禁用：${reason}`);
  },

  /** 当前疑似卡在灰卡的文件夹 */
  stuck(): FolderStat[] {
    return [..._folders.values()].filter(s => {
      // 从未"真图合成"成功
      if (s.oks > 0) return false;
      // 直接失败 / 放弃重试 / 上游请求被打断
      if (s.gaveUp || s.nulls > 0 || s.previewAborts > 0) return true;
      // 灰卡占位"成功"过（0 图源被当作成功、永不重试）且文件夹确实有图片子节点
      // → 长期停在灰卡的直接证据（此前 stuck()=0 就是漏了这一类）
      if (s.grayOks > 0 && s.imgChildren > 0) return true;
      return false;
    });
  },

  /** 【worker 侧】排空本地全部记录，随合成结果回传主线程 */
  drainAll(): DiagSnapshot {
    const events = _events.slice();
    _events.length = 0;
    const stats: FolderStatSnapshot[] = [];
    for (const s of _folders.values()) {
      if (s.oks === 0 && s.grayOks === 0 && s.nulls === 0 && s.noSrcs === 0 && s.srcStats.size === 0) continue;
      stats.push({
        folderId: s.folderId,
        oks: s.oks,
        grayOks: s.grayOks,
        nulls: s.nulls,
        noSrcs: s.noSrcs,
        lastNullReason: s.lastNullReason,
        srcStats: [...s.srcStats.entries()],
      });
    }
    _folders.clear();
    return { events, stats, legend: [..._idToSrc.entries()] };
  },

  /** 【主线程侧】重放 worker 回传的记录（事件 + 每文件夹聚合 + src 图例） */
  replayAll(snap: DiagSnapshot | undefined): void {
    if (!snap) return;
    // 图例先合并，保证后续事件里的 W<n> 能在 dump 末尾查到真实 URL
    if (snap.legend && snap.legend.length) {
      for (const [id, src] of snap.legend) {
        if (!_idToSrc.has(id)) _idToSrc.set(id, src);
        if (!_srcToId.has(src)) _srcToId.set(src, id);
      }
    }
    if (snap.events && snap.events.length) {
      for (const e of snap.events) {
        // 两端 performance.now() 基准不同：t 按主线程重算，wall（墙上时间）保留 worker 原值
        _events.push({ ...e, t: _now() });
        // worker 里 console.warn 不可见，需在主线程重放时补一次镜像
        if (_consoleMirror && e.level !== 'info' && typeof console !== 'undefined') {
          const f = e.folder ? `[folder=${e.folder}] ` : '';
          console.warn(`[SPRITE_DIAG] ${e.tag} ${f}${e.msg}`);
        }
      }
      if (_events.length > MAX_EVENTS) _events.splice(0, _events.length - MAX_EVENTS);
    }
    if (snap.stats && snap.stats.length) {
      for (const s of snap.stats) {
        const cur = folderStat(s.folderId);
        cur.oks += s.oks;
        cur.grayOks += s.grayOks;
        cur.nulls += s.nulls;
        cur.noSrcs += s.noSrcs;
        if (s.lastNullReason) cur.lastNullReason = s.lastNullReason;
        for (const [id, st] of s.srcStats) {
          const c = cur.srcStats.get(id) || { oks: 0, fails: 0 };
          c.oks += st.oks;
          c.fails += st.fails;
          cur.srcStats.set(id, c);
        }
      }
    }
  },

  /**
   * Folder3DIconCanvas 挂载时调用。用于自检确认当前渲染的是 Canvas 版而非 DOM 版 ——
   * 图标样式不是 canvas 时，FolderThumbnail 会渲染 DOM 版 Folder3DIcon，埋点不会有任何记录。
   */
  canvasMounted(): void {
    _canvasMounts++;
  },

  /** 当前诊断器运行状态（自检用） */
  status(): {
    enabled: boolean;
    verbose: boolean;
    events: number;
    folders: number;
    canvasMounts: number;
    reqs: number;
    oks: number;
    nulls: number;
    giveUps: number;
  } {
    const all = [..._folders.values()];
    return {
      enabled: _enabled,
      verbose: _verbose,
      events: _events.length,
      folders: all.length,
      canvasMounts: _canvasMounts,
      reqs: all.reduce((a, s) => a + s.reqs, 0),
      oks: all.reduce((a, s) => a + s.oks, 0),
      nulls: all.reduce((a, s) => a + s.nulls, 0),
      giveUps: all.filter(s => s.gaveUp).length,
    };
  },

  /** 清空记录；返回一段文案，便于在控制台直接确认生效 */
  reset(): string {
    _events.length = 0;
    _folders.clear();
    _canvasMounts = 0;
    return '[SPRITE_DIAG] 已清空记录（canvas 挂载计数同时归零，滚动列表后会重新累计）';
  },

  /** 输出完整诊断文本 */
  dump(): string {
    const L: string[] = [];
    const all = [..._folders.values()];
    const totalReq = all.reduce((a, s) => a + s.reqs, 0);
    const totalOk = all.reduce((a, s) => a + s.oks, 0);
    const totalNull = all.reduce((a, s) => a + s.nulls, 0);
    const totalGiveUp = all.filter(s => s.gaveUp).length;

    L.push('========== SPRITE 缩略图诊断 ==========');
    L.push(
      `启动至今 ${fmtSec(_now())} | 记录=${_enabled ? 'on' : 'off'} verbose=${_verbose ? 'on' : 'off'} | ` +
        `文件夹 ${all.length} | 请求 ${totalReq} | 成功 ${totalOk} | 返回null ${totalNull} | 已放弃 ${totalGiveUp}`
    );
    L.push('');

    const stuck = this.stuck();
    L.push(`--- 疑似卡在灰卡的文件夹 (${stuck.length}) ---`);
    if (stuck.length === 0) L.push('(无)');
    for (const s of stuck.slice(0, 40)) {
      L.push(
        `folder=${s.folderId}\n` +
          `   srcs=[${s.srcs}] reqs=${s.reqs} ok=${s.oks} grayOk=${s.grayOks} null=${s.nulls} noSrcs=${s.noSrcs} ` +
          `retry=${s.retries}${s.gaveUp ? ` GAVE_UP@${fmtSec(s.gaveUpAt || 0)}` : ''} ` +
          `lastNull=${s.lastNullReason || '-'} age=${fmtSec(_now() - s.firstSeen)}\n` +
          `   上游图源=${s.upstreamSrcs} 图片子节点=${s.imgChildren} ` +
          `上游加载: start×${s.previewStarts} abort×${s.previewAborts} null×${s.previewNulls}`
      );
      for (const [id, st] of s.srcStats) {
        L.push(`   ${id}: ok×${st.oks} fail×${st.fails}`);
      }
    }
    L.push('');

    L.push(`--- 事件时间线（最近 ${_events.length} 条，默认仅 warn/err）---`);
    for (const e of _events) {
      const f = e.folder ? ` [${e.folder}]` : '';
      L.push(
        `[${String(Math.round(e.t)).padStart(7)}ms ${e.wall}] ${e.level.toUpperCase().padEnd(4)} ` +
          `${e.tag.padEnd(11)}${f} ${e.msg}`
      );
    }
    L.push('');

    L.push(`--- src 图例 (${_idToSrc.size}) ---`);
    for (const [id, src] of _idToSrc) L.push(`${id}: ${src}`);

    return L.join('\n');
  },
};
