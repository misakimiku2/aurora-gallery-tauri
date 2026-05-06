import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { Person, FileNode } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isAndroidPlatformCached } from '../api/tauri-bridge';

interface PersonLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  avatarSize: number;
  person: Person;
}

interface PeopleCanvasProps {
  people: Record<string, Person>;
  files: Record<string, FileNode>;
  selectedPersonId?: string;
  onPersonClick: (id: string, e: React.MouseEvent) => void;
  onPersonDoubleClick: (id: string) => void;
  onPersonContextMenu: (e: React.MouseEvent, id: string) => void;
  width: number;
  height: number;
  scrollTop: number;
  t: (key: string) => string;
  isDarkMode?: boolean;
}

const COLS = 3;
const GAP = 8;
const PADDING = 4;
const AVATAR_SIZE = 48;
const ROW_HEIGHT = 88;

function calculateLayout(people: Record<string, Person>, containerWidth: number): PersonLayout[] {
  const peopleList = Object.values(people || {});
  const itemWidth = (containerWidth - PADDING * 2 - GAP * (COLS - 1)) / COLS;
  
  return peopleList.map((person, index) => {
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    return {
      id: person.id,
      x: PADDING + col * (itemWidth + GAP),
      y: row * ROW_HEIGHT,
      width: itemWidth,
      height: ROW_HEIGHT,
      avatarSize: AVATAR_SIZE,
      person
    };
  });
}

function getVisibleItems(
  layout: PersonLayout[],
  scrollTop: number,
  viewportHeight: number
): PersonLayout[] {
  const buffer = ROW_HEIGHT * 2;
  const minY = scrollTop - buffer;
  const maxY = scrollTop + viewportHeight + buffer;
  
  return layout.filter(item => 
    item.y + item.height >= minY && item.y <= maxY
  );
}

