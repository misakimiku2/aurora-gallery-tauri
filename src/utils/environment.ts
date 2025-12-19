// 环境检测工具
// 集中管理Tauri环境检测逻辑

/**
 * 环境检测缓存
 * - null: 未检测
 * - true: 是Tauri环境
 * - false: 不是Tauri环境
 */
let tauriEnvironmentCache: boolean | null = null;

/**
 * 同步检测Tauri环境
 * @returns 是否为Tauri环境
 */
export const isTauriEnvironment = (): boolean => {
  if (typeof window === 'undefined') return false;
  
  // 仅在明确检测到true时缓存；未检测到时保持null，以便异步检测继续执行
  if ((window as any).isTauri === true) {
    tauriEnvironmentCache = true;
    return true;
  }
  
  if ((window as any).__TAURI__?.window?.isTauri === true) {
    tauriEnvironmentCache = true;
    return true;
  }
  
  if ('__TAURI__' in window) {
    tauriEnvironmentCache = true;
    return true;
  }
  
  // 未确认时返回false，但不写入cache，让异步检测有机会调用真实API
  return false;
};

/**
 * 异步检测Tauri环境（通过实际调用API）
 * @returns 是否为Tauri环境
 */
export const detectTauriEnvironmentAsync = async (): Promise<boolean> => {
  if (typeof window === 'undefined') return false;
  
  // 如果已经检测到true，直接返回；否则继续尝试真实导入
  if (tauriEnvironmentCache === true) return true;
  
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (typeof invoke === 'function') {
      tauriEnvironmentCache = true;
      return true;
    }
  } catch (_error: any) {
    tauriEnvironmentCache = false;
  }
  
  return false;
};


