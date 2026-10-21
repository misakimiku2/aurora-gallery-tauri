/**
 * mpv 右键菜单图标栅格化（视频 P4/S2.5）。
 *
 * 菜单是原生 Win32 窗口（airspace 之上），GDI 折线手绘图标歪歪扭扭还有锯齿
 * （2026-10-21 真机反馈）。正解：**前端把 React 用的 lucide 图标栅格化成 RGBA 位图**
 * 传给 Rust —— 用的是与界面完全相同的矢量源 + canvas 抗锯齿，观感天然一致。
 *
 * 产出为「白色 + 透明底」的 RGBA（base64），Rust 侧按 hover 状态重新着色，
 * 一份位图适配两种状态。下标顺序与 Rust `MENU_ACTIONS` 严格对齐，别动。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Play, Rewind, FastForward, Gauge, Repeat, ExternalLink, FolderOpen,
  type LucideIcon,
} from 'lucide-react';

/** 顺序 = Rust MENU_ACTIONS：0 播放/暂停 · 1 后退5s · 2 前进5s · 3 倍速 · 4 循环 · 5 系统播放器 · 6 资源管理器 */
const ICONS: LucideIcon[] = [Play, Rewind, FastForward, Gauge, Repeat, ExternalLink, FolderOpen];

/** 菜单里的图标 CSS 尺寸（= ContextMenu.tsx 的 iconSize） */
const ICON_CSS_PX = 14;

async function iconToBase64Rgba(Icon: LucideIcon, px: number): Promise<string | null> {
  // currentColor 在无 CSS 上下文的 SVG 里会落成黑色，先统一换成白色
  let markup = renderToStaticMarkup(createElement(Icon, { size: px, strokeWidth: 2 }));
  markup = markup.replace(/currentColor/g, '#ffffff');
  if (!markup.includes('xmlns=')) {
    markup = markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  }
  const img = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('菜单图标 SVG 加载失败'));
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  try {
    await loaded;
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, px, px);
  const data = ctx.getImageData(0, 0, px, px).data;
  // RGBA → base64（分块拼接，避免 apply 参数上限）
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 栅格化全部菜单图标；失败的项跳过（Rust 侧回退内置折线图标）。 */
export const renderMpvMenuIcons = async (dpr: number): Promise<string[]> => {
  const px = Math.max(8, Math.round(ICON_CSS_PX * dpr));
  const out: string[] = [];
  for (const Icon of ICONS) {
    const b64 = await iconToBase64Rgba(Icon, px);
    if (b64) out.push(b64);
  }
  return out;
};
