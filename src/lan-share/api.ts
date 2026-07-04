export interface BrowseItem {
  name: string;
  path: string;
  type: 'folder' | 'image' | 'video';
  size?: number;
  thumbnail?: string;
  preview_images?: string[];
  width?: number;
  height?: number;
  modified_at?: number;
  palette?: string[];
}

export interface BrowseResponse {
  current_path: string;
  folders: BrowseItem[];
  images: BrowseItem[];
  allow_edit?: boolean;
  allow_upload?: boolean;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  expires_in?: number;
  error?: string;
  server_name?: string;
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
    
    // iPad
    if (/iPad/.test(ua)) {
      const match = ua.match(/iPad\d+,\d+/);
      return match ? `iPad (${match[0]})` : 'iPad';
    }
    
    // iPhone
    if (/iPhone/.test(ua)) {
      const match = ua.match(/iPhone\d+,\d+/);
      return match ? `iPhone (${match[0]})` : 'iPhone';
    }
    
    // Android - 尝试提取型号
    if (/Android/.test(ua)) {
      // 尝试匹配 Android; 版本; 型号 格式
      let match = ua.match(/Android\s*[\d.]+;\s*([^;)]+)/i);
      if (match && match[1]) {
        let model = match[1].trim();
        // 过滤掉无意义的短型号（如 "K"）
        const isMeaningfulModel = model.length >= 3 || /^[A-Z]{2,}-/i.test(model);
        
        if (isMeaningfulModel && model.length < 30) {
          // 检查是否是已知品牌
          if (/SM-/i.test(model)) return `三星 ${model}`;
          if (/SC-/i.test(model)) return `三星 ${model}`;
          if (/Pixel/i.test(model)) return `Google ${model}`;
          if (/Nexus/i.test(model)) return `Google ${model}`;
          if (/Redmi/i.test(model)) return `红米 ${model.replace(/Redmi\s*/i, '')}`;
          if (/Mi\s/i.test(model)) return `小米 ${model.replace(/Mi\s/i, '')}`;
          if (/OnePlus/i.test(model)) return `一加 ${model.replace(/OnePlus\s*/i, '')}`;
          if (/HUAWEI/i.test(model)) return `华为 ${model.replace(/HUAWEI\s*/i, '')}`;
          if (/Honor/i.test(model)) return `荣耀 ${model.replace(/Honor\s*/i, '')}`;
          if (/OPPO/i.test(model)) return `OPPO ${model.replace(/OPPO\s*/i, '')}`;
          if (/vivo/i.test(model)) return `vivo ${model.replace(/vivo\s*/i, '')}`;
          if (/iQOO/i.test(model)) return `iQOO ${model.replace(/iQOO\s*/i, '')}`;
          if (/RedMagic/i.test(model)) return `红魔 ${model.replace(/RedMagic\s*/i, '')}`;
          if (/Samsung/i.test(model)) return `三星 ${model.replace(/Samsung\s*/i, '')}`;
          // 其他有意义的型号直接返回
          return model;
        }
      }
      
      // 尝试匹配 Samsung SM-XXXX 格式
      match = ua.match(/Samsung\s*(SM-[A-Z0-9]+)/i);
      if (match) return `三星 ${match[1]}`;
      
      match = ua.match(/SM-([A-Z0-9]+)/i);
      if (match) return `三星 SM-${match[1]}`;
      
      match = ua.match(/SC-([A-Z0-9]+)/i);
      if (match) return `三星 SC-${match[1]}`;
      
      match = ua.match(/Pixel\s*(\d+)/i);
      if (match) return `Google Pixel ${match[1]}`;
      
      match = ua.match(/Nexus\s*(\d+)/i);
      if (match) return `Google Nexus ${match[1]}`;
      
      // 检测是否是平板（无 Mobile 关键词）
      if (!/Mobile/i.test(ua)) {
        return 'Android 平板';
      }
      
      return 'Android 手机';
    }
    
    // Windows
    if (/Windows/.test(ua)) {
      const match = ua.match(/Windows\s*NT\s*([\d.]+)/);
      if (match) {
        const version = match[1];
        if (version.startsWith('10')) return 'Windows 10/11';
        if (version.startsWith('6.3')) return 'Windows 8.1';
        if (version.startsWith('6.2')) return 'Windows 8';
        if (version.startsWith('6.1')) return 'Windows 7';
      }
      return 'Windows';
    }
    
    // Mac
    if (/Mac/.test(ua)) {
      const match = ua.match(/Mac\s*OS\s*X\s*([\d_]+)/);
      if (match) return `macOS ${match[1].replace(/_/g, '.')}`;
      return 'Mac';
    }
    
    // Linux
    if (/Linux/.test(ua)) {
      return 'Linux';
    }
    
    return 'Unknown Device';
  }
}

export const lanShareApi = new LanShareApi();
