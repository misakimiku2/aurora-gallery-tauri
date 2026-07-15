import React, { useState, useRef, useEffect, useCallback } from 'react';
import { HSV, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, loadRecentColors, addRecentColor } from '../utils/colorUtils';

interface MobileColorPickerSheetProps {
  initialColor?: string;
  onSearch: (color: string) => void;
  onClose: () => void;
  t?: (key: string) => string;
}

const CLASSIC_PRESETS = [
  '#ff0000', '#ff7f00', '#ffff00', '#00ff00',
  '#00ffff', '#0000ff', '#7f00ff', '#ff00ff',
  '#ffffff', '#d3d3d3', '#808080', '#404040',
  '#000000', '#8b4513', '#ff69b4', '#ffb6c1'
];

/**
 * Android 端颜色选择器右侧面板。
 * 作为独立的右侧面板存在（类似 MetadataPanel），从右侧滑入。
 * 仅在 Android 端使用，PC 端继续使用 ColorPickerPopover。
 */
export const MobileColorPickerSheet: React.FC<MobileColorPickerSheetProps> = ({
  initialColor = '#ffffff',
  onSearch,
  onClose,
  t
}) => {
  const [hsv, setHsv] = useState<HSV>(() => {
    const rgb = hexToRgb(initialColor) || { r: 255, g: 255, b: 255 };
    return rgbToHsv(rgb);
  });
  const [hexInput, setHexInput] = useState<string>(initialColor.replace('#', ''));
  const [recent, setRecent] = useState<string[]>(() => loadRecentColors());

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const draggingSV = useRef(false);
  const draggingHue = useRef(false);
  const activePointerId = useRef<number | null>(null);

  // 当前颜色（用于预览和提交）
  const currentHex = React.useMemo(() => {
    const rgb = hsvToRgb(hsv);
    return rgbToHex(rgb);
  }, [hsv]);

  // 同步 hexInput 显示（仅在外部初始色变化或 HSV 拖拽导致颜色变化时）
  useEffect(() => {
    setHexInput(currentHex.replace('#', ''));
  }, [currentHex]);

  // 实时防抖搜索（与 PC 端 ColorPickerPopover 行为一致）
  // currentHex 变化时 300ms 防抖触发搜索
  // 同时用 1.5s 更长防抖更新最近使用，避免拖动中间色被记录
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  // 用 "上次处理过的颜色" 替代 "是否首次渲染"，StrictMode 安全：
  // StrictMode 会在 mount 时执行 effect 两次，isFirstRender 在第一次就被置 false，
  // 第二次就会误触发搜索。改为比较 currentHex 是否和上次相同，相同则跳过。
  const lastProcessedHexRef = useRef<string>(currentHex);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastProcessedHexRef.current === currentHex) return;
    lastProcessedHexRef.current = currentHex;
    // 搜索防抖 300ms
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      onSearchRef.current(currentHex);
    }, 300);
    // 最近使用更新防抖 1.5s（用户停止操作后才记录）
    if (recentTimerRef.current) {
      clearTimeout(recentTimerRef.current);
    }
    recentTimerRef.current = setTimeout(() => {
      setRecent(prev => addRecentColor(currentHex, prev));
    }, 1500);
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      if (recentTimerRef.current) {
        clearTimeout(recentTimerRef.current);
      }
    };
  }, [currentHex]);

  const updateSV = useCallback((clientX: number, clientY: number) => {
    if (!svRef.current) return;
    const rect = svRef.current.getBoundingClientRect();
    let x = clientX - rect.left;
    let y = clientY - rect.top;
    x = Math.max(0, Math.min(x, rect.width));
    y = Math.max(0, Math.min(y, rect.height));
    const s = (x / rect.width) * 100;
    const v = 100 - (y / rect.height) * 100;
    setHsv(prev => ({ ...prev, s, v }));
  }, []);

  const updateHue = useCallback((clientX: number) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const h = (x / rect.width) * 360;
    setHsv(prev => ({ ...prev, h }));
  }, []);

  // Pointer Events 统一处理 mouse/touch
  const handleSVPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingSV.current = true;
    activePointerId.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    updateSV(e.clientX, e.clientY);
  };

  const handleSVPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSV.current || e.pointerId !== activePointerId.current) return;
    updateSV(e.clientX, e.clientY);
  };

  const handleSVPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activePointerId.current) return;
    draggingSV.current = false;
    activePointerId.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleHuePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingHue.current = true;
    activePointerId.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    updateHue(e.clientX);
  };

  const handleHuePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingHue.current || e.pointerId !== activePointerId.current) return;
    updateHue(e.clientX);
  };

  const handleHuePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activePointerId.current) return;
    draggingHue.current = false;
    activePointerId.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace('#', '');
    setHexInput(val);
    if (/^[0-9A-Fa-f]{6}$/.test(val)) {
      const rgb = hexToRgb(val);
      if (rgb) {
        setHsv(rgbToHsv(rgb));
      }
    }
  };

  const handlePresetClick = (color: string) => {
    const rgb = hexToRgb(color);
    if (rgb) {
      setHsv(rgbToHsv(rgb));
      setRecent(prev => addRecentColor(color, prev));
    }
  };

  // 关闭面板（最近使用已由防抖自动保存）
  const handleClose = () => {
    onClose();
  };

  // Android 返回键由 TopBar 统一处理（通过 isColorPickerVisible 状态）
  // 此处不再监听 android-back-press，避免与 TopBar 的处理重复导致 toggle 翻转

  const hueColor = `hsl(${hsv.h}, 100%, 50%)`;
  const rgb = hsvToRgb(hsv);

  return (
    <div
      className="h-full w-full flex flex-col bg-white dark:bg-gray-800"
    >
      {/* 头部 */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <span className="text-base font-semibold text-gray-800 dark:text-gray-100">
          {t ? t('color.title') : 'Search by Color'}
        </span>
      </div>

      {/* 可滚动内容区 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* SV 选择区 */}
        <div
          ref={svRef}
          className="w-full h-48 relative rounded-lg overflow-hidden cursor-crosshair"
          style={{
            backgroundColor: hueColor,
            backgroundImage: `
              linear-gradient(to top, #000, transparent),
              linear-gradient(to right, #fff, transparent)
            `,
            touchAction: 'none'
          }}
          onPointerDown={handleSVPointerDown}
          onPointerMove={handleSVPointerMove}
          onPointerUp={handleSVPointerUp}
          onPointerCancel={handleSVPointerUp}
        >
          <div
            className="w-5 h-5 rounded-full border-2 border-white shadow-md absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{
              left: `${hsv.s}%`,
              top: `${100 - hsv.v}%`,
              backgroundColor: currentHex
            }}
          />
        </div>

        {/* Hue 滑块 */}
        <div className="space-y-1">
          <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
            {t ? t('color.hue') : 'Hue'}
          </div>
          <div
            ref={hueRef}
            className="w-full h-9 rounded-full cursor-pointer relative"
            style={{
              background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
              touchAction: 'none'
            }}
            onPointerDown={handleHuePointerDown}
            onPointerMove={handleHuePointerMove}
            onPointerUp={handleHuePointerUp}
            onPointerCancel={handleHuePointerUp}
          >
            <div
              className="w-4 h-11 bg-white rounded-full shadow-lg border border-gray-300 absolute top-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{ left: `${(hsv.h / 360) * 100}%` }}
            />
          </div>
        </div>

        {/* 当前色 + Hex 输入 */}
        <div className="flex items-center space-x-3">
          <div
            className="w-11 h-11 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0"
            style={{ backgroundColor: currentHex }}
          />
          <div className="flex-1 relative">
            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-sm text-gray-400">#</span>
            <input
              type="text"
              value={hexInput}
              onChange={handleHexChange}
              maxLength={6}
              inputMode="text"
              autoCapitalize="characters"
              className="w-full pl-7 pr-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="FF5733"
            />
          </div>
        </div>

        {/* 预设颜色 */}
        <div className="space-y-1">
          <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
            {t ? t('color.presets') : 'Presets'}
          </div>
          <div className="grid grid-cols-8 gap-1.5">
            {CLASSIC_PRESETS.map(c => (
              <button
                key={c}
                onClick={() => handlePresetClick(c)}
                className="w-6 h-6 rounded-full cursor-pointer hover:scale-110 active:scale-90 transition-transform shadow-sm ring-1 ring-black/10 dark:ring-white/10"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {/* 最近使用 */}
        {recent.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
              {t ? t('color.recent') : 'Recent'}
            </div>
            <div className="grid grid-cols-8 gap-1.5">
              {recent.map((c, i) => (
                <button
                  key={`${c}-${i}`}
                  onClick={() => handlePresetClick(c)}
                  className="w-6 h-6 rounded-full cursor-pointer hover:scale-110 active:scale-90 transition-transform shadow-sm ring-1 ring-black/10 dark:ring-white/10"
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        )}

        {/* RGB / HSV 只读显示 */}
        <div className="flex flex-col text-xs text-gray-500 dark:text-gray-400 px-1 pt-1 space-y-0.5">
          <span>RGB: {rgb.r}, {rgb.g}, {rgb.b}</span>
          <span>HSV: {Math.round(hsv.h)}°, {Math.round(hsv.s)}%, {Math.round(hsv.v)}%</span>
        </div>
      </div>

      {/* 底部操作按钮：实时搜索已自动触发，此处仅提供手动关闭 */}
      <div className="flex items-center px-4 py-3 border-t border-gray-100 dark:border-gray-700 shrink-0 bg-white dark:bg-gray-800">
        <button
          onClick={handleClose}
          className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 active:scale-95 transition-transform"
        >
          {t ? t('color.done') : 'Done'}
        </button>
      </div>
    </div>
  );
};
