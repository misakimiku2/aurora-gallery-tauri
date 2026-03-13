import { SharedApi, BrowseResponse, ConnectedDevice } from '../types';

export class HttpAdapter implements SharedApi {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  setToken(token: string) {
    this.token = token;
  }

  private async fetch<T>(url: string, options?: RequestInit): Promise<T> {
    const headers: HeadersInit = {
      ...options?.headers,
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}${url}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('lan_share_token');
        localStorage.removeItem('lan_share_expires');
        window.location.reload();
      }
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  getImageUrl(path: string): string {
    const encodedPath = encodeURIComponent(path);
    return `${this.baseUrl}/api/image?path=${encodedPath}&token=${this.token}`;
  }

  getThumbnailUrl(path: string): string {
    const encodedPath = encodeURIComponent(path);
    return `${this.baseUrl}/api/thumbnail?path=${encodedPath}&token=${this.token}`;
  }

  async browse(path: string): Promise<BrowseResponse> {
    return this.fetch<BrowseResponse>(`/api/browse?path=${encodeURIComponent(path)}`);
  }

  async deleteFile(path: string): Promise<void> {
    await this.fetch(`${this.baseUrl}/api/file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path }),
    });
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.fetch(`${this.baseUrl}/api/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oldPath, newPath }),
    });
  }

  async getDevices(): Promise<ConnectedDevice[]> {
    const data = await this.fetch<{ devices: ConnectedDevice[] }>('/api/devices');
    return data.devices || [];
  }
}

export default HttpAdapter;
