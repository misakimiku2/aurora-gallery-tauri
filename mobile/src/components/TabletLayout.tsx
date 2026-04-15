import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AndroidAdapter } from '../api/adapters/AndroidAdapter';
import { AndroidImageInfo, AndroidFolderInfo, MobileImageItem } from '../types';
import { MobileImageViewer } from './MobileImageViewer';
import { Menu, X, ChevronLeft, Image as ImageIcon } from 'lucide-react';

export function TabletLayout() {
  const [folders, setFolders] = useState<AndroidFolderInfo[]>([]);
  const [images, setImages] = useState<AndroidImageInfo[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AndroidFolderInfo | null>(null);
  const [selectedImage, setSelectedImage] = useState<AndroidImageInfo | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const api = new AndroidAdapter({
    invoke,
    convertFileSrc,
  });

  useEffect(() => {
    loadFolders();
  }, []);

  const loadFolders = async () => {
    setIsLoading(true);
    try {
      const folderList = await api.scanFolders();
      setFolders(folderList);
    } catch (error) {
      console.error('Failed to load folders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadImages = async (folder: AndroidFolderInfo) => {
    setIsLoading(true);
    setSelectedFolder(folder);
    try {
      const imageList = await api.scanImages();
      const filteredImages = imageList.filter(img => 
        img.path.startsWith(folder.path) || 
        img.path.includes(folder.name)
      );
      setImages(filteredImages);
    } catch (error) {
      console.error('Failed to load images:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleImageClick = (image: AndroidImageInfo, index: number) => {
    setSelectedImage(image);
    setSelectedImageIndex(index);
  };

  const handleCloseViewer = () => {
    setSelectedImage(null);
    setSelectedImageIndex(-1);
  };

  const handlePrevImage = useCallback(() => {
    if (selectedImageIndex > 0) {
      const newIndex = selectedImageIndex - 1;
      setSelectedImageIndex(newIndex);
      setSelectedImage(images[newIndex]);
    }
  }, [selectedImageIndex, images]);

  const handleNextImage = useCallback(() => {
    if (selectedImageIndex < images.length - 1) {
      const newIndex = selectedImageIndex + 1;
      setSelectedImageIndex(newIndex);
      setSelectedImage(images[newIndex]);
    }
  }, [selectedImageIndex, images]);

  return (
    <div className="tablet-layout">
      <aside className="sidebar">
        <div style={{ padding: '16px', borderBottom: '1px solid #333' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>相册</h2>
        </div>
        <div className="folder-list">
          {folders.map(folder => (
            <div
              key={folder.id}
              className={`folder-item ${selectedFolder?.id === folder.id ? 'selected' : ''}`}
              onClick={() => loadImages(folder)}
              style={{
                background: selectedFolder?.id === folder.id ? '#333' : undefined
              }}
            >
              <div className="folder-icon">📁</div>
              <div className="folder-info">
                <div className="folder-name">{folder.name}</div>
                <div className="folder-count">{folder.image_count} 张图片</div>
              </div>
            </div>
          ))}
        </div>
      </aside>
      
      <main className="main-content">
        <div style={{ 
          padding: '12px 16px', 
          background: '#252525', 
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <h1 style={{ margin: 0, fontSize: '18px', flex: 1 }}>
            {selectedFolder?.name || '所有图片'}
          </h1>
          <span style={{ color: '#888', fontSize: '14px' }}>
            {images.length} 张
          </span>
        </div>
        
        <div className="content-area">
          {isLoading ? (
            <div className="loading">加载中...</div>
          ) : images.length === 0 ? (
            <div className="loading">
              {selectedFolder ? '此文件夹没有图片' : '请选择一个文件夹'}
            </div>
          ) : (
            <div className="mobile-image-grid">
              {images.map((img, index) => (
                <div
                  key={img.id}
                  className="mobile-image-item"
                  onClick={() => handleImageClick(img, index)}
                >
                  <img
                    src={api.getImageUrl(img.path)}
                    alt={img.name}
                    loading="lazy"
                  />
                  <div className="image-name">{img.name}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      
      {selectedImage && (
        <MobileImageViewer
          image={selectedImage}
          imageUrl={api.getImageUrl(selectedImage.path)}
          onClose={handleCloseViewer}
          onPrev={selectedImageIndex > 0 ? handlePrevImage : undefined}
          onNext={selectedImageIndex < images.length - 1 ? handleNextImage : undefined}
          currentIndex={selectedImageIndex + 1}
          totalCount={images.length}
        />
      )}
    </div>
  );
}

export default TabletLayout;
