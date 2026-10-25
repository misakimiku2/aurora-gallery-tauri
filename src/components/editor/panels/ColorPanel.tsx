/** 颜色面板:前/背景色芯片 + HSV 域 + 色相条 + 十六进制。提交走 tools.setColors。 */
import React, { useEffect, useRef, useState } from 'react';
import { runCommand, getSession, subscribeSession } from '../editorStore';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
type RGB = [number, number, number];
type HSV = [number, number, number];

function rgbToHsv(r: number, g: number, b: number): HSV {
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

function hsvToRgb(h: number, s: number, v: number): RGB {
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

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('')}`;

export const ColorPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const [target, setTarget] = useState<'foreground' | 'background'>('foreground');
  const [hsv, setHsv] = useState<HSV>([0, 0, 0]);
  const [hex, setHex] = useState('#000000');
  const hsvRef = useRef<HSV>([0, 0, 0]);
  const draggingRef = useRef(false);
  const lastSyncRef = useRef('');

  const applyHsv = (next: HSV) => {
    hsvRef.current = next;
    setHsv(next);
    setHex(toHex(...hsvToRgb(...next)));
  };

  const color = s?.state?.[target];
  useEffect(() => {
    if (!color || color.length < 3 || draggingRef.current) return;
    const [r, g, b] = color;
    const sync = `${target}:${r},${g},${b}`;
    if (lastSyncRef.current === sync) return;
    lastSyncRef.current = sync;
    applyHsv(rgbToHsv(r, g, b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, target]);

  const commit = () => {
    const h = toHex(...hsvToRgb(...hsvRef.current));
    void runCommand(tabId, 'tools.setColors', { [target]: h }).catch(console.error);
  };

  /** 通用拖动:move 回调给 (0..1) 坐标,up 时提交。 */
  const dragArea = (
    ref: React.RefObject<HTMLDivElement | null>,
    onMove: (fx: number, fy: number) => void,
  ) => (e: React.PointerEvent) => {
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
      commit();
    };
    window.addEventListener('pointermove', handle);
    window.addEventListener('pointerup', up);
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  if (!s || !s.state) return <div className="px-2 py-1.5 text-[11px] text-gray-500 dark:text-neutral-400">颜色</div>;
  const [h, sv, v] = hsv;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-2 py-1 text-[11px] text-gray-500 dark:text-neutral-400">颜色</div>
      <div className="flex gap-2 px-2 pb-2">
        <div className="relative w-11 h-11 shrink-0">
          <button
            title="背景色"
            onClick={() => setTarget('background')}
            className={`absolute right-0 bottom-0 w-7 h-7 rounded-sm border ${target === 'background' ? 'border-sky-400 ring-1 ring-sky-400' : 'border-black/30 dark:border-neutral-500'}`}
            style={{ background: toHex(...(s.state.background.slice(0, 3) as RGB)) }}
          />
          <button
            title="前景色"
            onClick={() => setTarget('foreground')}
            className={`absolute left-0 top-0 w-7 h-7 rounded-sm border z-10 ${target === 'foreground' ? 'border-sky-400 ring-1 ring-sky-400' : 'border-black/40 dark:border-neutral-300'}`}
            style={{ background: toHex(...(s.state.foreground.slice(0, 3) as RGB)) }}
          />
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
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
      </div>
      <div className="flex items-center gap-2 px-2 pb-2">
        <span className="w-3 h-3 rounded-sm border border-black/20 dark:border-neutral-600" style={{ background: hex }} />
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
          onBlur={() => {
            const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
            if (!m) return;
            applyHsv(rgbToHsv(((parseInt(m[1].slice(0, 2), 16)) / 255), ((parseInt(m[1].slice(2, 4), 16)) / 255), ((parseInt(m[1].slice(4, 6), 16)) / 255)));
            void runCommand(tabId, 'tools.setColors', { [target]: `#${m[1]}` }).catch(console.error);
          }}
          className="w-20 px-1.5 py-0.5 text-xs bg-surface border border-black/10 dark:border-white/15 rounded text-neutral-200"
          spellCheck={false}
        />
        <span className="text-[10px] text-gray-500 dark:text-neutral-400">{target === 'foreground' ? '前景色' : '背景色'}</span>
      </div>
    </div>
  );
};
