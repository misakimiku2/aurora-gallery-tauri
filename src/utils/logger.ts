// 日志工具函数
// 用于在前端代码中同时输出日志到浏览器控制台和Tauri应用窗口控制台

import * as tauriLog from '@tauri-apps/plugin-log';

// Vite 提供的开发模式检测标志
// NOTE: 强制启用日志（开发阶段），取消基于环境的自动识别
const IS_DEV = true
/**
 * 日志配置
 */
const LOG_CONFIG = {
  // 仅在开发模式下输出浏览器控制台日志
  enableBrowserConsole: IS_DEV,
  // 仅在开发模式下通过 Tauri 控制台输出（生产构建不输出）
  enableTauriConsole: IS_DEV,
};

// 在页面层面确保 `__AURORA_DEBUG_LOGS__` 已初始化（便于在 DevTools 直接查看）
if (typeof window !== 'undefined') {
  (window as any).__AURORA_DEBUG_LOGS__ = (window as any).__AURORA_DEBUG_LOGS__ || [];
}

// 将日志推入页面上的调试覆盖层（如果存在）
const pushToOverlay = (level: string, message: string, ...args: any[]) => {
  try {
    const win: any = typeof window !== 'undefined' ? window : undefined;
    if (!win) return;
    win.__AURORA_DEBUG_LOGS__ = win.__AURORA_DEBUG_LOGS__ || [];
    const formattedArgs = args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }
      return String(arg);
    });
    const full = [message, ...formattedArgs].filter(Boolean).join(' ');
    win.__AURORA_DEBUG_LOGS__.push({ level, message: full, ts: new Date().toISOString() });
    if (win.__AURORA_DEBUG_LOGS__.length > 500) win.__AURORA_DEBUG_LOGS__.shift();
  } catch (e) {
    // ignore
  }
};
/**
 * 统一日志记录函数
 * @param level 日志级别
 * @param message 日志消息
 * @param args 额外参数
 */
const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]) => {
  // 如果不是开发模式，直接返回，不输出调试信息
  if (!IS_DEV) return;

  // 输出到浏览器控制台
  if (LOG_CONFIG.enableBrowserConsole) {
    switch (level) {
      case 'debug':
        console.debug(message, ...args);
        pushToOverlay('debug', message, ...args);
        break;
      case 'info':
        console.log(message, ...args);
        pushToOverlay('info', message, ...args);
        break;
      case 'warn':
        console.warn(message, ...args);
        pushToOverlay('warn', message, ...args);
        break;
      case 'error':
        console.error(message, ...args);
        pushToOverlay('error', message, ...args);
        break;
    }
  }

  // 输出到Tauri应用窗口控制台（仅开发模式）
  if (LOG_CONFIG.enableTauriConsole && typeof window !== 'undefined' && '__TAURI__' in window) {
    let logMessage = message;
    if (args.length > 0) {
      const formattedArgs = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      });
      logMessage = `${message} ${formattedArgs.join(' ')}`;
    }

    // 使用Tauri日志插件的API
    switch (level) {
      case 'debug':
        tauriLog.debug(logMessage).catch(() => {});
        break;
      case 'info':
        tauriLog.info(logMessage).catch(() => {});
        break;
      case 'warn':
        tauriLog.warn(logMessage).catch(() => {});
        break;
      case 'error':
        tauriLog.error(logMessage).catch(() => {});
        break;
    }
  }
};

/**
 * 调试日志
 * @param message 日志消息
 * @param args 额外参数
 */
export const debug = (message: string, ...args: any[]) => {
  log('debug', message, ...args);
};

/**
 * 信息日志
 * @param message 日志消息
 * @param args 额外参数
 */
export const info = (message: string, ...args: any[]) => {
  log('info', message, ...args);
};

/**
 * 警告日志
 * @param message 日志消息
 * @param args 额外参数
 */
export const warn = (message: string, ...args: any[]) => {
  log('warn', message, ...args);
};

/**
 * 错误日志
 * @param message 日志消息
 * @param args 额外参数
 */
export const error = (message: string, ...args: any[]) => {
  log('error', message, ...args);
};

/**
 * 替换全局console对象，确保所有日志都通过Tauri日志插件输出
 */
export const setupGlobalLogger = () => {
  // 如果不是开发模式，则通常静默日志；但当我们在 Tauri 的开发流程中（如 clean:dev）
  // 需要查看日志时，可通过设置 VITE_FORCE_DEV_LOGS=true 强制开启日志转发。
  const FORCE_DEV_LOGS = typeof import.meta !== 'undefined' && Boolean((import.meta as any).env?.VITE_FORCE_DEV_LOGS === 'true');

  if (!IS_DEV && !(typeof window !== 'undefined' && '__TAURI__' in window && FORCE_DEV_LOGS)) {
    if (typeof console !== 'undefined') {
      // 保留 error/warn 也一并静默（仅在真正生产环境时静默）
      console.log = (() => {}) as any;
      console.debug = (() => {}) as any;
      console.info = (() => {}) as any;
      console.warn = (() => {}) as any;
      console.error = (() => {}) as any;
    }
    return;
  }

  if (typeof window !== 'undefined' && '__TAURI__' in window) {
    // 保存原始console对象
    const originalConsole = {
      log: console.log,
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    // 替换console对象
    console.log = (message: any, ...args: any[]) => {
      originalConsole.log(message, ...args);
      pushToOverlay('info', message, ...args);
      if (typeof message === 'string') {
        tauriLog.info(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.info(JSON.stringify(message)).catch(() => {});
      }
    };

    console.debug = (message: any, ...args: any[]) => {
      originalConsole.debug(message, ...args);
      pushToOverlay('debug', message, ...args);
      if (typeof message === 'string') {
        tauriLog.debug(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.debug(JSON.stringify(message)).catch(() => {});
      }
    };

    console.info = (message: any, ...args: any[]) => {
      originalConsole.info(message, ...args);
      pushToOverlay('info', message, ...args);
      if (typeof message === 'string') {
        tauriLog.info(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.info(JSON.stringify(message)).catch(() => {});
      }
    };

    console.warn = (message: any, ...args: any[]) => {
      originalConsole.warn(message, ...args);
      pushToOverlay('warn', message, ...args);
      if (typeof message === 'string') {
        tauriLog.warn(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.warn(JSON.stringify(message)).catch(() => {});
      }
    };

    console.error = (message: any, ...args: any[]) => {
      originalConsole.error(message, ...args);
      pushToOverlay('error', message, ...args);
      if (typeof message === 'string') {
        tauriLog.error(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.error(JSON.stringify(message)).catch(() => {});
      }
    };
  }
};
