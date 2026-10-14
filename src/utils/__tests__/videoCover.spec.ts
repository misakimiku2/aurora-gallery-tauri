import { describe, it, expect, vi } from 'vitest';

// videoCover.ts 顶层 import 了 tauri 的 convertFileSrc；jsdom 里不需要真实实现
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

import { seekCandidates, frameScore } from '../videoCover';
import { averageColorfulness } from '../dominantColors';

describe('seekCandidates（抽帧候选时间点）', () => {
  it('不从 t=0 起步（避开片头黑帧，设计方案 §11.2）', () => {
    const c = seekCandidates(13);
    expect(c[0]).toBeGreaterThan(0);
    expect(c[0]).toBeCloseTo(1.3, 5);
  });

  it('时间点严格递增，且都落在 (0, duration) 内', () => {
    const duration = 20;
    const c = seekCandidates(duration);
    expect(c.length).toBeGreaterThan(1);
    for (const t of c) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(duration);
    }
    for (let i = 1; i < c.length; i++) {
      expect(c[i]).toBeGreaterThan(c[i - 1]);
    }
  });

  it('接近片尾的候选收敛到 safe end，绝不越界', () => {
    const c = seekCandidates(1);
    for (const t of c) {
      expect(t).toBeLessThanOrEqual(1 - 0.05 + 1e-9);
    }
  });

  it('极短视频按毫秒去重（多个比例落到同一帧）', () => {
    const c = seekCandidates(0.02);
    expect(c.length).toBeGreaterThan(0);
    expect(new Set(c.map((t) => Math.round(t * 1000))).size).toBe(c.length);
  });
});

describe('frameScore（候选帧打分）', () => {
  it('同样鲜艳度下，更亮者得分更高', () => {
    expect(frameScore(100, 20)).toBeGreaterThan(frameScore(50, 20));
  });

  it('同样亮度下，更鲜艳者得分更高', () => {
    expect(frameScore(80, 40)).toBeGreaterThan(frameScore(80, 10));
  });

  it('亮度贡献封顶，避免「纯白闪过帧」压过有内容的亮帧', () => {
    // 亮度均已封顶（160），鲜艳的那个应当胜出
    expect(frameScore(160, 50)).toBeGreaterThan(frameScore(240, 0));
  });

  it('暗帧得分明显低于亮帧（本模块要修的核心问题）', () => {
    // 片头暗帧 vs 片内亮帧（指挥官 2026-10-14 实测场景）
    expect(frameScore(40, 20)).toBeLessThan(frameScore(110, 40));
  });
});

describe('averageColorfulness（鲜艳度）', () => {
  it('灰色像素鲜艳度为 0', () => {
    const gray = new Uint8ClampedArray([128, 128, 128, 255, 100, 100, 100, 255]);
    expect(averageColorfulness(gray)).toBe(0);
  });

  it('纯红像素鲜艳度为 255', () => {
    const red = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(averageColorfulness(red)).toBe(255);
  });

  it('彩色高于灰色', () => {
    const gray = new Uint8ClampedArray([128, 128, 128, 255]);
    const color = new Uint8ClampedArray([200, 50, 50, 255]);
    expect(averageColorfulness(color)).toBeGreaterThan(averageColorfulness(gray));
  });
});
