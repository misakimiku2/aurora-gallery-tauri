import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../index.css';
import './utils/electron-mock'; // Import electron mock to prevent errors

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

