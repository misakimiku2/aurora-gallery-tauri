// 共享颜色转换工具：HSV / RGB / Hex 互转
// PC 端 ColorPickerPopover 与 Android 端 MobileColorPickerSheet 共用

export interface RGB { r: number; g: number; b: number; }
export interface HSV { h: number; s: number; v: number; }

export const hexToRgb = (hex: string): RGB | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

export const rgbToHex = ({ r, g, b }: RGB): string => {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
};

export const rgbToHsv = ({ r, g, b }: RGB): HSV => {
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

export const hsvToRgb = ({ h, s, v }: HSV): RGB => {
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

// ─── 最近使用颜色（PC / Android 共享） ───
export const RECENT_COLORS_KEY = 'color_picker_recent';
export const MAX_RECENT_COLORS = 16; // 最多两排（每排 8 个）

export const loadRecentColors = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((c: unknown) => typeof c === 'string') : [];
  } catch {
    return [];
  }
};

export const saveRecentColors = (colors: string[]): void => {
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(colors.slice(0, MAX_RECENT_COLORS)));
  } catch {
    // ignore
  }
};

/** 将 color 加入最近使用列表头部（去重），返回新列表 */
export const addRecentColor = (color: string, prev: string[]): string[] => {
  const next = [color, ...prev.filter(c => c.toLowerCase() !== color.toLowerCase())].slice(0, MAX_RECENT_COLORS);
  saveRecentColors(next);
  return next;
};

