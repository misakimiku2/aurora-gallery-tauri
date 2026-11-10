/**
 * PickerCard 取色卡壳单测:标题栏拖动跟随指针+位置钳视口、storageKey 持久化
 * (门控隐藏=卸载,重挂回拖后位置而非默认居中——2026-11-11 用户反馈的回归钉)。
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PickerCard } from '../panels/PickerCard';

const KEY = 'aurora-test-text-color-card';

const findCard = (): HTMLElement => {
  const cards = document.body.querySelectorAll<HTMLDivElement>('div.w-56.fixed');
  return cards[cards.length - 1];
};

/** jsdom 无 PointerEvent(fireEvent.pointerDown 的 button/clientX 不落地),用 MouseEvent
 *  派发 pointer 序列——React 按类型分发,原生处理器照常读到坐标。 */
const firePointer = (el: Window | Element, type: string, x: number, y: number) => {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
};

describe('PickerCard 拖动与位置持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('标题栏拖动跟随指针并写入 localStorage', () => {
    render(
      <PickerCard title="文字颜色" storageKey={KEY} onClose={() => undefined}>
        <div>picker</div>
      </PickerCard>,
    );
    const card = findCard();
    expect(card).toBeTruthy();
    const title = screen.getByText('文字颜色');
    firePointer(title, 'pointerdown', 100, 100);
    firePointer(window, 'pointermove', 200, 150);
    firePointer(window, 'pointerup', 200, 150);
    // jsdom 矩形全 0:位移=指针差(200-100,150-100),钳位下限 4 不影响正值
    expect(card.style.left).toBe('100px');
    expect(card.style.top).toBe('50px');
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { left: number; top: number } | null;
    expect(saved).toEqual({ left: 100, top: 50 });
  });

  it('重挂(门控隐藏后复显)回拖后位置而非默认居中', () => {
    localStorage.setItem(KEY, JSON.stringify({ left: 100, top: 50 }));
    const first = render(
      <PickerCard title="文字颜色" storageKey={KEY} onClose={() => undefined}>
        <div>picker</div>
      </PickerCard>,
    );
    first.unmount();
    const second = render(
      <PickerCard title="文字颜色" storageKey={KEY} onClose={() => undefined}>
        <div>picker</div>
      </PickerCard>,
    );
    const card = findCard();
    expect(card).toBeTruthy();
    expect(card.style.left).toBe('100px');
    expect(card.style.top).toBe('50px');
    second.unmount();
  });

  it('无 storageKey:重挂回默认居中(不持久化)', () => {
    const first = render(
      <PickerCard title="卡" onClose={() => undefined}>
        <div />
      </PickerCard>,
    );
    const card = findCard();
    const centered = card.style.left;
    firePointer(screen.getByText('卡'), 'pointerdown', 0, 0);
    firePointer(window, 'pointermove', 300, 300);
    firePointer(window, 'pointerup', 300, 300);
    expect(card.style.left).not.toBe(centered);
    first.unmount();
    const second = render(
      <PickerCard title="卡" onClose={() => undefined}>
        <div />
      </PickerCard>,
    );
    expect(findCard().style.left).toBe(centered);
    second.unmount();
  });
});
