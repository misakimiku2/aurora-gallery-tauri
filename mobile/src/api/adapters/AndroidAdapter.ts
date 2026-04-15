import { AndroidImageInfo, AndroidFolderInfo } from '../../types';

interface AndroidBridge {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  convertFileSrc: (path: string) => string;
}

export class AndroidAdapter {
  private bridge: AndroidBridge;

  constructor(bridge: AndroidBridge) {
    this.bridge = bridge;
  }

  getImageUrl(path: string): string {
    return this.bridge.convertFileSrc(path);
  }

  getThumbnailUrl(path: string): string {
    return this.bridge.convertFileSrc(path);
  }

  async scanImages(): Promise<AndroidImageInfo[]> {
    const result = await this.bridge.invoke('android_scan_images');
    return result as AndroidImageInfo[];
  }

  async scanFolders(): Promise<AndroidFolderInfo[]> {
    const result = await this.bridge.invoke('android_scan_folders');
    return result as AndroidFolderInfo[];
  }

  async getThumbnail(file_path: string, cache_root: string): Promise<string | null> {
    try {
      const result = await this.bridge.invoke('android_get_thumbnail', { file_path, cache_root });
      return result as string | null;
    } catch {
      return null;
    }
  }

  async deleteFile(path: string): Promise<void> {
    await this.bridge.invoke('delete_file', { path });
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.bridge.invoke('rename_file', { oldPath, newPath });
  }

  async moveFile(src: string, dest: string): Promise<void> {
    await this.bridge.invoke('move_file', { src, dest });
  }

  async copyFile(src: string, dest: string): Promise<string> {
    const result = await this.bridge.invoke('copy_file', { src, dest });
    return result as string;
  }

  async fileExists(path: string): Promise<boolean> {
    const result = await this.bridge.invoke('file_exists', { path });
    return result as boolean;
  }

  async readBase64(path: string): Promise<string> {
    const result = await this.bridge.invoke('read_file_as_base64', { path });
    return result as string;
  }
}

export default AndroidAdapter;
