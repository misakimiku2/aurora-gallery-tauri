/**
 * 从代理图 data URL 生成高质量小缩略图（给图层行与全览图用）。
 *
 * 为什么不能直接 `<img src={dataUrl} className="w-8 h-8">`：
 * 浏览器把 2048px 的图一次性缩到 32px 是 64 倍降采样，会用低质近似（近似最近邻），
 * 结果就是用户看到的**满屏锯齿**。正确做法是逐级减半（halving）——每次最多缩 2 倍，
 * 每级都开 `imageSmoothingQuality = 'high'`，等价于手搓一个 mipmap。
 *
 * 只在 dataUrl 变化时算一次，尺寸变化不重算（依赖数组只放 dataUrl / maxEdge）。
 */
import { useEffect, useState } from 'react';

function downscaleToDataUrl(img: HTMLImageElement, maxEdge: number): string {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return img.src;

  const ratio = Math.min(1, maxEdge / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * ratio));
  const th = Math.max(1, Math.round(sh * ratio));
  if (ratio === 1) return img.src;

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
    if (!ctx) return img.src;
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
  if (!octx) return img.src;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(source, 0, 0, tw, th);
  return out.toDataURL('image/jpeg', 0.92);
}

/**
 * @param dataUrl 代理图（`data:image/jpeg;base64,...`）
 * @param maxEdge 缩略图最长边（CSS px；DPI 屏可传 2 倍值保持清晰）
 */
export function useEditorThumbnail(dataUrl: string | undefined, maxEdge: number): string | undefined {
  const [thumb, setThumb] = useState<string | undefined>(undefined);

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
        setThumb(downscaleToDataUrl(img, maxEdge));
      } catch {
        // canvas 被污染或内存不足时退回原图：糊一点也好过什么都不显示
        setThumb(dataUrl);
      }
    };
    img.onerror = () => {
      if (!cancelled) setThumb(dataUrl);
    };
    img.src = dataUrl;
    return () => {
      cancelled = true;
    };
  }, [dataUrl, maxEdge]);

  return thumb;
}
