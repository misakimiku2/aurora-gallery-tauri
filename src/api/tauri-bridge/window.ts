import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * 隐藏主窗口（最小化到托盘）
 */
export const hideWindow = async (): Promise<void> => {
  try {
    await invoke('hide_window');
  } catch (error) {
    console.error('Failed to hide window:', error);
    throw error;
  }
};

/**
 * 显示主窗口
 */
export const showWindow = async (): Promise<void> => {
  try {
    await invoke('show_window');
  } catch (error) {
    console.error('Failed to show window:', error);
    throw error;
  }
};

/**
 * 设置窗口最小尺寸
 * @param width 最小宽度
 * @param height 最小高度
 */
export const setWindowMinSize = async (width: number, height: number): Promise<void> => {
  try {
    await invoke('set_window_min_size', { width, height });
  } catch (error) {
    console.error('Failed to set window min size:', error);
    throw error;
  }
};

/**
 * 检查窗口是否处于最大化状态
 * @returns 是否最大化
 */
export const isWindowMaximized = async (): Promise<boolean> => {
  try {
    const window = getCurrentWindow();
    return await window.isMaximized();
  } catch (error) {
    console.error('Failed to check window maximized state:', error);
    return false;
  }
};

/**
 * 退出应用程序
 */
export const exitApp = async (): Promise<void> => {
  try {
    // 使用 Rust 后端的 exit_app 命令来正确退出应用
    await invoke('exit_app');
  } catch (error) {
    console.error('Failed to exit app:', error);
    // 如果 Tauri API 不可用，尝试使用 window.close() 作为后备
    if (typeof window !== 'undefined' && window.close) {
      window.close();
    }
  }
};
