import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '../../utils/environment';

// ==================== LAN Share 相关 API ====================

import { LanShareSettings, ConnectedDevice, SavedServer } from '../../types';

export interface LanShareInfo {
  url: string;
  port: number;
  local_ip: string;
}

export interface LanShareStatus {
  is_running: boolean;
  port: number;
  local_ip: string | null;
  device_count: number;
}

// ==================== 安卓端局域网共享服务端（桌面端连接安卓端） ====================

/** 安卓端服务端配置（发送给 lan_share_android_start 命令）。 */
export interface AndroidLanServerConfig {
  enabled: boolean;
  port: number;
  access_code: string;
  server_name?: string;
}

/** 安卓端服务端状态。 */
export interface AndroidLanServerStatus {
  is_running: boolean;
  port: number;
  local_ip: string | null;
  device_count: number;
}

/**
 * 启动安卓端局域网共享服务端（将 MediaStore 图片通过 HTTP 暴露给桌面端）。
 */
export const lanShareAndroidStart = async (
  config: AndroidLanServerConfig
): Promise<LanShareInfo> => {
  if (!isTauriEnvironment()) {
    throw new Error('LAN share server is only available in Tauri environment');
  }
  try {
    const result = await invoke<LanShareInfo>('lan_share_android_start', {
      config: {
        enabled: config.enabled,
        port: config.port,
        access_code: config.access_code,
        server_name: config.server_name || '',
      },
    });
    return result;
  } catch (error) {
    console.error('Failed to start Android LAN share server:', error);
    throw error;
  }
};

/** 停止安卓端局域网共享服务端。 */
export const lanShareAndroidStop = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('lan_share_android_stop');
  } catch (error) {
    console.error('Failed to stop Android LAN share server:', error);
    throw error;
  }
};

/** 获取安卓端局域网共享服务端状态。 */
export const lanShareAndroidGetStatus = async (): Promise<AndroidLanServerStatus> => {
  if (!isTauriEnvironment()) {
    return { is_running: false, port: 8080, local_ip: null, device_count: 0 };
  }
  try {
    return await invoke<AndroidLanServerStatus>('lan_share_android_get_status');
  } catch (error) {
    console.error('Failed to get Android LAN share status:', error);
    return { is_running: false, port: 8080, local_ip: null, device_count: 0 };
  }
};

/** 获取安卓端局域网共享服务端的已连接设备列表。 */
export const lanShareAndroidGetDevices = async (): Promise<ConnectedDevice[]> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    return await invoke<ConnectedDevice[]>('lan_share_android_get_devices');
  } catch (error) {
    console.error('Failed to get Android LAN share devices:', error);
    return [];
  }
};

/** 更新安卓端局域网共享服务端配置（服务运行中实时生效）。 */
export const lanShareAndroidUpdateConfig = async (
  config: AndroidLanServerConfig
): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('lan_share_android_update_config', {
      config: {
        enabled: config.enabled,
        port: config.port,
        access_code: config.access_code,
        server_name: config.server_name || '',
      },
    });
  } catch (error) {
    console.error('Failed to update Android LAN share config:', error);
    throw error;
  }
};

/**
 * 启动局域网共享服务
 * @param config 共享配置
 * @param rootPath 根目录路径
 * @returns 服务信息
 */
export const lanShareStart = async (
  config: LanShareSettings,
  rootPath: string
): Promise<LanShareInfo> => {
  if (!isTauriEnvironment()) {
    throw new Error('LAN share is only available in Tauri environment');
  }
  try {
    const result = await invoke<LanShareInfo>('lan_share_start', {
      config: {
        enabled: config.enabled,
        port: config.port,
        access_code: config.accessCode,
        allow_edit: config.allowEdit,
        allow_upload: config.allowUpload,
        server_name: config.serverName || '',
      },
      rootPath,
    });
    return result;
  } catch (error) {
    console.error('Failed to start LAN share:', error);
    throw error;
  }
};

/**
 * 停止局域网共享服务
 */
export const lanShareStop = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('lan_share_stop');
  } catch (error) {
    console.error('Failed to stop LAN share:', error);
    throw error;
  }
};

/**
 * 获取局域网共享服务状态
 * @returns 服务状态
 */
