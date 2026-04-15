import React, { useEffect, useState } from 'react';
import { detectPlatform, DeviceInfo } from './utils/platform';
import { SplashScreen } from '../../src/components/SplashScreen';
import { ToastProvider } from '../../src/hooks/useToasts';
import { TabletLayout } from './components/TabletLayout';
import { PhoneLayout } from './components/PhoneLayout';
import './styles/mobile.css';

interface AndroidAppState {
  deviceInfo: DeviceInfo | null;
  isLoading: boolean;
  hasPermissions: boolean;
}

async function requestPermissions(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke('request_storage_permission');
    return result as boolean;
  } catch (error) {
    console.error('Failed to request permissions:', error);
    return false;
  }
}

function PermissionRequest({ onGrant }: { onGrant: () => Promise<boolean> }) {
  const handleRequest = async () => {
    const granted = await onGrant();
    if (!granted) {
      alert('需要存储权限才能浏览图片');
    }
  };

  return (
    <div className="permission-screen">
      <div className="permission-content">
        <h2>需要存储权限</h2>
        <p>Aurora Gallery 需要访问您的图片库来显示和管理照片</p>
        <button onClick={handleRequest}>授予权限</button>
      </div>
    </div>
  );
}

export function AndroidApp() {
  const [state, setState] = useState<AndroidAppState>({
    deviceInfo: null,
    isLoading: true,
    hasPermissions: false,
  });

  useEffect(() => {
    const init = async () => {
      const deviceInfo = detectPlatform();
      
      if (deviceInfo.isAndroid) {
        const hasPermissions = await requestPermissions();
        setState({
          deviceInfo,
          isLoading: false,
          hasPermissions,
        });
      } else {
        setState({
          deviceInfo,
          isLoading: false,
          hasPermissions: true,
        });
      }
    };

    init();
  }, []);

  if (state.isLoading || !state.deviceInfo) {
    return <SplashScreen />;
  }

  if (!state.hasPermissions) {
    return <PermissionRequest onGrant={requestPermissions} />;
  }

  return (
    <ToastProvider>
      {state.deviceInfo.isTablet ? (
        <TabletLayout />
      ) : (
        <PhoneLayout />
      )}
    </ToastProvider>
  );
}

export default AndroidApp;
