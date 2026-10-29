/**
 * 通用取色器(与颜色面板同款:SV 方块 + 色相条 + 十六进制输入)。
 * 拖动中本地跟手,抬手 / hex 回车失焦时回调 onCommit;value 变化(非拖动中)回灌显示。
 * ColorPanel(前/背景色)与 GradientPanel(渐变停靠点)共用。
 */
import React, { useEffect, useRef, useState } from 'react';

export type RGB = [number, number, number];
type HSV = [number, number, number];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function rgbToHsv(r: number, g: number, b: number): HSV {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max <= 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** "#rrggbb" → 0..1 RGB(非法输入回 null)。 */
export function hexToRgb01(hex: string): RGB | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = m[1];
  return [
    Number.parseInt(n.slice(0, 2), 16) / 255,
    Number.parseInt(n.slice(2, 4), 16) / 255,
    Number.parseInt(n.slice(4, 6), 16) / 255,
  ];
}

export const ColorPicker: React.FC<{
  /** 当前颜色(0..1 RGB);null=无编辑目标(置灰)。 */
  value: RGB | null;
  /** 提交(拖动抬手 / hex 回车或失焦)。 */
  onCommit: (rgb: RGB) => void;
  /** hex 输入旁的目标说明(如"前景色"/"#808080")。 */
  label?: React.ReactNode;
}> = ({ value, onCommit, label }) => {
  const [hsv, setHsv] = useState<HSV>([0, 0, 0]);
  const [hex, setHex] = useState('#000000');
  const hsvRef = useRef<HSV>([0, 0, 0]);
  const draggingRef = useRef(false);
  const lastSyncRef = useRef('');

  function applyHsv(next: HSV) {
    hsvRef.current = next;
    setHsv(next);
    setHex(toHex(...hsvToRgb(...next)));
  }

  const valueKey = value ? `${value[0]},${value[1]},${value[2]}` : '';
  useEffect(() => {
    if (!value || draggingRef.current) return;
    if (lastSyncRef.current === valueKey) return;
    lastSyncRef.current = valueKey;
    applyHsv(rgbToHsv(...value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const commitRgb = () => {
    if (!value) return;
    onCommit(hsvToRgb(...hsvRef.current));
  };

  /** 通用拖动:move 回调给 (0..1) 坐标,抬手提交。 */
  const dragArea = (
    ref: React.RefObject<HTMLDivElement | null>,
    onMove: (fx: number, fy: number) => void,
  ) => (e: React.PointerEvent) => {
    if (!value) return;
    e.preventDefault();
    draggingRef.current = true;
    const rect = ref.current!.getBoundingClientRect();
    const handle = (ev: PointerEvent) => {
      onMove(clamp01((ev.clientX - rect.left) / rect.width), clamp01((ev.clientY - rect.top) / rect.height));
    };
    handle(e as unknown as PointerEvent);
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', handle);
      window.removeEventListener('pointerup', up);
      commitRgb();
    };
    window.addEventListener('pointermove', handle);
    window.addEventListener('pointerup', up);
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [h, sv, v] = hsv;

  return (
    <div className={value ? '' : 'pointer-events-none opacity-40'}>
      <div className="flex flex-col gap-1.5">
        <div
          ref={svRef}
          onPointerDown={dragArea(svRef, (fx, fy) => applyHsv([hsvRef.current[0], fx, 1 - fy]))}
          className="h-20 rounded cursor-crosshair relative"
          style={{
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${Math.round(h * 360)}, 100%, 50%))`,
          }}
        >
          <div
            className="absolute w-2.5 h-2.5 rounded-full border-2 border-white shadow pointer-events-none"
            style={{ left: `calc(${sv * 100}% - 5px)`, top: `calc(${(1 - v) * 100}% - 5px)` }}
          />
        </div>
        <div
          ref={hueRef}
          onPointerDown={dragArea(hueRef, (fx) => applyHsv([fx, hsvRef.current[1], hsvRef.current[2]]))}
          className="h-3 rounded cursor-pointer relative"
          style={{ background: 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)' }}
        >
          <div className="absolute top-0 w-1.5 h-full bg-white border border-black/10 dark:border-white/15 rounded pointer-events-none" style={{ left: `calc(${h * 100}% - 3px)` }} />
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1.5">
        <span className="w-3 h-3 rounded-sm border border-black/20 dark:border-neutral-600" style={{ background: hex }} />
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
          onBlur={() => {
            const rgb = hexToRgb01(hex);
            if (!rgb) return;
            applyHsv(rgbToHsv(...rgb));
            if (value) onCommit(rgb);
          }}
          className="w-20 px-1.5 py-0.5 text-xs bg-surface border border-black/10 dark:border-white/15 rounded text-neutral-200"
          spellCheck={false}
        />
        {label != null && <span className="text-[10px] text-gray-500 dark:text-neutral-400">{label}</span>}
      </div>
    </div>
  );
};
