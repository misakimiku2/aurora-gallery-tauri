export interface BrowseItem {
  name: string;
  path: string;
  type: 'folder' | 'image';
  size?: number;
  thumbnail?: string;
  preview_images?: string[];
  width?: number;
  height?: number;
}

export interface BrowseResponse {
  current_path: string;
  folders: BrowseItem[];
  images: BrowseItem[];
  allow_edit?: boolean;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  expires_in?: number;
  error?: string;
}

export interface ConnectedDevice {
  id: string;
  name: string;
  ip: string;
  connected_at: number;
  last_active_at: number;
}

export interface DevicesResponse {
  devices: ConnectedDevice[];
}

export interface OperationResponse {
  success: boolean;
  path?: string;
  error?: string;
}

const API_BASE = '';

class LanShareApi {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async fetch<T>(url: string, options?: RequestInit): Promise<T> {
    const headers: HeadersInit = {
      ...options?.headers,
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE}${url}`, {
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

  async authenticate(code: string, deviceName?: string): Promise<AuthResponse> {
    const response = await fetch(`${API_BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        device_name: deviceName || this.getDeviceName(),
      }),
    });

    const data: AuthResponse = await response.json();
    if (data.success && data.token) {
      this.token = data.token;
    }
    return data;
  }

  async browse(path: string, token?: string): Promise<BrowseResponse> {
    const authToken = token || this.token;
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${API_BASE}/api/browse?path=${encodeURIComponent(path)}`, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  getThumbnailUrl(path: string, token?: string): string {
    return `${API_BASE}/api/thumbnail?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token || this.token || '')}`;
  }

  getImageUrl(path: string, token?: string): string {
    const authToken = token || this.token;
    return `${API_BASE}/api/image?path=${encodeURIComponent(path)}&token=${encodeURIComponent(authToken || '')}`;
  }

  async deleteFile(path: string, token?: string): Promise<OperationResponse> {
    const headers: HeadersInit = {};
    const authToken = token || this.token;
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${API_BASE}/api/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers,
    });

    return response.json();
  }

  async getDevices(token?: string): Promise<DevicesResponse> {
    const headers: HeadersInit = {};
    const authToken = token || this.token;
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(`${API_BASE}/api/devices`, { headers });
    return response.json();
  }

  async search(query: string, scope?: string, token?: string): Promise<BrowseResponse> {
    const authToken = token || this.token;
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    let url = `${API_BASE}/api/search?q=${encodeURIComponent(query)}`;
    if (scope) {
      url += `&scope=${encodeURIComponent(scope)}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  private getDeviceName(): string {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Unknown Device';
  }
}

export const lanShareApi = new LanShareApi();
