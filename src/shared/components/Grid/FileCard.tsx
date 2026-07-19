import React, { useState } from 'react';
import { BrowseItem, ImageApi } from '../../api/types';
import { ImageThumbnail } from '../Thumbnails/ImageThumbnail';
import { FolderThumbnail } from '../Thumbnails/FolderThumbnail';
import { LayoutItem } from '../../api/types';

export interface FileCardProps {
  item: BrowseItem;
  layout: LayoutItem;
  api: ImageApi;
  isSelected?: boolean;
  previewPaths?: string[];
  onClick?: () => void;
  onDoubleClick?: () => void;
}

export const FileCard: React.FC<FileCardProps> = ({
  item,
  layout,
  api,
  isSelected = false,
  previewPaths = [],
  onClick,
  onDoubleClick,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const isFolder = item.type === 'folder';

  return (
    <div
      className={`file-item group cursor-pointer transition-all duration-300 ease-out flex flex-col items-center rounded-xl ${
        isSelected ? 'z-10' : 'z-0 hover:scale-[1.01]'
      }`}
      style={{
        position: 'absolute',
        left: `${layout.x}px`,
        top: `${layout.y}px`,
        width: `${layout.width}px`,
        height: `${layout.height}px`,
        willChange: 'transform',
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={`w-full flex-1 rounded-xl overflow-hidden relative transition-shadow transition-transform duration-300 ${
          isSelected
            ? 'bg-blue-100 dark:bg-blue-500/10 shadow-[0_4px_6px_-1px_rgba(59,130,246,0.2)] dark:shadow-[0_4px_6px_-1px_rgba(59,130,246,0.3)] after:absolute after:inset-0 after:rounded-xl after:border-[3px] after:border-blue-400 dark:after:border-blue-500 after:pointer-events-none after:z-10'
            : 'bg-gray-100 dark:bg-gray-800'
        }`}
        style={{ height: layout.height - 40 }}
      >
        {isFolder ? (
          <FolderThumbnail
            folder={item}
            api={api}
            previewPaths={item.preview_images || []}
          />
        ) : (
          <ImageThumbnail
            path={item.path}
            alt={item.name}
            api={api}
            width={item.width}
            height={item.height}
          />
        )}

        <div
          className={`absolute top-2 left-2 z-20 transition-opacity duration-200 ${
            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <div className="w-5 h-5 bg-black/30 hover:bg-black/50 rounded-full border border-white/50 backdrop-blur-sm" />
        </div>
      </div>

      <div className="mt-1.5 w-full text-center px-1 h-8 flex flex-col justify-start leading-tight">
        <div
          className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate w-full"
          title={item.name}
        >
          {item.name}
        </div>
        {item.width && item.height && (
          <div className="text-[9px] text-gray-400 truncate">
            {item.width}x{item.height}
          </div>
        )}
      </div>
    </div>
  );
};

export default FileCard;
