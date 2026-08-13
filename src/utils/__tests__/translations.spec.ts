import { describe, it, expect } from 'vitest';
import { translations } from '../translations';

type Obj = Record<string, unknown>;

const collectKeys = (obj: Obj, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? collectKeys(v as Obj, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );

describe('translations', () => {
  it('has zh and en top-level locales', () => {
    expect(Object.keys(translations)).toEqual(expect.arrayContaining(['zh', 'en']));
  });

  it('zh and en contain the exact same key structure', () => {
    const zhKeys = collectKeys(translations.zh).sort();
    const enKeys = collectKeys(translations.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('every value is a non-empty string', () => {
    const zh = translations.zh as Obj;
    const emptyKeys = collectKeys(zh).filter(key => {
      const value = key.split('.').reduce<unknown>((acc, part) => (acc as Obj)?.[part], zh);
      return typeof value !== 'string' || value.trim() === '';
    });
    expect(emptyKeys).toEqual([]);
  });
});
