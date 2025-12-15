// Temporary mock for window.electron to prevent errors during frontend migration
// This will be replaced with actual Tauri commands in later steps

export const electronMock = {
  openDirectory: () => Promise.resolve(null),
  scanDirectory: () => Promise.resolve({ roots: [], files: {} }),
  copyExternalFiles: () => Promise.resolve(),
  moveExternalFiles: () => Promise.resolve(),
  openPath: () => {},
  openExternal: () => {},
  copyImage: () => Promise.resolve(),
  copyFilesToClipboard: () => Promise.resolve(false),
  startDrag: () => {},
  getThumbnail: () => Promise.resolve(''),
  saveThumbnail: () => Promise.resolve(false),
  queueThumbnail: () => Promise.resolve(false),
  getFileDetails: () => Promise.resolve(null),
  setAutoLaunch: () => {},
  minimize: () => {},
  maximize: () => {},
  close: () => {},
  toggleControls: () => {},
  onCloseRequest: () => {},
  sendCloseAction: () => {},
  createFolder: () => Promise.resolve(false),
  renameFile: () => Promise.resolve(false),
  deleteFile: () => Promise.resolve(false),
  moveFile: () => Promise.resolve(false),
  copyFile: () => Promise.resolve(false),
  readFileAsBase64: () => Promise.resolve(''),
  chatRequest: () => Promise.resolve({}),
  saveUserData: () => Promise.resolve(false),
  loadUserData: () => Promise.resolve(null),
  setTheme: () => {},
  setCachePath: () => Promise.resolve(false),
  getDefaultPaths: () => Promise.resolve({ resourceRoot: '', cacheRoot: '' }),
  platform: 'win32' as const,
};

// 检测 Tauri 环境的辅助函数
const isTauriEnvironment = (): boolean => {
  if (typeof window === 'undefined') return false;
  
  // Tauri 2.0 检测方式
  // 方式1: 检查 window.isTauri (如果启用了 withGlobalTauri)
  if ((window as any).isTauri === true) return true;
  
  // 方式2: 检查 window.__TAURI__?.window?.isTauri
  if ((window as any).__TAURI__?.window?.isTauri === true) return true;
  
  // 方式3: 检查 window.__TAURI__ 存在
  if ('__TAURI__' in window) return true;
  
  return false;
};

// Inject into window object only if not in Tauri environment
// In Tauri, we should use Tauri APIs instead of Electron mock
if (typeof window !== 'undefined' && !isTauriEnvironment()) {
  (window as any).electron = electronMock;
}



