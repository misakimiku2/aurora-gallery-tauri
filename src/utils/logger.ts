// 日志工具函数
// 用于在前端代码中同时输出日志到浏览器控制台和Tauri应用窗口控制台

import * as tauriLog from '@tauri-apps/plugin-log';

/**
 * 日志配置
 */
const LOG_CONFIG = {
  enableBrowserConsole: true,
  enableTauriConsole: true,
};

/**
 * 统一日志记录函数
 * @param level 日志级别
 * @param message 日志消息
 * @param args 额外参数
 */
const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]) => {
  // 输出到浏览器控制台
  if (LOG_CONFIG.enableBrowserConsole) {
    switch (level) {
      case 'debug':
        console.debug(message, ...args);
        break;
      case 'info':
        console.log(message, ...args);
        break;
      case 'warn':
        console.warn(message, ...args);
        break;
      case 'error':
        console.error(message, ...args);
        break;
    }
  }

  // 输出到Tauri应用窗口控制台
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
      if (typeof message === 'string') {
        tauriLog.info(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.info(JSON.stringify(message)).catch(() => {});
      }
    };

    console.debug = (message: any, ...args: any[]) => {
      originalConsole.debug(message, ...args);
      if (typeof message === 'string') {
        tauriLog.debug(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.debug(JSON.stringify(message)).catch(() => {});
      }
    };

    console.info = (message: any, ...args: any[]) => {
      originalConsole.info(message, ...args);
      if (typeof message === 'string') {
        tauriLog.info(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.info(JSON.stringify(message)).catch(() => {});
      }
    };

    console.warn = (message: any, ...args: any[]) => {
      originalConsole.warn(message, ...args);
      if (typeof message === 'string') {
        tauriLog.warn(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.warn(JSON.stringify(message)).catch(() => {});
      }
    };

    console.error = (message: any, ...args: any[]) => {
      originalConsole.error(message, ...args);
      if (typeof message === 'string') {
        tauriLog.error(message + ' ' + args.map(arg => String(arg)).join(' ')).catch(() => {});
      } else {
        tauriLog.error(JSON.stringify(message)).catch(() => {});
      }
    };
  }
};
