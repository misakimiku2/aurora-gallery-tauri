type PendingTask = {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
};

class ImageDecodeWorkerPool {
  private workers: Worker[] = [];
  private pendingTasks: Map<string, PendingTask> = new Map();
  private workerIndex: number = 0;
  private idCounter: number = 0;
  private _isAvailable: boolean = false;

  constructor(poolSize: number = 2) {
    this._isAvailable = typeof createImageBitmap !== 'undefined';
    if (!this._isAvailable) return;

    try {
      const workerUrl = new URL(
        '../workers/image-decode.worker.ts',
        import.meta.url
      );

      for (let i = 0; i < poolSize; i++) {
        const worker = new Worker(workerUrl, { type: 'module' });
        worker.onmessage = this.handleMessage.bind(this);
        worker.onerror = this.handleError.bind(this);
        this.workers.push(worker);
      }
    } catch (e) {
      console.warn('[ImageDecodeWorker] Failed to create worker pool, falling back to main thread:', e);
      this._isAvailable = false;
    }
  }

  get isAvailable(): boolean {
    return this._isAvailable && this.workers.length > 0;
  }

  async decode(url: string): Promise<ImageBitmap> {
    if (!this.isAvailable) {
      return this.fallbackDecode(url);
    }

    const id = `${++this.idCounter}`;
    const worker = this.workers[this.workerIndex];
    this.workerIndex = (this.workerIndex + 1) % this.workers.length;

    return new Promise<ImageBitmap>((resolve, reject) => {
      this.pendingTasks.set(id, { resolve, reject });
      worker.postMessage({ id, url });
    });
  }

  private handleMessage(e: MessageEvent): void {
    const { id } = e.data;

    const task = this.pendingTasks.get(id);
    if (!task) return;

    this.pendingTasks.delete(id);

    if (e.data.imageBitmap) {
      task.resolve(e.data.imageBitmap);
    } else if (e.data.error) {
      task.reject(new Error(e.data.error));
    } else {
      task.reject(new Error('Unknown worker response'));
    }
  }

  private handleError(e: ErrorEvent): void {
    console.error('[ImageDecodeWorker] Worker error:', e.message);
  }

  private async fallbackDecode(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    const blob = await response.blob();
    return createImageBitmap(blob, {
      premultiplyAlpha: 'premultiply',
      colorSpaceConversion: 'default',
      resizeQuality: 'medium',
    });
  }

  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];

    for (const [, task] of this.pendingTasks) {
      task.reject(new Error('Worker pool terminated'));
    }
    this.pendingTasks.clear();
    this._isAvailable = false;
  }
}

let _pool: ImageDecodeWorkerPool | null = null;

export const getImageDecodePool = (): ImageDecodeWorkerPool => {
  if (!_pool) {
    _pool = new ImageDecodeWorkerPool(2);
  }
  return _pool;
};

export const terminateImageDecodePool = (): void => {
  if (_pool) {
    _pool.terminate();
    _pool = null;
  }
};

export { ImageDecodeWorkerPool };
