import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AndroidAdapter } from '../api/adapters/AndroidAdapter';
import { AndroidImageInfo, AndroidFolderInfo } from '../types';
import { MobileImageViewer } from './MobileImageViewer';
import { Menu, X, ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';

export function PhoneLayout() {
  const [folders, setFolders] = useState<AndroidFolderInfo[]>([]);
  const [images, setImages] = useState<AndroidImageInfo[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AndroidFolderInfo | null>(null);
  const [selectedImage, setSelectedImage] = useState<AndroidImageInfo | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number>(-1);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

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
    setIsDrawerOpen(false);
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

  const handleBack = () => {
    setSelectedFolder(null);
    setImages([]);
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
    <div className="phone-layout">
      <header className="phone-header">
        {selectedFolder ? (
          <>
            <button className="back-btn" onClick={handleBack}>
              <ChevronLeft size={24} />
            </button>
            <h1>{selectedFolder.name}</h1>
            <span className="image-count">{images.length} 张</span>
          </>
        ) : (
          <>
            <button className="menu-btn" onClick={() => setIsDrawerOpen(true)}>
              <Menu size={24} />
            </button>
            <h1>Aurora Gallery</h1>
          </>
        )}
      </header>

      <main className="phone-content">
        {isLoading ? (
          <div className="loading">加载中...</div>
        ) : selectedFolder ? (
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
        ) : (
          <div className="folder-list">
            {folders.map(folder => (
              <div
                key={folder.id}
                className="folder-item"
                onClick={() => loadImages(folder)}
              >
                <div className="folder-icon">📁</div>
                <div className="folder-info">
                  <div className="folder-name">{folder.name}</div>
                  <div className="folder-count">{folder.image_count} 张图片</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {isDrawerOpen && (
        <div className="drawer-overlay" onClick={() => setIsDrawerOpen(false)}>
          <div className="drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <h2>相册</h2>
              <button onClick={() => setIsDrawerOpen(false)}>
                <X size={24} />
              </button>
            </div>
            <div className="drawer-content">
              {folders.map(folder => (
                <div
                  key={folder.id}
                  className="drawer-folder-item"
                  onClick={() => loadImages(folder)}
                >
                  <span className="folder-icon">📁</span>
                  <span className="folder-name">{folder.name}</span>
                  <span className="folder-count">{folder.image_count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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

export default PhoneLayout;
