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

// Inject into window object
if (typeof window !== 'undefined') {
  (window as any).electron = electronMock;
}