export const lanShareGetStatus = async (): Promise<LanShareStatus> => {
  if (!isTauriEnvironment()) {
    return {
      is_running: false,
      port: 8080,
      local_ip: null,
      device_count: 0,
    };
  }
  try {
    const result = await invoke<LanShareStatus>('lan_share_get_status');
    return result;
  } catch (error) {
    console.error('Failed to get LAN share status:', error);
    return {
      is_running: false,
      port: 8080,
      local_ip: null,
      device_count: 0,
    };
  }
};

/**
 * 获取已连接设备列表
 * @returns 设备列表
 */
export const lanShareGetDevices = async (): Promise<ConnectedDevice[]> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    const devices = await invoke<ConnectedDevice[]>('lan_share_get_devices');
    return devices;
  } catch (error) {
    console.error('Failed to get connected devices:', error);
    return [];
  }
};

/**
 * 重命名已连接设备。同时更新服务端的 session 和 device 记录，
 * 安卓端下次刷新设备列表时会同步到本地。
 */
export const lanShareRenameDevice = async (
  deviceId: string,
  newName: string
): Promise<boolean> => {
  if (!isTauriEnvironment()) {
    return false;
  }
  try {
    const ok = await invoke<boolean>('lan_share_rename_device', {
      deviceId,
      newName,
    });
    return ok;
  } catch (error) {
    console.error('Failed to rename device:', error);
    return false;
  }
};

/**
 * 踢出已连接设备（移除其在服务端的会话与设备记录）。
 * 双向连接融合：桌面端"断开"设备时调用，手机端下一次心跳收到 401 后
 * 自动清理本机连接状态，实现整条链路的彻底断开。
 */
export const lanShareRemoveDevice = async (deviceId: string): Promise<boolean> => {
  if (!isTauriEnvironment()) {
    return false;
  }
  try {
    const ok = await invoke<boolean>('lan_share_remove_device', {
      deviceId,
    });
    return ok;
  } catch (error) {
    console.error('Failed to remove device:', error);
    return false;
  }
};

/**
 * 获取本机局域网 IP 地址
 * @returns IP 地址
 */
export const lanShareGetLocalIp = async (): Promise<string> => {
  if (!isTauriEnvironment()) {
    return '127.0.0.1';
  }
  try {
    const ip = await invoke<string>('lan_share_get_local_ip');
    return ip;
  } catch (error) {
    console.error('Failed to get local IP:', error);
    return '127.0.0.1';
  }
};

/**
 * 检查端口是否可用
 * @param port 端口号
 * @returns 是否可用
 */
export const lanShareCheckPort = async (port: number): Promise<boolean> => {
  if (!isTauriEnvironment()) {
    return true;
  }
  try {
    const available = await invoke<boolean>('lan_share_check_port', { port });
    return available;
  } catch (error) {
    console.error('Failed to check port:', error);
    return false;
  }
};

/**
 * 更新局域网共享配置
 * @param config 新配置
 */
export const lanShareUpdateConfig = async (config: LanShareSettings): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('lan_share_update_config', {
      config: {
        enabled: config.enabled,
        port: config.port,
        access_code: config.accessCode,
        allow_edit: config.allowEdit,
        allow_upload: config.allowUpload,
        server_name: config.serverName || '',
      },
    });
  } catch (error) {
    console.error('Failed to update LAN share config:', error);
    throw error;
  }
};

/**
 * 保存服务器到最近连接列表（仅前端逻辑，操作 savedServers 数组）
 */
export const lanShareSaveServer = (
  currentSettings: LanShareSettings,
  host: string,
  port: number,
  name?: string
): LanShareSettings => {
  const existing = currentSettings.savedServers || [];
  const filtered = existing.filter(s => !(s.host === host && s.port === port));
  const updated: SavedServer[] = [
    { host, port, name, lastConnected: Date.now() },
    ...filtered,
  ].slice(0, 10); // keep last 10
  return { ...currentSettings, savedServers: updated };
};

/**
 * 从最近连接列表移除服务器
 */
export const lanShareRemoveServer = (
  currentSettings: LanShareSettings,
  host: string,
  port: number
): LanShareSettings => {
  const existing = currentSettings.savedServers || [];
  return {
    ...currentSettings,
    savedServers: existing.filter(s => !(s.host === host && s.port === port)),
  };
};
