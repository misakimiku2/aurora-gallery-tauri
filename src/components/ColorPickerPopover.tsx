import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Pipette, Copy, Check } from 'lucide-react';

interface RGB { r: number; g: number; b: number; }
interface HSV { h: number; s: number; v: number; }

// Utils
const hexToRgb = (hex: string): RGB | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

const rgbToHex = ({ r, g, b }: RGB): string => {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
};

const rgbToHsv = ({ r, g, b }: RGB): HSV => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;

  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  return { h: h * 360, s: s * 100, v: v * 100 };
};

const hsvToRgb = ({ h, s, v }: HSV): RGB => {
  let r = 0, g = 0, b = 0;
  const i = Math.floor(h / 60);
  const f = h / 60 - i;
  const p = v / 100 * (1 - s / 100);
  const q = v / 100 * (1 - f * s / 100);
  const t = v / 100 * (1 - (1 - f) * s / 100);
  const v_norm = v / 100;

  switch (i % 6) {
    case 0: r = v_norm; g = t; b = p; break;
    case 1: r = q; g = v_norm; b = p; break;
    case 2: r = p; g = v_norm; b = t; break;
    case 3: r = p; g = q; b = v_norm; break;
    case 4: r = t; g = p; b = v_norm; break;
    case 5: r = v_norm; g = p; b = q; break;
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255)
  };
};

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
  
  // Update internal state when props change, but prevent loops if needed
  // (In a real app, you might want to debounce)
  
  const handleHsvChange = (newHsv: Partial<HSV>) => {
    const updatedHsv = { ...hsv, ...newHsv };
    setHsv(updatedHsv);
    const rgb = hsvToRgb(updatedHsv);
    const newHex = rgbToHex(rgb);
    setHex(newHex);
    onChange(newHex);
  };

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

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [isDraggingSV, setIsDraggingSV] = useState(false);
  const [isDraggingHue, setIsDraggingHue] = useState(false);

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
  }, [hsv]); // Dependencies handled by state updater logic actually, but good to be safe

  const updateHue = useCallback((clientX: number) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    let x = clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    const h = (x / rect.width) * 360;
    handleHsvChange({ h });
  }, [hsv]);

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
    <div className={`p-3 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 w-64 select-none ${className}`}>
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
            className="w-6 h-6 rounded border border-gray-200 dark:border-gray-600 flex-shrink-0" 
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
               className="w-full pl-5 pr-1 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 uppercase focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                className="w-12 px-1 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                   try {
                       // @ts-ignore
                       const result = await new window.EyeDropper().open();
                       handleHexChange({ target: { value: result.sRGBHex } } as any);
                   } catch (e) {
                       console.log('Eyedropper canceled');
                   }
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
      <div className="flex flex-wrap gap-1.5">
         {presetColors.map(c => (
             <button
               key={c}
               className="w-5 h-5 rounded hover:scale-110 transition-transform border border-gray-200 dark:border-gray-700"
               style={{ backgroundColor: c }}
               onClick={() => handleHexChange({ target: { value: c } } as any)}
             />
         ))}
      </div>
    </div>
  );
};
