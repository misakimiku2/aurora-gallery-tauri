/**
 * 混合模式的名字表与归一化。
 *
 * 这里锁的是**两端共用的那一份字符串**：预览把它交给 CSS 的 `mix-blend-mode`、
 * 导出把它交给 Rust 的 `BlendMode::parse`。任何一边改了名字，这里必须先红。
 */
import { describe, expect, it } from 'vitest';
import { BLEND_MODES, normalizeBlendMode } from '../blendModes';

describe('混合模式名字表', () => {
  it('16 档，第一档是正常、末四档是 PS 的非可分离组', () => {
    expect(BLEND_MODES).toHaveLength(16);
    expect(BLEND_MODES[0].id).toBe('normal');
    expect(BLEND_MODES.slice(-4).map(m => m.id)).toEqual(['hue', 'saturation', 'color', 'luminosity']);
  });

  it('每个 id 都有中文名，且无重复', () => {
    const ids = BLEND_MODES.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of BLEND_MODES) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('id 全是 CSS `mix-blend-mode` 认的名字（kebab-case 小写）', () => {
    for (const m of BLEND_MODES) {
      expect(m.id).toMatch(/^[a-z]+(-[a-z]+)?$/);
    }
  });
});

describe('normalizeBlendMode', () => {
  it('未知 / 脏数据一律落 normal（与 Rust 的 parse 同口径）', () => {
    expect(normalizeBlendMode(undefined)).toBe('normal');
    expect(normalizeBlendMode('')).toBe('normal');
    expect(normalizeBlendMode('色相')).toBe('normal'); // 中文标签不是 id，id 全是小写英文
    expect(normalizeBlendMode(42)).toBe('normal');
  });

  it('认得表里的每一档', () => {
    for (const m of BLEND_MODES) {
      expect(normalizeBlendMode(m.id)).toBe(m.id);
    }
  });
});
