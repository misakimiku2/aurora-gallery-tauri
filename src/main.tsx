import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../index.css';
import { isTauriEnvironment } from './utils/environment';
import { setupGlobalLogger } from './utils/logger';

// Tauri Log Plugin Configuration
import * as log from '@tauri-apps/plugin-log';

// Configure Tauri Log Plugin to display logs in console
const configureTauriLogs = async () => {
  // 使用更直接的检测方式，确保能正确检测到Tauri环境
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  if (isTauri) {
    try {
      // Attach console listener to forward Tauri logs to browser console
      await log.attachConsole();
      
      // 设置全局logger，确保所有console.log都通过Tauri日志插件输出
      setupGlobalLogger();
    } catch (error) {
      console.error('Failed to configure Tauri log plugin:', error);
    }
  } else {
    // 即使不是Tauri环境，也调用setupGlobalLogger，确保console.log能正常工作
    setupGlobalLogger();
  }
};

// Configure logs first
typeof window !== 'undefined' && configureTauriLogs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

