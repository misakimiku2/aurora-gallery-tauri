import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, addRecentColor, loadRecentColors, saveRecentColors, MAX_RECENT_COLORS } from '../colorUtils';

describe('hexToRgb', () => {
  it('parses 6-digit hex with or without #', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('handles case-insensitivity', () => {
    expect(hexToRgb('#AABBCC')).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('returns null for invalid input', () => {
    expect(hexToRgb('#ff00')).toBeNull();
    expect(hexToRgb('red')).toBeNull();
    expect(hexToRgb('#gggggg')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });
});

describe('rgbToHex', () => {
  it('formats with zero-padding', () => {
    expect(rgbToHex({ r: 10, g: 11, b: 12 })).toBe('#0a0b0c');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe('#ffffff');
  });
});

describe('rgb <-> hsv round trip', () => {
  it('converts red/black/white accurately', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, v: 100 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 100 });
  });

  it('round-trips back to the same rgb within rounding tolerance', () => {
    const samples = [
      { r: 34, g: 139, b: 34 },
      { r: 240, g: 128, b: 128 },
      { r: 75, g: 0, b: 130 },
      { r: 245, g: 222, b: 179 },
    ];
    for (const rgb of samples) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
});

describe('recent colors', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('addRecentColor prepends and dedupes case-insensitively', () => {
    const next = addRecentColor('#FF0000', ['#00ff00', '#ff0000']);
    expect(next[0]).toBe('#FF0000');
    expect(next.filter(c => c.toLowerCase() === '#ff0000')).toHaveLength(1);
    expect(next).toContain('#00ff00');
  });

  it('caps the list at MAX_RECENT_COLORS', () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_RECENT_COLORS + 5; i++) {
      list = addRecentColor(`#${i.toString(16).padStart(6, '0')}`, list);
    }
    expect(list).toHaveLength(MAX_RECENT_COLORS);
  });

  it('saveRecentColors persists to localStorage and loadRecentColors restores it', () => {
    saveRecentColors(['#111111', '#222222']);
    expect(loadRecentColors()).toEqual(['#111111', '#222222']);
  });

  it('loadRecentColors tolerates corrupted storage', () => {
    localStorage.setItem('color_picker_recent', '{not json');
    expect(loadRecentColors()).toEqual([]);
    localStorage.setItem('color_picker_recent', JSON.stringify([1, 2, 'ok']));
    expect(loadRecentColors()).toEqual(['ok']);
  });
});
