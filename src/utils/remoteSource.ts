import { FileNode } from '../types';
import { lanClientApi } from '../components/lan-client/lanClientApi';
import { androidClientRegistry } from '../components/android-client/androidClientApi';
import { getGlobalCache } from './thumbnailCache';

/**
 * 远程图片来源统一分发：
 * - `lan://<path>`              桌面端服务（安卓客户端模式，lanClientApi）
 * - `android://<key>/<id>`      安卓设备（桌面客户端模式，多设备注册表）
 *                               <key> = "host:port"，<id> = MediaStore 图片/文件夹 ID
 *
 * 多个连接可同时存在（桌面端服务端 + 多台安卓设备），
 * URL 解析按文件路径前缀与设备 key 分发。
 */

export const LAN_PREFIX = 'lan://';
export const ANDROID_PREFIX = 'android://';

export const isLanPath = (p?: string | null): boolean =>
  !!p && p.startsWith(LAN_PREFIX);

export const isAndroidPath = (p?: string | null): boolean =>
  !!p && p.startsWith(ANDROID_PREFIX);

/** 是否为任一远程来源（桌面端服务或安卓设备）的路径。 */
export const isRemotePath = (p?: string | null): boolean =>
  isLanPath(p) || isAndroidPath(p);

/** 解析安卓路径：android://<key>/<remotePath>。 */
export const parseAndroidPath = (
  p: string
): { key: string; remotePath: string } | null => {
  if (!p.startsWith(ANDROID_PREFIX)) return null;
  const rest = p.slice(ANDROID_PREFIX.length);
  const idx = rest.indexOf('/');
  if (idx <= 0) return null;
  return { key: rest.slice(0, idx), remotePath: rest.slice(idx + 1) };
};

/** 提取远程路径（去掉 lan:// 或 android://<key>/ 前缀）。 */
export const remotePathOf = (p: string): string => {
  if (isAndroidPath(p)) {
    const parsed = parseAndroidPath(p);
    return parsed ? parsed.remotePath : p.slice(ANDROID_PREFIX.length);
  }
  return p.slice(LAN_PREFIX.length);
};

/** 安卓路径对应的设备 key（非安卓路径返回 undefined）。 */
export const androidDeviceKeyOfPath = (p: string): string | undefined =>
  parseAndroidPath(p)?.key;

/** 安卓设备客户端（按路径中的设备 key 查找注册表）。 */
export const androidClientOfPath = (p: string) => {
  const parsed = parseAndroidPath(p);
  if (!parsed) return undefined;
  return androidClientRegistry.get(parsed.key);
};

export const getRemoteThumbnailUrl = (p: string): string => {
  if (isAndroidPath(p)) {
    const parsed = parseAndroidPath(p);
    if (!parsed) return '';
    const client = androidClientRegistry.get(parsed.key);
    return client ? client.getThumbnailUrl(parsed.remotePath) : '';
  }
  return lanClientApi.getThumbnailUrl(p.slice(LAN_PREFIX.length));
};

export const getRemoteImageUrl = (p: string): string => {
  if (isAndroidPath(p)) {
    const parsed = parseAndroidPath(p);
    if (!parsed) return '';
    const client = androidClientRegistry.get(parsed.key);
    return client ? client.getImageUrl(parsed.remotePath) : '';
  }
  return lanClientApi.getImageUrl(p.slice(LAN_PREFIX.length));
};

export const getRemotePalette = (p: string): Promise<string[]> => {
  if (isAndroidPath(p)) {
    const parsed = parseAndroidPath(p);
    if (!parsed) return Promise.resolve([]);
    const client = androidClientRegistry.get(parsed.key);
    return client ? client.getPalette(parsed.remotePath) : Promise.resolve([]);
  }
  return lanClientApi.getPalette(p.slice(LAN_PREFIX.length));
};

/** 是否为远程文件节点（桌面端服务或安卓设备）。 */
export const isRemoteFile = (file?: FileNode | null): boolean => {
  if (!file) return false;
  if (file.source === 'lan' || file.source === 'android') return true;
  return isRemotePath(file.path);
};

/**
 * 远程连接变化通知（设备上线/重连、token 刷新）。
 *
 * 远程 URL 内嵌访问 token，重连后会换成新 token；设备断开期间客户端不在
 * 注册表中，解析出的 URL 更是空串。这些 URL 一旦被组件缓存/写入缩略图缓存，
 * 重连后不会自动失效，表现为"重连了但缩略图依然是裂图"。
 * 因此连接恢复时必须：先清掉缓存里的远程条目，再通知订阅者重新解析。
 */
type RemoteChangeListener = () => void;
const remoteChangeListeners = new Set<RemoteChangeListener>();

/** 订阅远程连接变化，返回取消订阅函数。 */
export const subscribeRemoteChange = (fn: RemoteChangeListener): (() => void) => {
  remoteChangeListeners.add(fn);
  return () => {
    remoteChangeListeners.delete(fn);
  };
};

/** 广播远程连接变化（调用方在设备重连/token 刷新后调用）。 */
export const notifyRemoteChange = (): void => {
  const cache = getGlobalCache();
  cache.deleteByPrefix(LAN_PREFIX);
  cache.deleteByPrefix(ANDROID_PREFIX);
  remoteChangeListeners.forEach((fn) => fn());
};

/** 远程文件节点的来源标识：'lan' 或 'android'。 */
export const remoteSourceOf = (file: FileNode): 'lan' | 'android' => {
  if (file.source === 'android' || isAndroidPath(file.path)) return 'android';
  return 'lan';
};
