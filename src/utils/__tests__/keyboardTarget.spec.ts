import { describe, expect, it } from 'vitest';
import { isTextEditingTarget } from '../keyboardTarget';

/**
 * 全局快捷键的「让路」判据（UI 设计 §4）。
 *
 * 看点在两处边界：
 *  - 文本框里的空格 / m / f / , / . 必须原样打字，不能被当成播放器命令吞掉；
 *  - 进度条与音量条也是 `<input>`，但它们不是编辑目标 —— 否则点过控件之后
 *    空格暂停、← → 快退这些就全失灵了。
 */
const make = (tagName: string, type?: string): HTMLElement => {
  const el = document.createElement(tagName.toLowerCase());
  if (type) (el as HTMLInputElement).type = type;
  return el as HTMLElement;
};

describe('isTextEditingTarget', () => {
  it('文本类输入目标是编辑目标', () => {
    for (const type of ['text', 'search', 'url', 'tel', 'email', 'number', 'password', 'date']) {
      expect(isTextEditingTarget(make('INPUT', type))).toBe(true);
    }
    expect(isTextEditingTarget(make('TEXTAREA'))).toBe(true);
    expect(isTextEditingTarget(make('SELECT'))).toBe(true);
  });

  it('播放器控件不算编辑目标', () => {
    for (const type of ['range', 'checkbox', 'radio', 'button', 'submit', 'image', 'color']) {
      expect(isTextEditingTarget(make('INPUT', type))).toBe(false);
    }
  });

  it('contenteditable 算编辑目标，普通元素与空目标不算', () => {
    const box = document.createElement('div');
    // jsdom 不实现 contenteditable 语义，直接打桩这个只读判断的输入
    Object.defineProperty(box, 'isContentEditable', { value: true });
    expect(isTextEditingTarget(box)).toBe(true);
    expect(isTextEditingTarget(document.createElement('div'))).toBe(false);
    expect(isTextEditingTarget(document.createElement('span'))).toBe(false);
    expect(isTextEditingTarget(null)).toBe(false);
  });
});