export const PeopleCanvas: React.FC<PeopleCanvasProps> = ({
  people,
  files,
  selectedPersonId,
  onPersonClick,
  onPersonDoubleClick,
  onPersonContextMenu,
  width,
  height,
  scrollTop,
  t,
  isDarkMode = false
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const pendingImagesRef = useRef<Map<string, Promise<HTMLImageElement | null>>>(new Map());
  const rafRef = useRef<number | null>(null);
  const hoverPersonIdRef = useRef<string | null>(null);
  
  const layout = useMemo(() => calculateLayout(people, width), [people, width]);

  const colors = useMemo(() => ({
    bg: isDarkMode ? '#111827' : '#ffffff',
    avatarBg: isDarkMode ? '#1f2937' : '#f3f4f6',
    avatarPlaceholder: isDarkMode ? '#374151' : '#d1d5db',
    avatarPlaceholderIcon: isDarkMode ? '#6b7280' : '#9ca3af',
    nameText: isDarkMode ? '#d1d5db' : '#374151',
    countText: isDarkMode ? '#9ca3af' : '#6b7280',
    selectedBorder: '#a855f7',
    hoverBorder: '#c084fc'
  }), [isDarkMode]);

  const getOrLoadImage = useCallback((coverFileId: string): Promise<HTMLImageElement | null> => {
    if (imageCacheRef.current.has(coverFileId)) {
      return Promise.resolve(imageCacheRef.current.get(coverFileId)!);
    }
    
    if (pendingImagesRef.current.has(coverFileId)) {
      return pendingImagesRef.current.get(coverFileId)!;
    }
    
    const file = files[coverFileId];
    if (!file) return Promise.resolve(null);
    
    const promise = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        imageCacheRef.current.set(coverFileId, img);
        pendingImagesRef.current.delete(coverFileId);
        resolve(img);
      };
      img.onerror = () => {
        pendingImagesRef.current.delete(coverFileId);
        resolve(null);
      };
      img.src = convertFileSrc(file.path);
    });
    
    pendingImagesRef.current.set(coverFileId, promise);
    return promise;
  }, [files]);

  const drawPerson = useCallback((
    ctx: CanvasRenderingContext2D,
    item: PersonLayout,
    isHovered: boolean,
    isSelected: boolean
  ) => {
    const { x, y, width: itemWidth, avatarSize, person } = item;
    const centerX = x + itemWidth / 2;
    const avatarCenterY = y + avatarSize / 2 + 4;
    const radius = avatarSize / 2;
    
    ctx.save();
    
    ctx.beginPath();
    ctx.arc(centerX, avatarCenterY, radius + 2, 0, Math.PI * 2);
    if (isSelected) {
      ctx.strokeStyle = colors.selectedBorder;
      ctx.lineWidth = 3;
      ctx.stroke();
    } else if (isHovered) {
      ctx.strokeStyle = colors.hoverBorder;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    ctx.beginPath();
    ctx.arc(centerX, avatarCenterY, radius, 0, Math.PI * 2);
    ctx.fillStyle = colors.avatarBg;
    ctx.fill();
    
    ctx.beginPath();
    ctx.arc(centerX, avatarCenterY, radius, 0, Math.PI * 2);
    ctx.clip();
    
    const cachedImg = imageCacheRef.current.get(person.coverFileId);
    if (cachedImg) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      if (person.faceBox) {
        const fb = person.faceBox;
        const imgW = cachedImg.width;
        const imgH = cachedImg.height;
        
        const sx = imgW * fb.x / 100;
        const sy = imgH * fb.y / 100;
        const sWidth = imgW * fb.w / 100;
        const sHeight = imgH * fb.h / 100;
        
        ctx.drawImage(
          cachedImg,
          sx, sy, sWidth, sHeight,
          centerX - radius, avatarCenterY - radius,
          avatarSize, avatarSize
        );
      } else {
        const sx = Math.max(0, (cachedImg.width - cachedImg.height) / 2);
        const sy = 0;
        const sSize = Math.min(cachedImg.width, cachedImg.height);
        
        ctx.drawImage(
          cachedImg,
          sx, sy, sSize, sSize,
          centerX - radius, avatarCenterY - radius,
          avatarSize, avatarSize
        );
      }
    } else {
      ctx.fillStyle = colors.avatarPlaceholder;
      ctx.fillRect(centerX - radius, avatarCenterY - radius, avatarSize, avatarSize);
      
      ctx.fillStyle = colors.avatarPlaceholderIcon;
      ctx.font = `${avatarSize * 0.4}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('👤', centerX, avatarCenterY);
    }
    
    ctx.restore();
    
    ctx.fillStyle = colors.nameText;
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    
    const name = person.name.length > 6 ? person.name.slice(0, 5) + '…' : person.name;
    ctx.fillText(name, centerX, y + avatarSize + 10);
    
    ctx.fillStyle = colors.countText;
    ctx.font = '9px system-ui, -apple-system, sans-serif';
    ctx.fillText(`${person.count} ${t('sidebar.files')}`, centerX, y + avatarSize + 24);
  }, [t, colors]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = width;
    const displayHeight = height;
    
    if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
      canvas.width = displayWidth * dpr;
      canvas.height = displayHeight * dpr;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
      ctx.scale(dpr, dpr);
    }
    
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, displayWidth, displayHeight);
    
    const visibleItems = getVisibleItems(layout, scrollTop, height);
    
    for (const item of visibleItems) {
      const isHovered = hoverPersonIdRef.current === item.id;
      const isSelected = selectedPersonId === item.id;
      drawPerson(ctx, item, isHovered, isSelected);
    }
  }, [layout, scrollTop, height, width, selectedPersonId, drawPerson, colors]);

  useEffect(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(draw);
    
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [draw]);

  useEffect(() => {
    const visibleItems = getVisibleItems(layout, scrollTop, height);
    for (const item of visibleItems) {
      if (item.person.coverFileId && !imageCacheRef.current.has(item.person.coverFileId)) {
        getOrLoadImage(item.person.coverFileId).then(() => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(draw);
        });
      }
    }
  }, [layout, scrollTop, height, getOrLoadImage, draw]);

  const getPersonAtPosition = useCallback((clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    
    const rect = canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top + scrollTop;
    
    for (const item of layout) {
      if (canvasX >= item.x && canvasX <= item.x + item.width &&
          canvasY >= item.y && canvasY <= item.y + item.height) {
        return item.id;
      }
    }
    return null;
  }, [layout, scrollTop]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const personId = getPersonAtPosition(e.clientX, e.clientY);
    if (personId) {
      onPersonClick(personId, e);
    }
  }, [getPersonAtPosition, onPersonClick]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const personId = getPersonAtPosition(e.clientX, e.clientY);
    if (personId) {
      onPersonDoubleClick(personId);
    }
  }, [getPersonAtPosition, onPersonDoubleClick]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (isAndroidPlatformCached()) return;
    const personId = getPersonAtPosition(e.clientX, e.clientY);
    if (personId) {
      onPersonContextMenu(e, personId);
    }
  }, [getPersonAtPosition, onPersonContextMenu]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const personId = getPersonAtPosition(e.clientX, e.clientY);
    if (personId !== hoverPersonIdRef.current) {
      hoverPersonIdRef.current = personId;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
      
      if (canvasRef.current) {
        canvasRef.current.style.cursor = personId ? 'pointer' : 'default';
      }
    }
  }, [getPersonAtPosition, draw]);

  const handleMouseLeave = useCallback(() => {
    if (hoverPersonIdRef.current !== null) {
      hoverPersonIdRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    }
  }, [draw]);

  useEffect(() => {
    return () => {
      imageCacheRef.current.clear();
      pendingImagesRef.current.clear();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        display: 'block',
        pointerEvents: 'auto'
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    />
  );
};
