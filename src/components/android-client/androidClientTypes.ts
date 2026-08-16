import { FileNode } from '../../types';

export type { SavedAndroidDevice, AndroidClientSettings, AndroidClientConnection } from '../../types';

/** 侧边栏/总览使用的单台安卓设备运行状态。 */
export interface AndroidDeviceInfo {
  key: string;
  host: string;
  port: number;
  name: string;
  connected: boolean;
  loading: boolean;
  roots: string[];
}

/** 下载结果。 */
export interface AndroidDownloadResult {
  localPath: string;
  fileName: string;
  success: boolean;
  error?: string;
}

export type { FileNode };
