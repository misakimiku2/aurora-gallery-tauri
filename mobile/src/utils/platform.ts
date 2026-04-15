export type Platform = 'desktop' | 'android-tablet' | 'android-phone';

export interface DeviceInfo {
  platform: Platform;
  isTablet: boolean;
  isPhone: boolean;
  isAndroid: boolean;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
}

export function detectPlatform(): DeviceInfo {
  const isAndroid = /android/i.test(navigator.userAgent);
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;
  const pixelRatio = window.devicePixelRatio || 1;
  
  let platform: Platform = 'desktop';
  let isTablet = false;
  let isPhone = false;
  
  if (isAndroid) {
    const minDimension = Math.min(screenWidth, screenHeight);
    isTablet = minDimension >= 600;
    isPhone = !isTablet;
    platform = isTablet ? 'android-tablet' : 'android-phone';
  }
  
  return {
    platform,
    isTablet,
    isPhone,
    isAndroid,
    screenWidth,
    screenHeight,
    pixelRatio,
  };
}

export async function getApiAdapter() {
  const deviceInfo = detectPlatform();
  
  if (deviceInfo.isAndroid) {
    const { AndroidAdapter } = await import('../api/adapters/AndroidAdapter');
    const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
    return new AndroidAdapter({ invoke, convertFileSrc });
  }
  
  const { TauriAdapter } = await import('../../../src/shared/api/adapters/TauriAdapter');
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
  return new TauriAdapter(invoke, convertFileSrc);
}
