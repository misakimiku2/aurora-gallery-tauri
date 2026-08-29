import { FileNode, FileType } from '../../types';
import { generateId } from '../../utils/pathUtils';
import {
  AuthResponse,
  BrowseItem,
  BrowseResponse,
  ConnectedDevice,
  DevicesResponse,
  OperationResponse,
} from '../../lan-share/api';

/**
 * LAN client API for the Android client mode. Unlike `lanShareApi` (which uses
 * an empty same-origin `API_BASE`), this module talks to a remote desktop
 * server, so the base URL (`http://{host}:{port}`) and session token are
 * injected dynamically after the user connects.
 */
class LanClientApi {
  private baseUrl: string | null = null;
  private token: string | null = null;
  private static readonly DEVICE_ID_KEY = 'aurora_lan_device_id';
  // 安卓 WebView 启动时网络栈可能尚未就绪，fetch 会永久挂起（既不 resolve
  // 也不 reject），导致上层 lanLoadingRef 卡死、所有重试被阻塞。用
  // AbortController 给每个请求加超时，超时后视为网络错误触发重试。
  private static readonly FETCH_TIMEOUT_MS = 15000;

  setBaseUrl(url: string): void {
    // Normalize to `http://{host}:{port}` with no trailing slash.
    this.baseUrl = url.replace(/\/+$/, '');
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  getToken(): string | null {
    return this.token;
  }

  isConnected(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * 带超时的 fetch 封装。超时后 abort 并抛出网络错误，避免安卓网络未就绪时
   * fetch 永久挂起导致上层重试逻辑被 lanLoadingRef 卡死。
   */
  private async fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    timeoutMs: number = LanClientApi.FETCH_TIMEOUT_MS
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(
          `Network timeout: no response from ${this.baseUrl} within ${timeoutMs / 1000}s`
        );
      }
      throw new Error(
        `Network error: unable to reach ${this.baseUrl}. ${(err as Error).message}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 返回持久化的设备标识。首次调用时生成并写入 localStorage，
   * 后续重连复用同一 ID，让服务端按 device_id 覆盖旧会话而非累加。
   */
  getDeviceId(): string {
    const fallback = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const existing = localStorage.getItem(LanClientApi.DEVICE_ID_KEY);
      if (existing) {
        return existing;
      }
      const uuid = (crypto as any)?.randomUUID?.();
      const newId: string = typeof uuid === 'string' ? uuid : fallback;
      localStorage.setItem(LanClientApi.DEVICE_ID_KEY, newId);
      return newId;
    } catch {
      // localStorage 不可用时回退到临时 ID（每次刷新会变，但仍优于无标识）
      return fallback;
    }
  }

  /**
   * 断开连接。先清空本地状态（让 UI 立即响应），再尽力通知服务器登出
   * （清理 session/device 计数）。logout 请求用较短超时，失败时静默处理。
   */
  async disconnect(): Promise<void> {
    const base = this.baseUrl;
    const token = this.token;
    // 先清空本地状态，避免 fetch 挂起时 UI 仍显示"已连接"
    this.baseUrl = null;
    this.token = null;
    if (base && token) {
      try {
        await this.fetchWithTimeout(
          `${base}/api/auth/logout`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          },
          5000
        );
      } catch {
        // 网络错误或服务器不可达：忽略，本地状态已清空
      }
    }
  }

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('Not connected: base URL is not set');
    }
    const headers: HeadersInit = { ...options?.headers };
    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await this.fetchWithTimeout(`${this.baseUrl}${url}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.token = null;
        throw new Error('Authentication failed or token expired. Please reconnect.');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async authenticate(
    code: string,
    deviceName?: string,
    peerServer?: { port: number; accessCode: string }
  ): Promise<AuthResponse> {
    if (!this.baseUrl) {
      throw new Error('Not connected: base URL is not set');
    }
    // Auth verify returns 200 with { success: false, error } on a wrong code,
    // so this must NOT go through fetchJson (which throws on non-2xx). We only
    // set the token when the server confirms success.
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        device_name: deviceName || this.getDeviceName(),
        device_id: this.getDeviceId(),
        // 双向连接融合：携带本机服务端信息，让对端自动反向连接本机
        ...(peerServer && peerServer.accessCode
          ? {
              peer_server: {
                port: peerServer.port,
                access_code: peerServer.accessCode,
              },
            }
          : {}),
      }),
    });

    const data: AuthResponse = await response.json();
    if (data.success && data.token) {
      this.token = data.token;
    }
    return data;
  }

  async browse(path: string): Promise<BrowseResponse> {
    return this.fetchJson<BrowseResponse>(
      `/api/browse?path=${encodeURIComponent(path)}`
    );
  }

  async search(query: string, scope?: string): Promise<BrowseResponse> {
    let url = `/api/search?q=${encodeURIComponent(query)}`;
    if (scope) {
      url += `&scope=${encodeURIComponent(scope)}`;
    }
    return this.fetchJson<BrowseResponse>(url);
  }

  async getDevices(): Promise<ConnectedDevice[]> {
    const res = await this.fetchJson<DevicesResponse>(`/api/devices`);
    return res.devices;
  }

  getThumbnailUrl(remotePath: string): string {
    const base = this.baseUrl || '';
    return `${base}/api/thumbnail?path=${encodeURIComponent(remotePath)}&size=256&token=${encodeURIComponent(
      this.token || ''
    )}`;
  }

  async getPalette(remotePath: string): Promise<string[]> {
    const res = await this.fetchJson<{ palette: string[] }>(`/api/palette?path=${encodeURIComponent(remotePath)}`);
    return res.palette || [];
  }

  getImageUrl(remotePath: string): string {
    const base = this.baseUrl || '';
    return `${base}/api/image?path=${encodeURIComponent(remotePath)}&token=${encodeURIComponent(
      this.token || ''
    )}`;
  }

  async deleteFile(remotePath: string): Promise<OperationResponse> {
    return this.fetchJson<OperationResponse>(
      `/api/file?path=${encodeURIComponent(remotePath)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Browse a remote folder and convert the response into `FileNode`s tagged with
   * `source: 'lan'`. Parent linkage is left null for the caller to wire up.
   */
  async browseToFolderNodes(
    path: string
  ): Promise<{ folders: FileNode[]; images: FileNode[]; allowEdit: boolean; allowUpload: boolean }> {
    const response = await this.browse(path);
    const folders = response.folders.map((item) => this.folderItemToFileNode(item));
    const images = response.images.map((item) => this.imageItemToFileNode(item));
    return { folders, images, allowEdit: !!response.allow_edit, allowUpload: !!response.allow_upload };
  }

  /**
   * 递归获取所有直接包含图片/视频的文件夹（扁平列表）+ 根目录散落图片。
   * 过滤掉只有子文件夹的中间目录——与本地相册策略一致。
   */
  async getAllImageFolders(): Promise<{ folders: FileNode[]; rootImages: FileNode[]; allowEdit: boolean; allowUpload: boolean }> {
    const response = await this.fetchJson<{
      folders: BrowseItem[];
      root_images: BrowseItem[];
      allow_edit?: boolean;
      allow_upload?: boolean;
    }>('/api/all_image_folders');
    const folders = response.folders.map((item) => this.folderItemToFileNode(item));
    const rootImages = response.root_images.map((item) => this.imageItemToFileNode(item));
    return { folders, rootImages, allowEdit: !!response.allow_edit, allowUpload: !!response.allow_upload };
  }

  private folderItemToFileNode(item: BrowseItem): FileNode {
    const remotePath = item.path;
    // 服务端返回的多张预览图：保留前 3 张，供桌面端文件夹堆叠封面使用
    const previewRemotes = (item.preview_images || []).slice(0, 3);
    return {
      id: generateId(remotePath),
      parentId: null,
      name: item.name,
      type: FileType.FOLDER,
      path: 'lan://' + remotePath,
      remotePath,
      source: 'lan',
      children: [],
      tags: [],
      coverImagePath: previewRemotes[0] ? 'lan://' + previewRemotes[0] : undefined,
      coverImagePaths: previewRemotes.length > 0 ? previewRemotes.map((p) => 'lan://' + p) : undefined,
      coverImageWidth: item.width || undefined,
      coverImageHeight: item.height || undefined,
      imageCount: typeof item.size === 'number' ? item.size : 0,
      createdAt: item.modified_at ? new Date(item.modified_at * 1000).toISOString() : undefined,
    };
  }

  private imageItemToFileNode(item: BrowseItem): FileNode {
    const remotePath = item.path;
    const size = item.size;
    const width = item.width;
    const height = item.height;
    const format = item.name.includes('.')
      ? item.name.slice(item.name.lastIndexOf('.') + 1).toLowerCase()
      : '';
    const isVideo = item.type === 'video';
    return {
      id: generateId(remotePath),
      parentId: null,
      name: item.name,
      type: FileType.IMAGE,
      path: 'lan://' + remotePath,
      remotePath,
      source: 'lan',
      tags: [],
      size,
      meta: {
        width: width || 0,
        height: height || 0,
        sizeKb: size && size > 0 ? Math.round(size / 1024) : 0,
        created: '',
        modified: '',
        format: isVideo ? `video/${format}` : format,
        palette: item.palette,
      },
    };
  }

  /**
   * Upload a local file to the desktop server. Sends multipart/form-data with
   * fields `file` and `target_dir`. The desktop server's `/api/upload` endpoint
   * handles the upload and saves the file to the specified directory.
   */
  async uploadFile(
    file: File | Blob,
    targetDir: string,
    fileName: string
  ): Promise<OperationResponse> {
    if (!this.baseUrl) {
      throw new Error('Not connected: base URL is not set');
    }
    const formData = new FormData();
    const fileBlob: Blob = file;
    formData.append('file', fileBlob, fileName);
    formData.append('target_dir', targetDir);

    const headers: HeadersInit = {};
    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }
    // Do NOT set Content-Type: the browser must set the multipart boundary.

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    return response.json();
  }

  /**
   * 心跳：通知服务器本设备仍在线。服务端按 ONLINE_TIMEOUT_SECS（90s）判定
   * 在线状态，客户端每 30s 发送一次。失败时静默（下次心跳会重试）。
   */
  async heartbeat(): Promise<void> {
    await this.fetchJson('/api/heartbeat');
  }

  /**
   * 从 User-Agent 解析设备型号（如 SM-X906C）。注意：Android 系统 API
   * 只提供型号代号，不提供"Galaxy Tab S8+"这类市场名，因此这里返回的
   * 是型号代号，用户可在客户端面板覆盖为自定义名称。
   */
  getDeviceName(): string {
    const ua = navigator.userAgent;
    if (/Android/.test(ua)) {
      // UA 形如 `Android 13; SM-X906C Build/TQ3A.230902.001; wv)`，
      // 旧正则会把 `Build/...` 一起捕获导致超长被丢弃，这里用 lookahead
      // 在 ` Build` 或 `;`/`)` 处停止，只取型号代号。
      const match = ua.match(/Android\s*[\d.]+;\s*([^;)]+?)(?=\s+Build|[;)])/i);
      if (match && match[1]) {
        const model = match[1].trim();
        if (model.length >= 3 && model.length < 30) {
          return model;
        }
      }
      return /Mobile/i.test(ua) ? 'Android 手机' : 'Android 平板';
    }
    if (/iPad/.test(ua)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Unknown Device';
  }
}

export const lanClientApi = new LanClientApi();
