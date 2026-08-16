import { FileNode, FileType } from '../../types';
import { generateId } from '../../utils/pathUtils';
import {
  AuthResponse,
  BrowseItem,
  BrowseResponse,
  ConnectedDevice,
  DevicesResponse,
} from '../../lan-share/api';

/**
 * 桌面端 → 安卓设备 HTTP 客户端（多设备架构）。
 *
 * 每台安卓设备对应一个 `AndroidDeviceClient` 实例（独立 baseUrl/token），
 * 由 `androidClientRegistry` 按设备 key（"host:port"）管理。
 * 文件路径采用 `android://<key>/<mediaStoreId>` 编码设备归属，
 * 供 remoteSource 分发到正确的设备连接。
 */

const FETCH_TIMEOUT_MS = 15000;
const DEVICE_ID_KEY = 'aurora_desktop_android_device_id';

/** 持久化的桌面端设备标识（各台安卓设备共用同一桌面身份）。 */
export function getAndroidDesktopDeviceId(): string {
  const fallback = `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const uuid = (crypto as any)?.randomUUID?.();
    const newId: string = typeof uuid === 'string' ? uuid : fallback;
    localStorage.setItem(DEVICE_ID_KEY, newId);
    return newId;
  } catch {
    return fallback;
  }
}

/** 桌面端设备名（安卓端设备列表展示用）。 */
export function getAndroidDesktopDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Desktop';
}

/** 设备 key（稳定标识） = "host:port"。 */
export const androidDeviceKeyOf = (host: string, port: number): string =>
  `${host.trim()}:${port}`;

/** 从设备 key 解析 host/port。 */
export const parseAndroidDeviceKey = (
  key: string
): { host: string; port: number } | null => {
  const idx = key.lastIndexOf(':');
  if (idx <= 0) return null;
  const port = parseInt(key.slice(idx + 1), 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: key.slice(0, idx), port };
};

/** 单台安卓设备的 HTTP 客户端。 */
export class AndroidDeviceClient {
  readonly key: string;
  private baseUrl: string;
  private token: string | null = null;

  constructor(key: string, baseUrl: string) {
    this.key = key;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    timeoutMs: number = FETCH_TIMEOUT_MS
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

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
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
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        device_name: deviceName || getAndroidDesktopDeviceName(),
        device_id: getAndroidDesktopDeviceId(),
        // 双向连接融合：携带本机（桌面端）服务端信息，让手机自动反向连接桌面
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

  /** 断开：先清 token，再尽力通知服务器登出。 */
  async disconnect(): Promise<void> {
    const token = this.token;
    this.token = null;
    if (token) {
      try {
        await this.fetchWithTimeout(
          `${this.baseUrl}/api/auth/logout`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          },
          5000
        );
      } catch {
        // 服务器不可达时忽略
      }
    }
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

  getThumbnailUrl(mediaStoreId: string): string {
    return `${this.baseUrl}/api/thumbnail?path=${encodeURIComponent(
      mediaStoreId
    )}&size=256&token=${encodeURIComponent(this.token || '')}`;
  }

  getImageUrl(mediaStoreId: string): string {
    return `${this.baseUrl}/api/image?path=${encodeURIComponent(
      mediaStoreId
    )}&token=${encodeURIComponent(this.token || '')}`;
  }

  async getPalette(mediaStoreId: string): Promise<string[]> {
    const res = await this.fetchJson<{ palette: string[] }>(
      `/api/palette?path=${encodeURIComponent(mediaStoreId)}`
    );
    return res.palette || [];
  }

  /** 浏览安卓端文件夹（bucketId），转换为携带设备 key 的 FileNode。 */
  async browseToFolderNodes(
    bucketId: string
  ): Promise<{ folders: FileNode[]; images: FileNode[]; allowEdit: boolean; allowUpload: boolean }> {
    const response = await this.browse(bucketId);
    const folders = response.folders.map((item) => this.folderItemToFileNode(item));
    const images = response.images.map((item) => this.imageItemToFileNode(item));
    return {
      folders,
      images,
      allowEdit: !!response.allow_edit,
      allowUpload: !!response.allow_upload,
    };
  }

  /** 所有含图文件夹（扁平列表）+ 根目录散落图片。 */
  async getAllImageFolders(): Promise<{
    folders: FileNode[];
    rootImages: FileNode[];
    allowEdit: boolean;
    allowUpload: boolean;
  }> {
    const response = await this.fetchJson<{
      folders: BrowseItem[];
      root_images: BrowseItem[];
      allow_edit?: boolean;
      allow_upload?: boolean;
    }>('/api/all_image_folders');
    const folders = response.folders.map((item) => this.folderItemToFileNode(item));
    const rootImages = response.root_images.map((item) => this.imageItemToFileNode(item));
    return {
      folders,
      rootImages,
      allowEdit: !!response.allow_edit,
      allowUpload: !!response.allow_upload,
    };
  }

  private folderItemToFileNode(item: BrowseItem): FileNode {
    const remotePath = item.path;
    const coverRemote =
      item.preview_images && item.preview_images.length > 0
        ? item.preview_images[0]
        : undefined;
    return {
      id: generateId(`android://${this.key}/${remotePath}`),
      parentId: null,
      name: item.name,
      type: FileType.FOLDER,
      path: `android://${this.key}/${remotePath}`,
      remotePath,
      remoteDeviceKey: this.key,
      source: 'android',
      children: [],
      tags: [],
      coverImagePath: coverRemote ? `android://${this.key}/${coverRemote}` : undefined,
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
    return {
      id: generateId(`android://${this.key}/${remotePath}`),
      parentId: null,
      name: item.name,
      type: FileType.IMAGE,
      path: `android://${this.key}/${remotePath}`,
      remotePath,
      remoteDeviceKey: this.key,
      source: 'android',
      tags: [],
      size,
      meta: {
        width: width || 0,
        height: height || 0,
        sizeKb: size && size > 0 ? Math.round(size / 1024) : 0,
        created: '',
        modified: '',
        format,
        palette: item.palette,
      },
    };
  }

  /** 下载安卓端图片到桌面端本地路径。 */
  async downloadImage(mediaStoreId: string, destPath: string): Promise<void> {
    const response = await this.fetchWithTimeout(this.getImageUrl(mediaStoreId), {
      method: 'GET',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const blob = await response.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    const { writeFileFromBytes } = await import('../../api/tauri-bridge');
    await writeFileFromBytes(destPath, buf);
  }

  async heartbeat(): Promise<void> {
    await this.fetchJson('/api/heartbeat');
  }
}

/** 多设备注册表：key → 设备客户端。 */
class AndroidClientsRegistry {
  private clients = new Map<string, AndroidDeviceClient>();

  /** 注册/获取设备客户端并更新 token。 */
  register(key: string, baseUrl: string, token: string | null): AndroidDeviceClient {
    let client = this.clients.get(key);
    if (!client) {
      client = new AndroidDeviceClient(key, baseUrl);
      this.clients.set(key, client);
    }
    client.setToken(token);
    return client;
  }

  get(key: string | undefined | null): AndroidDeviceClient | undefined {
    if (!key) return undefined;
    return this.clients.get(key);
  }

  has(key: string): boolean {
    return this.clients.has(key);
  }

  unregister(key: string): AndroidDeviceClient | undefined {
    const client = this.clients.get(key);
    this.clients.delete(key);
    return client;
  }

  getAll(): AndroidDeviceClient[] {
    return Array.from(this.clients.values());
  }
}

export const androidClientRegistry = new AndroidClientsRegistry();
