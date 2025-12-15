import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../index.css';
import './utils/electron-mock'; // Import electron mock to prevent errors
import { clearInvalidCacheEntries } from './utils/thumbnailCache';
import { isTauriEnvironment } from './utils/environment';

// Tauri Log Plugin Configuration
import * as log from '@tauri-apps/plugin-log';

// Clear invalid cache entries on startup
clearInvalidCacheEntries();

// Configure Tauri Log Plugin to display logs in console
const configureTauriLogs = async () => {
  if (isTauriEnvironment()) {
    try {
      // Attach console listener to forward Tauri logs to browser console
      await log.attachConsole();
    } catch (error) {
      console.error('Failed to configure Tauri log plugin:', error);
    }
  }
};

// Configure logs first
typeof window !== 'undefined' && configureTauriLogs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

