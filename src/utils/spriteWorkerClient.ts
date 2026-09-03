// Sprite Worker 客户端：懒加载 sprite-worker，封装请求/应答协议。
//
// 职责：
//   - 首次使用才 spawn Worker（能力检测：Worker + OffscreenCanvas.transferToImageBitmap）。
//   - 每个 compose 请求按 reqId 路由回对应 resolver；结果 ImageBitmap 走 transferable。
//   - worker 异常/不支持时 disable()：终止 worker、清空 pending（resolve null），
//     spriteCache 检测到不可用后回退主线程内联合成路径。
//   - 主线程 fullCache/队列/滚动门控逻辑保持不变，worker 只负责"干活"。

import { isSpriteSupported } from './spriteComposer';
import { spriteDiag, type DiagSnapshot } from './spriteDiag';

export interface SpriteComposeParams {
  previewSrcs: string[];
  count: number | undefined;
  category: string;
  theme: string;
  size: number;
  dpr: number;
  folderId?: string; // 仅用于诊断关联
}

class SpriteWorkerClient {
  private worker: Worker | null = null;
  private ready = false;
  private failed = false;
  private initStarted = false;
  private initWaiters: ((ok: boolean) => void)[] = [];
  private seq = 0;
  private pending = new Map<number, (bmp: ImageBitmap | null) => void>();

  get usable(): boolean {
    return this.ready;
  }

  /** 懒初始化（幂等），返回是否可用 */
  init(): Promise<boolean> {
    if (this.ready || this.failed) return Promise.resolve(this.ready);
    if (this.initStarted) {
      return new Promise(res => this.initWaiters.push(res));
    }
    this.initStarted = true;
    return new Promise<boolean>(resolve => {
      try {
        if (typeof Worker === 'undefined' || !isSpriteSupported()) {
          this.failed = true;
        } else {
          this.worker = new Worker(new URL('../workers/sprite-worker.ts', import.meta.url), { type: 'module' });
          this.worker.onmessage = (e: MessageEvent) => {
            const { reqId, bmp, diag } = (e.data || {}) as {
              reqId: number;
              bmp: ImageBitmap | null;
              diag?: DiagSnapshot;
            };
            // 重放 worker 侧记录：worker 与主线程模块状态相互独立，不重放的话
            // worker 内的解码失败原因、no-srcs / all-or-nothing 判定永远进不了 dump()。
            spriteDiag.replayAll(diag);
            const cb = this.pending.get(reqId);
            if (cb) {
              this.pending.delete(reqId);
              cb(bmp ?? null);
            }
          };
          this.worker.onerror = () => this.disable();
          this.ready = true;
        }
      } catch {
        this.ready = false;
        this.failed = true;
        if (this.worker) {
          try { this.worker.terminate(); } catch { /* */ }
          this.worker = null;
        }
      }
      this.initWaiters.forEach(w => w(this.ready));
      this.initWaiters = [];
      resolve(this.ready);
    });
  }

  /** 请求合成一张完整位图；worker 不可用/异常时返回 null（调用方回退主线程合成） */
  requestFull(p: SpriteComposeParams): Promise<ImageBitmap | null> {
    if (!this.ready || !this.worker) return Promise.resolve(null);
    const reqId = ++this.seq;
    return new Promise(resolve => {
      this.pending.set(reqId, resolve);
      this.worker!.postMessage({ type: 'compose', reqId, ...p });
    });
  }

  /** 永久禁用（worker 不支持当前资源/宿主、或发生致命错误），调用方回退主线程 */
  disable(): void {
    this.ready = false;
    this.failed = true;
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* */ }
      this.worker = null;
    }
    for (const [, cb] of this.pending) cb(null);
    this.pending.clear();
  }
}

export const spriteWorkerClient = new SpriteWorkerClient();