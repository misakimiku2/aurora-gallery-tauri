import React, { useState, useEffect, useCallback } from 'react';
import AuthScreen from './components/AuthScreen';
import BrowseScreen from './components/BrowseScreen';
import ImageViewer from './components/ImageViewer';
import { lanShareApi, BrowseItem, BrowseResponse } from './api';

type Screen = 'auth' | 'browse' | 'viewer';

interface AppState {
  screen: Screen;
  token: string | null;
  currentPath: string;
  folders: BrowseItem[];
  images: BrowseItem[];
  viewingImage: BrowseItem | null;
  viewingIndex: number;
  allowEdit: boolean;
}

const LanShareApp: React.FC = () => {
  const [state, setState] = useState<AppState>({
    screen: 'auth',
    token: null,
    currentPath: '/',
    folders: [],
    images: [],
    viewingImage: null,
    viewingIndex: -1,
    allowEdit: false,
  });

  useEffect(() => {
    const savedToken = localStorage.getItem('lan_share_token');
    const expiresAt = parseInt(localStorage.getItem('lan_share_expires') || '0');
    
    if (savedToken && Date.now() < expiresAt) {
      lanShareApi.setToken(savedToken);
      setState(prev => ({ ...prev, token: savedToken, screen: 'browse' }));
      browse('/', savedToken);
    }
  }, []);

  const browse = useCallback(async (path: string, token?: string) => {
    const authToken = token || state.token;
    if (!authToken) return;

    try {
      const data: BrowseResponse = await lanShareApi.browse(path, authToken!);
      setState(prev => ({
        ...prev,
        currentPath: path,
        folders: data.folders,
        images: data.images,
        screen: 'browse',
      }));
    } catch (error) {
      console.error('Browse error:', error);
      if (path === '/') {
        localStorage.removeItem('lan_share_token');
        localStorage.removeItem('lan_share_expires');
        setState(prev => ({ ...prev, token: null, screen: 'auth' }));
      }
    }
  }, [state.token]);

  const handleAuth = useCallback(async (code: string) => {
    const result = await lanShareApi.authenticate(code);
    if (result.success && result.token) {
      lanShareApi.setToken(result.token);
      localStorage.setItem('lan_share_token', result.token);
      localStorage.setItem('lan_share_expires', (Date.now() + (result.expires_in || 3600) * 1000).toString());
      setState(prev => ({ ...prev, token: result.token!, allowEdit: true }));
      browse('/', result.token);
      return true;
    }
    return false;
  }, [browse]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('lan_share_token');
    localStorage.removeItem('lan_share_expires');
    setState(prev => ({ ...prev, token: null, screen: 'auth' }));
  }, []);

  const handleNavigate = useCallback((path: string) => {
    browse(path);
  }, [browse]);

  const handleViewImage = useCallback((image: BrowseItem, index: number) => {
    setState(prev => ({
      ...prev,
      viewingImage: image,
      viewingIndex: index,
      screen: 'viewer',
    }));
  }, []);

  const handleCloseViewer = useCallback(() => {
    setState(prev => ({
      ...prev,
      viewingImage: null,
      viewingIndex: -1,
      screen: 'browse',
    }));
  }, []);

  const handleNavigateImage = useCallback((direction: number) => {
    const newIndex = state.viewingIndex + direction;
    if (newIndex >= 0 && newIndex < state.images.length) {
      setState(prev => ({
        ...prev,
        viewingImage: prev.images[newIndex],
        viewingIndex: newIndex,
      }));
    }
  }, [state.viewingIndex, state.images.length]);

  const handleDeleteImage = useCallback(async () => {
    if (!state.viewingImage || !state.allowEdit) return;
    
    if (!confirm(`确定要删除 "${state.viewingImage.name}" 吗？`)) return;

    try {
      await lanShareApi.deleteFile(state.viewingImage.path, state.token!);
      const newImages = state.images.filter((_, i) => i !== state.viewingIndex);
      
      if (newImages.length === 0) {
        handleCloseViewer();
        browse(state.currentPath);
      } else {
        const newIndex = Math.min(state.viewingIndex, newImages.length - 1);
        setState(prev => ({
          ...prev,
          images: newImages,
          viewingImage: newImages[newIndex],
          viewingIndex: newIndex,
        }));
      }
    } catch (error) {
      console.error('Delete error:', error);
      alert('删除失败');
    }
  }, [state.viewingImage, state.viewingIndex, state.images, state.allowEdit, state.token, state.currentPath, handleCloseViewer, browse]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (state.screen === 'viewer') {
        if (e.key === 'ArrowLeft') handleNavigateImage(-1);
        if (e.key === 'ArrowRight') handleNavigateImage(1);
        if (e.key === 'Escape') handleCloseViewer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.screen, handleNavigateImage, handleCloseViewer]);

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
      {state.screen === 'auth' && (
        <AuthScreen onAuth={handleAuth} />
      )}
      {state.screen === 'browse' && (
        <BrowseScreen
          currentPath={state.currentPath}
          folders={state.folders}
          images={state.images}
          token={state.token!}
          allowEdit={state.allowEdit}
          onNavigate={handleNavigate}
          onViewImage={handleViewImage}
          onLogout={handleLogout}
        />
      )}
      {state.screen === 'viewer' && state.viewingImage && (
        <ImageViewer
          image={state.viewingImage}
          currentIndex={state.viewingIndex}
          totalCount={state.images.length}
          allowEdit={state.allowEdit}
          token={state.token!}
          onClose={handleCloseViewer}
          onNavigate={handleNavigateImage}
          onDelete={handleDeleteImage}
        />
      )}
    </div>
  );
};

export default LanShareApp;
