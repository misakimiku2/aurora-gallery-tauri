/**
 * 从代理图 data URL 生成高质量小缩略图（给图层行与全览图用）。
 *
 * 为什么不能直接 `<img src={dataUrl} className="w-8 h-8">`：
 * 浏览器把 2048px 的图一次性缩到 32px 是 64 倍降采样，会用低质近似（近似最近邻），
 * 结果就是用户看到的**满屏锯齿**。正确做法是逐级减半（halving）——每次最多缩 2 倍，
 * 每级都开 `imageSmoothingQuality = 'high'`，等价于手搓一个 mipmap。
 *
 * **返回的宽高是缩略图自己的尺寸**，调用方必须按它布局，不能拿"当前文档尺寸"去撑
 * 这张图：旋转 90° 时新尺寸先到、新缩略图后到（Image 解码是异步的），中间那一帧用
 * 新尺寸套旧图就会**把图拉变形** —— 用户实测看到的"全览图拉伸一下"就是这个。
 *
 * 只在 dataUrl 变化时算一次。
 */
import { useEffect, useState } from 'react';

export interface EditorThumb {
  src: string;
  width: number;
  height: number;
}

/**
 * 从**内存画布**直出小缩略图（2026-10-26 架构轮：画过的层行缩略图走这里，
 * 毫秒级——不再排 Rust 代理队列、不等烘焙落盘）。质量口径与 `downscale`
 * 同一套逐级减半。
 */
export function thumbFromCanvas(source: HTMLCanvasElement, maxEdge: number): EditorThumb {
  const sw = source.width;
  const sh = source.height;
  const ratio = Math.min(1, maxEdge / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * ratio));
  const th = Math.max(1, Math.round(sh * ratio));
  let cur: CanvasImageSource = source;
  let cw = sw;
  let ch = sh;
  while (cw > tw * 2 && ch > th * 2) {
    const nw = Math.max(1, Math.floor(cw / 2));
    const nh = Math.max(1, Math.floor(ch / 2));
    const step = document.createElement('canvas');
    step.width = nw;
    step.height = nh;
    const ctx = step.getContext('2d');
    if (!ctx) break;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    cur = step;
    cw = nw;
    ch = nh;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const octx = out.getContext('2d');
  if (octx) {
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cur, 0, 0, tw, th);
  }
  return { src: out.toDataURL('image/jpeg', 0.92), width: tw, height: th };
}

function downscale(img: HTMLImageElement, maxEdge: number): EditorThumb {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return { src: img.src, width: Math.max(1, sw), height: Math.max(1, sh) };

  const ratio = Math.min(1, maxEdge / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * ratio));
  const th = Math.max(1, Math.round(sh * ratio));
  if (ratio === 1) return { src: img.src, width: sw, height: sh };

  // 逐级减半，直到再缩一半就会小于目标
  let source: CanvasImageSource = img;
  let curW = sw;
  let curH = sh;
  while (curW > tw * 2 && curH > th * 2) {
    const nw = Math.max(1, Math.floor(curW / 2));
    const nh = Math.max(1, Math.floor(curH / 2));
    const step = document.createElement('canvas');
    step.width = nw;
    step.height = nh;
    const ctx = step.getContext('2d');
    if (!ctx) return { src: img.src, width: sw, height: sh };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, nw, nh);
    source = step;
    curW = nw;
    curH = nh;
  }

  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const octx = out.getContext('2d');
  if (!octx) return { src: img.src, width: sw, height: sh };
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(source, 0, 0, tw, th);
  return { src: out.toDataURL('image/jpeg', 0.92), width: tw, height: th };
}

/**
 * @param dataUrl 代理图（`data:image/jpeg;base64,...`）
 * @param maxEdge 缩略图最长边（CSS px；DPI 屏可传 2 倍值保持清晰）
 */
export function useEditorThumbnail(
  dataUrl: string | undefined,
  maxEdge: number,
): EditorThumb | undefined {
  const [thumb, setThumb] = useState<EditorThumb | undefined>(undefined);

  useEffect(() => {
    if (!dataUrl) {
      setThumb(undefined);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        setThumb(downscale(img, maxEdge));
      } catch {
        // canvas 被污染或内存不足时退回原图：糊一点也好过什么都不显示
        setThumb({
          src: dataUrl,
          width: img.naturalWidth || 1,
          height: img.naturalHeight || 1,
        });
      }
    };
    img.onerror = () => {
      if (!cancelled) setThumb(undefined);
    };
    img.src = dataUrl;
    return () => {
      cancelled = true;
    };
  }, [dataUrl, maxEdge]);

  return thumb;
}
