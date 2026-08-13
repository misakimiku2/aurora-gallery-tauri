import { isAndroidSync } from './androidPlatform';

/**
 * 获取初始布局设置（App 启动时 useLayoutState 的初始值来源）。
 * 安卓端根据屏幕方向决定侧边栏是否可见；桌面端默认全部展开。
 */
export const getInitialLayout = () => {
  const isAndroid = isAndroidSync();
  if (isAndroid) {
    const isPortrait = typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches;
    return { isSidebarVisible: !isPortrait, isMetadataVisible: false, isColorPickerVisible: false };
  }
  return { isSidebarVisible: true, isMetadataVisible: true, isColorPickerVisible: false };
};
