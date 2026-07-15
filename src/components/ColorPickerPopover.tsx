import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Pipette, Copy, Check } from 'lucide-react';
import { RGB, HSV, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, loadRecentColors, addRecentColor } from '../utils/colorUtils';

interface ColorPickerPopoverProps {
  initialColor?: string;
  onChange: (color: string) => void;
  onClose: () => void;
  className?: string; // For positioning
  t?: (key: string) => string;
}

export const ColorPickerPopover: React.FC<ColorPickerPopoverProps> = ({
  initialColor = '#ffffff',
  onChange,
  onClose,
  className
, t
}) => {
  const [hsv, setHsv] = useState<HSV>(() => {
     const rgb = hexToRgb(initialColor) || { r: 255, g: 255, b: 255 };
     return rgbToHsv(rgb);
  });
  const [hex, setHex] = useState<string>(initialColor);
  const [recent, setRecent] = useState<string[]>(() => loadRecentColors());

  // 颜色变化时防抖更新最近使用（1.5s 延迟，避免拖动中间色被记录）
  useEffect(() => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return;
    const timer = setTimeout(() => {
      setRecent(prev => addRecentColor(hex, prev));
    }, 1500);
    return () => clearTimeout(timer);
  }, [hex]);

  // 预设/最近色块点击时需要立即保存（因为 onClose 会卸载组件，防抖 timer 会被清除）
  const saveRecentImmediate = (color: string) => {
    setRecent(prev => addRecentColor(color, prev));
  };

  // Use ref to avoid closure issues with onChange callback
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Update internal state when props change, but prevent loops if needed
  // (In a real app, you might want to debounce)

  const handleHsvChange = useCallback((newHsv: Partial<HSV>) => {
    setHsv(prev => {
      const updatedHsv = { ...prev, ...newHsv };
      const rgb = hsvToRgb(updatedHsv);
      const newHex = rgbToHex(rgb);
      setHex(newHex);
      onChangeRef.current(newHex);
      return updatedHsv;
    });
  }, []);

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHex(val);
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      const rgb = hexToRgb(val);
      if (rgb) {
        setHsv(rgbToHsv(rgb));
        onChange(val);
      }
    }
  };

  useEffect(() => {
    if (initialColor && /^#[0-9A-Fa-f]{6}$/i.test(initialColor)) {
      setHex(initialColor);
      const rgb = hexToRgb(initialColor);
      if (rgb) {
        setHsv(rgbToHsv(rgb));
      }
    }
  }, [initialColor]);

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [isDraggingSV, setIsDraggingSV] = useState(false);
  const [isDraggingHue, setIsDraggingHue] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // Prevent background scrolling when mouse is over the picker
      e.preventDefault();
      e.stopPropagation();

      const step = 5;
      const direction = e.deltaY > 0 ? 1 : -1;

      setHsv(prev => {
        let nextH = prev.h + direction * step;
        if (nextH < 0) nextH += 360;
        if (nextH >= 360) nextH -= 360;

        const updatedHsv = { ...prev, h: nextH };
        const rgb = hsvToRgb(updatedHsv);
        const newHex = rgbToHex(rgb);

        setHex(newHex);
        onChangeRef.current(newHex);

        return updatedHsv;
      });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const updateSV = useCallback((clientX: number, clientY: number) => {
    if (!svRef.current) return;
    const rect = svRef.current.getBoundingClientRect();
    let x = clientX - rect.left;
    let y = clientY - rect.top;

    // Clamp
    x = Math.max(0, Math.min(x, rect.width));
    y = Math.max(0, Math.min(y, rect.height));

    const s = (x / rect.width) * 100;
    const v = 100 - (y / rect.height) * 100;

    handleHsvChange({ s, v });
  }, [handleHsvChange]);

  const updateHue = useCallback((clientX: number) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const h = (x / rect.width) * 360;
    handleHsvChange({ h });
  }, [handleHsvChange]);

  useEffect(() => {
    const handleUp = () => {
      setIsDraggingSV(false);
      setIsDraggingHue(false);
    };

    const handleMove = (e: MouseEvent) => {
      if (isDraggingSV) updateSV(e.clientX, e.clientY);
      if (isDraggingHue) updateHue(e.clientX);
    };

    if (isDraggingSV || isDraggingHue) {
      window.addEventListener('mouseup', handleUp);
      window.addEventListener('mousemove', handleMove);
    }

    return () => {
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('mousemove', handleMove);
    };
  }, [isDraggingSV, isDraggingHue, updateSV, updateHue]);

  const presetColors = [
    '#ff0000', '#ffa500', '#ffff00', '#008000', '#0000ff', '#4b0082', '#ee82ee',
    '#ffffff', '#000000', '#808080', '#a52a2a', '#00ffff', '#ff00ff', '#c0c0c0'
  ];
  
  const rgb = hsvToRgb(hsv);
  const hueColor = `hsl(${hsv.h}, 100%, 50%)`;

  return (
    <div 
      ref={containerRef}
      className={`p-3 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-800 w-64 select-none ${className}`}
    >
      {/* Saturation/Value Area */}
      <div 
        ref={svRef}
        className="w-full h-40 relative rounded-md cursor-crosshair mb-3 overflow-hidden"
        style={{
          backgroundColor: hueColor,
          backgroundImage: `
            linear-gradient(to top, #000, transparent),
            linear-gradient(to right, #fff, transparent)
          `
        }}
        onMouseDown={(e) => {
            setIsDraggingSV(true);
            updateSV(e.clientX, e.clientY);
        }}
      >
        <div 
          className="w-3 h-3 rounded-full border-2 border-white shadow-sm absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ 
            left: `${hsv.s}%`, 
            top: `${100 - hsv.v}%`,
            backgroundColor: hex
          }} 
        />
      </div>

      {/* Hue Slider */}
      <div className="flex items-center space-x-2 mb-3">
         <div 
           ref={hueRef}
           className="flex-1 h-3 rounded-full cursor-pointer relative"
           style={{
             background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
           }}
           onMouseDown={(e) => {
               setIsDraggingHue(true);
               updateHue(e.clientX);
           }}
         >
           <div 
             className="w-3 h-3 bg-white rounded-full shadow border border-gray-300 absolute top-0 transform -translate-x-1/2"
             style={{ left: `${(hsv.h / 360) * 100}%` }}
           />
         </div>
         
         <div 
            className="w-6 h-6 rounded border border-gray-200 dark:border-gray-700 flex-shrink-0" 
            style={{ backgroundColor: hex }}
         />
      </div>

      {/* Inputs */}
      <div className="flex space-x-2 mb-3">
          <div className="flex-1 relative">
             <span className="absolute left-2 top-1/2 transform -translate-y-1/2 text-xs text-gray-400">#</span>
             <input 
               type="text" 
               value={hex.replace('#','')} 
               onChange={e => handleHexChange({ ...e, target: { ...e.target, value: '#' + e.target.value } })}
               className="w-full pl-5 pr-1 py-1 text-xs border border-gray-200 dark:border-gray-800 rounded bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 uppercase focus:outline-none focus:ring-1 focus:ring-blue-500"
             />
          </div>
           <div className="flex space-x-1 w-36">
             {[rgb.r, rgb.g, rgb.b].map((val, i) => (
               <input 
                key={i}
                type="number"
                min="0"
                max="255"
                value={val}
                onChange={(e) => {
                   const newRgb = { ...rgb };
                   const v = Math.min(255, Math.max(0, parseInt(e.target.value) || 0));
                   if (i === 0) newRgb.r = v;
                   if (i === 1) newRgb.g = v;
                   if (i === 2) newRgb.b = v;
                   const newHsv = rgbToHsv(newRgb);
                   setHsv(newHsv);
                   setHex(rgbToHex(newRgb));
                   onChange(rgbToHex(newRgb));
                }}
                className="w-12 px-1 py-1 text-xs border border-gray-200 dark:border-gray-800 rounded bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
               />
             ))}
           </div>
      </div>

      {/* Eyedropper & Copy */}
      <div className="flex justify-between items-center mb-3">
         <button 
           className="flex items-center text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
           onClick={async () => {
               // Use native eyedropper if available
               // @ts-ignore
               if (window.EyeDropper) {
                   // Create instance and start opening immediately before heavy React state updates
                   // @ts-ignore
                   const eyeDropper = new window.EyeDropper();
                   const openPromise = eyeDropper.open();
                   
                   onClose(); // Hide UI in parallel
                   
                   try {
                       const result = await openPromise;
                       onChange(result.sRGBHex); // Directly trigger search
                       // 组件已卸载，直接写入 localStorage
                       addRecentColor(result.sRGBHex, loadRecentColors());
                   } catch {}
               } else {
                   alert(t ? t('color.pickColor') + ' - Eyedropper not supported' : 'Browser does not support Eyedropper API');
               }
           }}
         >
             <Pipette size={12} className="mr-1" />
             <span>{t ? t('color.pickColor') : 'Pick Color'}</span>
         </button>
      </div>

      {/* Presets */}
      <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-1">{t ? t('color.presets') : 'Presets'}</div>
      <div className="flex flex-wrap gap-1.5 mb-2">
         {presetColors.map(c => (
             <button
               key={c}
               className="w-5 h-5 rounded-full cursor-pointer hover:scale-110 transition-transform shadow-sm ring-1 ring-black/10 dark:ring-white/10"
               style={{ backgroundColor: c }}
               onClick={() => {
                   handleHexChange({ target: { value: c } } as any);
                   saveRecentImmediate(c);
                   onClose();
               }}
             />
         ))}
      </div>

      {/* Recent */}
      {recent.length > 0 && (
        <>
        <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-1">{t ? t('color.recent') : 'Recent'}</div>
        <div className="flex flex-wrap gap-1.5">
           {recent.map((c, i) => (
               <button
                 key={`${c}-${i}`}
                 className="w-5 h-5 rounded-full cursor-pointer hover:scale-110 transition-transform shadow-sm ring-1 ring-black/10 dark:ring-white/10"
                 style={{ backgroundColor: c }}
                 onClick={() => {
                     handleHexChange({ target: { value: c } } as any);
                     saveRecentImmediate(c);
                     onClose();
                 }}
               />
           ))}
        </div>
        </>
      )}
    </div>
  );
};
