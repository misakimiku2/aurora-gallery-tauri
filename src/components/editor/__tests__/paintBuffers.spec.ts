/**
 * 画笔像素缓冲注册表的单测：登记/读取/换 key（forget）/LRU 逐出。
 * 用假 canvas 对象（注册表不碰 canvas API，只存引用）。
 */
import { describe, expect, it } from 'vitest';
import {
  forgetPaintBuffer,
  getPaintBuffer,
  rememberPaintBuffer,
} from '../paintBuffers';

const fakeCanvas = (tag: string): HTMLCanvasElement => ({ tag } as unknown as HTMLCanvasElement);

describe('paintBuffers（像素缓冲注册表）', () => {
  it('登记后可按 source 读到同一块画布', () => {
    const c = fakeCanvas('a');
    rememberPaintBuffer('p1', c);
    expect(getPaintBuffer('p1')).toBe(c);
    expect(getPaintBuffer('unknown')).toBeUndefined();
    forgetPaintBuffer('p1');
  });

  it('换 key 时 forget 旧 key——防止撤销回旧 source 却拿到被改写的同一对象', () => {
    const c = fakeCanvas('shared');
    rememberPaintBuffer('p1', c);
    rememberPaintBuffer('p2', c); // 同一对象换 key（每笔的实际形态）
    forgetPaintBuffer('p1');
    expect(getPaintBuffer('p1')).toBeUndefined();
    expect(getPaintBuffer('p2')).toBe(c);
    forgetPaintBuffer('p2');
  });

  it('LRU：重新触碰刷新顺序，超上限逐出最久未用的', () => {
    // 注册表模块级共享，用独立 key 前缀避免和别的用例互踩
    const keys = ['lru-1', 'lru-2', 'lru-3', 'lru-4', 'lru-5', 'lru-6', 'lru-7'];
    keys.forEach((k, i) => rememberPaintBuffer(k, fakeCanvas(String(i))));
    // 上限 6：lru-1 被逐出
    expect(getPaintBuffer('lru-1')).toBeUndefined();
    expect(getPaintBuffer('lru-7')).toBeDefined();
    // 触碰 lru-2 再塞一个新 key：这次逐出的是 lru-3（最久未用）
    rememberPaintBuffer('lru-2', getPaintBuffer('lru-2')!);
    rememberPaintBuffer('lru-8', fakeCanvas('8'));
    expect(getPaintBuffer('lru-2')).toBeDefined();
    expect(getPaintBuffer('lru-3')).toBeUndefined();
    // 清理，别污染其它用例
    ['lru-2', 'lru-4', 'lru-5', 'lru-6', 'lru-7', 'lru-8'].forEach(forgetPaintBuffer);
  });
});
