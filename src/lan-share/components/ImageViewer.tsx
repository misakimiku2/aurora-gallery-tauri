import React, { useCallback, useMemo, useState } from 'react';
import { BrowseItem, lanShareApi } from '../api';
import { ImageViewerCore } from '@/shared/components/ImageViewer';
import { HttpAdapter } from '@/shared/api/adapters/HttpAdapter';
import { SlideshowConfig } from '@/shared/hooks/useSlideshow';

interface ImageViewerProps {
  image: BrowseItem;
  currentIndex: number;
  totalCount: number;
  allowEdit: boolean;
  token: string;
  onClose: () => void;
  onNavigate: (direction: number) => void;
  onDelete: () => void;
}

const ImageViewer: React.FC<ImageViewerProps> = ({
  image,
  currentIndex,
  totalCount,
  allowEdit,
  token,
  onClose,
  onNavigate,
  onDelete,
}) => {
  const [slideshowConfig, setSlideshowConfig] = useState<SlideshowConfig>({
    interval: 3000,
    transition: 'fade',
    enableZoom: true,
    isRandom: false,
  });

  const api = useMemo(() => {
    return new HttpAdapter('', token);
  }, [token]);

  const handleDelete = useCallback(async () => {
    if (!allowEdit) return;
    
    if (confirm(`确定要删除 "${image.name}" 吗？`)) {
      try {
        await lanShareApi.deleteFile(image.path, token);
        onDelete();
      } catch (err) {
        console.error('Failed to delete file:', err);
        alert('删除失败');
      }
    }
  }, [allowEdit, image.name, image.path, token, onDelete]);

  const handleNavigate = useCallback((direction: number, _random?: boolean) => {
    onNavigate(direction);
  }, [onNavigate]);

  return (
    <ImageViewerCore
      imagePath={image.path}
      imageName={image.name}
      currentIndex={currentIndex}
      totalCount={totalCount}
      api={api}
      allowEdit={allowEdit}
      showNavigation={true}
      enableSlideshow={true}
      enableFullscreen={true}
      onClose={onClose}
      onNavigate={handleNavigate}
      onDelete={handleDelete}
      slideshowConfig={slideshowConfig}
      onSlideshowConfigChange={setSlideshowConfig}
    />
  );
};

export default ImageViewer;
