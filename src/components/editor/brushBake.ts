/**
 * 画笔烘焙的文件面。性能方案（2026-10-25）：**显示与落盘分离**。
 *
 * - 抬笔瞬间：预分配一个文件路径，把内存画布登记进 paintBuffers、source 立刻换
 *   过去——显示走内存画布（零编码、即时），撤销步立刻落地；
 * - PNG 编码 + IPC 落盘是**串行后台任务**（`enqueueBake`）：编码大层要几百毫秒、
 *   base64 过 IPC 又要几百毫秒，挡在抬笔路径上就是"等 0.5–2 秒才显示"的元凶；
 * - 读文件的消费方（导出 / 保存工程 / 全览 / 缩略图）入口处 `await flushPaintBakes()`，
 *   保证它们看到的文件不落后于画面。
 *
 * ⚠️ 读原图走 `read_file_as_base64`（自定义 IPC，返回的是**完整 dataUrl**，要剥前缀），
 * 写盘走 `editor_write_paint_png`（base64 进、绝对路径出）——plugin-fs 的 scope 会拦
 * 用户任意目录的绝对路径（2026-10-24 实测 forbidden path），自定义命令不受限。
 */

/** 缓存目录只问一次（会话级缓存；失败不缓存，下次重试）。 */
let paintDirPromise: Promise<string> | null = null;

export function getPaintDir(): Promise<string> {
  if (!paintDirPromise) {
    paintDirPromise = (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string>('editor_paint_cache_dir');
    })();
    paintDirPromise.catch(() => {
      paintDirPromise = null; // 失败不粘住：下一次作画重新问
    });
  }
  return paintDirPromise;
}

/** 预分配文件名（前端序号防同毫秒碰撞；Rust 侧校验字符白名单）。 */
let nameSeq = 0;
function nextPaintName(): string {
  nameSeq += 1;
  return `stroke-${Date.now().toString(36)}-${nameSeq}.png`;
}

/** 预分配一个"未来的烘焙文件"绝对路径（内容稍后由 enqueueBake 补上）。 */
export async function allocatePaintPath(): Promise<string> {
  const dir = await getPaintDir();
  return `${dir.replace(/[\\/]$/, '')}/${nextPaintName()}`;
}

async function encodeAndWrite(canvas: HTMLCanvasElement, name: string): Promise<string> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas 无法编码为 PNG');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 分块转 base64：String.fromCharCode 一次吃几十 MB 会爆调用栈
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const info = (await import('../../utils/logger')).info;
  info(`[画笔] 烘焙编码完成 ${canvas.width}x${canvas.height}，${bytes.length} 字节，后台落盘…`);
  return invoke<string>('editor_write_paint_png', { base64: btoa(bin), name });
}

// ---- 串行烘焙队列：编码/IPC 都慢，并发跑会乱序换源（后完成的旧笔覆盖新笔） ----

let bakeChain: Promise<unknown> = Promise.resolve();

/**
 * 排一个后台烘焙任务。失败只记日志不抛（画面已经是新内容，丢的是文件——
 * flush 侧的导出/保存会暴露成明确报错，比静默好排查）。
 */
export function enqueueBake(task: () => Promise<string>): void {
  bakeChain = bakeChain.then(async () => {
    try {
      const path = await task();
      (await import('../../utils/logger')).info(`[画笔] 烘焙落盘成功：${path}`);
    } catch (e) {
      (await import('../../utils/logger')).error('[画笔] 后台烘焙失败（导出/保存会读到旧文件）：', String(e));
    }
  });
}

/** 等所有排队的烘焙落盘（导出 / 保存工程 / 全览 / 缩略图入口调用）。 */
export function flushPaintBakes(): Promise<unknown> {
  return bakeChain;
}

/** 把画布内容烘焙到**预分配**的路径（name = allocatePaintPath 生成的文件名）。 */
export function bakeCanvasToPath(canvas: HTMLCanvasElement, absPath: string): Promise<string> {
  const name = absPath.slice(absPath.replace(/[\\/]/g, '/').lastIndexOf('/') + 1);
  return encodeAndWrite(canvas, name);
}

/** 一张全透明的空白画布（新建空白图层的初始像素，也直接进缓冲注册表即时显示）。 */
export function blankCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
