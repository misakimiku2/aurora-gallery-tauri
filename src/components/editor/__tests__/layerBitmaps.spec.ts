/**
 * 位图仓（layerBitmaps）的纯逻辑面单测：版本/订阅/脏标记/烘焙回填/逐出策略。
 * canvas 绘制本体（getImageData/putImageData/drawImage）jsdom 不可测，
 * 与画笔引擎同口径走手测；这里只钉死**状态机的口径**——脏位图永不逐出、
 * clean 位图超上限逐出、displaySourceOf 的回退次序。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  attachClonedBitmap,
  beginStrokePause,
  bitmapMeta,
  bitmapVersion,
  dirtyBitmapKeys,
  displaySourceOf,
  endStrokePause,
  ensurePaintName,
  layerKey,
  maskKey,
  markBaked,
  onStrokesSettled,
  readBitmap,
  registerBlankBitmap,
  settledBitmapVersion,
  strokeActive,
  subscribeBitmaps,
} from '../layerBitmaps';

// 只测 layerBitmaps 的状态机，不 import brushBake（那边模块加载就订阅位图仓排空闲烘焙）
const blank = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

const K1 = layerKey('layer-1');
const K2 = layerKey('layer-2');
const M1 = maskKey('layer-1');

describe('键', () => {
  it('图层键 = layerId；蒙版键带 ::mask 后缀，两者不冲突', () => {
    expect(K1).toBe('layer-1');
    expect(M1).toBe('layer-1::mask');
    expect(K1).not.toBe(M1);
  });
});

describe('注册与版本', () => {
  it('空白注册：可读、置脏、通知订阅者', () => {
    const listener = vi.fn();
    const off = subscribeBitmaps(listener);
    registerBlankBitmap(K1, blank(4, 4), 'p1.png');
    expect(readBitmap(K1)).toBeDefined();
    expect(dirtyBitmapKeys()).toContain(K1);
    expect(bitmapVersion(K1)).toBe(0); // 注册不改像素，版本从 0 起
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('克隆：jsdom 无 2D 上下文 → 优雅返回 false（不抛错）；真机路径走手测', () => {
    registerBlankBitmap(K1, blank(4, 4), 'p1.png');
    const ok = attachClonedBitmap(K1, K2, 'p2.png');
    expect(typeof ok).toBe('boolean');
    if (ok) {
      // 装了 canvas polyfill 的环境：目标键拿到自己的位图与脏标记
      expect(bitmapMeta(K2)?.paintName).toBe('p2.png');
      expect(dirtyBitmapKeys()).toContain(K2);
      expect(readBitmap(K2)!.width).toBe(4);
    } else {
      expect(readBitmap(K2)).toBeUndefined();
    }
  });
});

describe('烘焙回填与显示源', () => {
  it('markBaked 清脏、记路径；displaySourceOf 优先烘焙文件', () => {
    registerBlankBitmap(K1, blank(4, 4), 'p1.png');
    expect(displaySourceOf(K1, 'orig.png')).toBe('orig.png'); // 没烤过 = 文档源
    markBaked(K1, 'C:/cache/p1.png');
    expect(displaySourceOf(K1, 'orig.png')).toBe('C:/cache/p1.png');
    expect(dirtyBitmapKeys()).not.toContain(K1);
  });

  it('displaySourceOf 对没见过的键直接回退文档源（没画过的层）', () => {
    expect(displaySourceOf('unknown', 'a.jpg')).toBe('a.jpg');
  });

  it('ensurePaintName：一次分配终身稳定', () => {
    registerBlankBitmap(K2, blank(2, 2), undefined as unknown as string);
    const a = ensurePaintName(K2, () => 'first.png');
    const b = ensurePaintName(K2, () => 'second.png');
    expect(a).toBe('first.png');
    expect(b).toBe('first.png');
  });
});

describe('逐出（clean-only）', () => {
  it('脏位图永不逐出；clean 超上限后只剩上限块常驻', () => {
    // 11 块脏的空白位图（上限 10）：一块都不能丢——丢 = 丢笔迹
    for (let i = 0; i < 11; i += 1) {
      registerBlankBitmap(layerKey(`dirty-${i}`), blank(2, 2), `d${i}.png`);
    }
    let resident = 0;
    for (let i = 0; i < 11; i += 1) {
      if (readBitmap(layerKey(`dirty-${i}`))) resident += 1;
    }
    expect(resident).toBe(11);

    // 全部烤 clean 之后再塞 1 块：最久未动的 clean 被逐出，常驻回到上限
    for (let i = 0; i < 11; i += 1) {
      markBaked(layerKey(`dirty-${i}`), `C:/cache/d${i}.png`);
    }
    registerBlankBitmap(layerKey('late'), blank(2, 2), 'late.png');
    let resident2 = 0;
    for (let i = 0; i < 11; i += 1) {
      if (readBitmap(layerKey(`dirty-${i}`))) resident2 += 1;
    }
    expect(resident2 + (readBitmap(layerKey('late')) ? 1 : 0)).toBeLessThanOrEqual(11); // 上限 10 + 脏的 late
    // 元数据在逐出后仍在（撤销补丁晚到时还要知道读哪、读多大）
    const meta = bitmapMeta(layerKey('dirty-0'));
    expect(meta).toBeDefined();
    expect(meta?.bakedPath).toContain('d0.png');
  });
});

describe('笔划暂停（空闲烘焙让路）', () => {
  it('begin/end 成对：深度归零才通知 onStrokesSettled，多退不进负数', () => {
    const settled = vi.fn();
    const off = onStrokesSettled(settled);
    beginStrokePause();
    beginStrokePause();
    expect(strokeActive()).toBe(true);
    endStrokePause();
    expect(strokeActive()).toBe(true); // 还有一笔在画
    expect(settled).not.toHaveBeenCalled();
    endStrokePause();
    expect(strokeActive()).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    endStrokePause(); // 不配对的 end：夹在 0，不许进负数
    expect(strokeActive()).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('settled 版本（行缩略图的防抖镜像）', () => {
  it('静止时与即时版本一致；注册不改像素不推版本', () => {
    vi.useFakeTimers();
    registerBlankBitmap(K1, blank(4, 4), 'p1.png');
    expect(settledBitmapVersion(K1)).toBe(bitmapVersion(K1)); // 从未变更 → 直读
    vi.advanceTimersByTime(300); // settle 泵跑了也不炸、不自我循环
    expect(settledBitmapVersion(K1)).toBe(bitmapVersion(K1));
    vi.useRealTimers();
  });
});
