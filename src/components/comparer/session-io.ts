import JSZip from 'jszip';
import { invoke } from '@tauri-apps/api/core';
import { readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { FileNode } from '../../types';
import {
  Annotation,
  ComparisonItem,
  ComparisonSession,
  ComparisonSessionLayout,
  ComparisonSessionManifest,
  ComparisonSessionViewport,
} from './types';

// 获取文件扩展名
export function getFileExtension(filePath: string): string {
  const match = filePath.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : 'png';
}

// 根据扩展名返回 MIME 类型
export function getMimeType(ext: string): string {
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
         ext === 'png' ? 'image/png' :
         ext === 'gif' ? 'image/gif' :
         ext === 'webp' ? 'image/webp' : 'image/png';
}

// 会话序列化输入
export interface SessionSerializeInput {
  sessionName: string;
  viewport: ComparisonSessionViewport;
  items: ComparisonItem[];
  files: Record<string, FileNode>;
  annotations: Annotation[];
  zOrder: string[];
}

// 将当前会话序列化为 .aurora ZIP 文件字节
export async function serializeSessionToZip(input: SessionSerializeInput): Promise<Uint8Array> {
  const { sessionName, viewport, items, files, annotations, zOrder } = input;
  const zip = new JSZip();

  const manifest: ComparisonSessionManifest = {
    version: '2.0',
    createdAt: Date.now(),
    sessionName
  };
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('viewport.json', JSON.stringify(viewport));

  const imagesFolder = zip.folder('images');
  const imageFileNames: Record<string, string> = {};

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const file = files[item.id];
    if (file && file.path) {
      try {
        const base64Data = await invoke<string>('read_file_as_base64', { filePath: file.path });
        if (base64Data) {
          const base64Content = base64Data.includes(',')
            ? base64Data.split(',')[1]
            : base64Data;
          const imageBytes = Uint8Array.from(atob(base64Content), c => c.charCodeAt(0));
          const ext = getFileExtension(file.path);
          const fileName = `img_${i}.${ext}`;
          imageFileNames[item.id] = fileName;
          imagesFolder?.file(fileName, imageBytes);
        }
      } catch {}
    }
  }

  const layoutData: ComparisonSessionLayout = {
    items: items.map(it => ({
      id: it.id,
      path: files[it.id]?.path || '',
      x: it.x,
      y: it.y,
      width: it.width,
      height: it.height,
      rotation: it.rotation,
      imageFileName: imageFileNames[it.id] || ''
    })),
    annotations,
    zOrder
  };
  zip.file('layout.json', JSON.stringify(layoutData));

  return zip.generateAsync({ type: 'uint8array' });
}

// 会话文件解析结果
export type SessionFileContent =
  | { format: 'legacy'; session: ComparisonSession }
  | { format: 'zip'; manifest: ComparisonSessionManifest; viewport: ComparisonSessionViewport | null; layoutData: ComparisonSessionLayout; zip: JSZip }
  | { format: 'unknown' };

// 读取并解析 .aurora 会话文件（legacy JSON 或 ZIP 格式）
export async function readSessionFile(path: string): Promise<SessionFileContent> {
  // 先尝试 legacy JSON 格式
  try {
    const textContent = await readTextFile(path);
    const parsed = JSON.parse(textContent);
    if (parsed.version && parsed.items) {
      return { format: 'legacy', session: parsed as ComparisonSession };
    }
    // 合法 JSON 但不是会话格式
    return { format: 'unknown' };
  } catch {
    // 不是 JSON，按 ZIP 处理
  }

  // ZIP 格式
  const zipBytes = await readFile(path);
  const zip = await JSZip.loadAsync(zipBytes);

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid .aurora file: manifest.json not found');
  }
  const manifest: ComparisonSessionManifest = JSON.parse(await manifestFile.async('string'));

  const viewportFile = zip.file('viewport.json');
  let viewport: ComparisonSessionViewport | null = null;
  if (viewportFile) {
    viewport = JSON.parse(await viewportFile.async('string'));
  }

  const layoutFile = zip.file('layout.json');
  if (!layoutFile) {
    throw new Error('Invalid .aurora file: layout.json not found');
  }
  const layoutData: ComparisonSessionLayout = JSON.parse(await layoutFile.async('string'));

  return { format: 'zip', manifest, viewport, layoutData, zip };
}

// 从 ZIP 中提取单张图片字节
export async function extractZipImage(zip: JSZip, imageFileName: string): Promise<Uint8Array | null> {
  const imageFile = zip.file(`images/${imageFileName}`);
  if (!imageFile) return null;
  return imageFile.async('uint8array');
}
