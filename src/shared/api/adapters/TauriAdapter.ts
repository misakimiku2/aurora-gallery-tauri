import { SharedApi, DominantColor, ConnectedDevice, BrowseResponse } from '../types';

export class TauriAdapter implements SharedApi {
  private invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  private convertFileSrc: (path: string) => string;

  constructor(
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
    convertFileSrc: (path: string) => string
  ) {
    this.invoke = invoke;
    this.convertFileSrc = convertFileSrc;
  }

  getImageUrl(path: string): string {
    return this.convertFileSrc(path);
  }

  getThumbnailUrl(path: string): string {
    return this.convertFileSrc(path);
  }

  async browse(path: string): Promise<BrowseResponse> {
    const result = await this.invoke('browse_directory', { path });
    return result as BrowseResponse;
  }

  async deleteFile(path: string): Promise<void> {
    await this.invoke('delete_file', { path });
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.invoke('rename_file', { oldPath, newPath });
  }

  async moveFile(src: string, dest: string): Promise<void> {
    await this.invoke('move_file', { src, dest });
  }

  async copyFile(src: string, dest: string): Promise<string> {
    const result = await this.invoke('copy_file', { src, dest });
    return result as string;
  }

  async getAnimationData(path: string): Promise<string | null> {
    try {
      const result = await this.invoke('get_animation_data', { path });
      return result as string;
    } catch {
      return null;
    }
  }

  async getSpecialFormatPreview(path: string, format: 'jxl' | 'avif'): Promise<string> {
    const cmd = format === 'jxl' ? 'get_jxl_preview' : 'get_avif_preview';
    const result = await this.invoke(cmd, { path });
    return result as string;
  }

  async moveFileToFolder(src: string, dest: string): Promise<void> {
    await this.invoke('move_file_to_folder', { src, dest });
  }

  async copyFileToFolder(src: string, dest: string): Promise<string> {
    const result = await this.invoke('copy_file_to_folder', { src, dest });
    return result as string;
  }

  async getDominantColors(path: string, count: number): Promise<DominantColor[]> {
    const result = await this.invoke('get_dominant_colors', { path, count });
    return result as DominantColor[];
  }

  async copyToClipboard(path: string): Promise<void> {
    await this.invoke('copy_copy_to_clipboard', { path });
  }

  async getDevices(): Promise<ConnectedDevice[]> {
    const result = await this.invoke('get_connected_devices');
    return result as ConnectedDevice[];
  }
}

export default TauriAdapter;
