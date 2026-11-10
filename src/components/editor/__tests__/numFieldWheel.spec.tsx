/**
 * NumField 悬停滚轮调值单测(2026-11-11 用户反馈):一格=±1、Shift=±10、停手 300ms
 * 提交一次、钳 min/max;触摸板小增量累积不跳步;外部值变化回灌显示。
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { NumField } from '../panels/TypePanel';

const renderField = (props: Partial<{ value: number; min: number; max: number; onCommit: (v: number) => void }> = {}) => {
  const onCommit = props.onCommit ?? vi.fn();
  const utils = render(
    <NumField label="T" tip="字号" value={props.value ?? 12} min={props.min ?? 0.1} max={props.max ?? 1296} onCommit={onCommit} />,
  );
  const input = utils.container.querySelector('input') as HTMLInputElement;
  return { input, onCommit };
};

describe('NumField 悬停滚轮调值', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('滚轮向下一格=减 1,停手 300ms 提交', () => {
    const { input, onCommit } = renderField();
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input.value).toBe('11');
    expect(onCommit).not.toHaveBeenCalled(); // 停手前不提交
    act(() => { vi.advanceTimersByTime(300); });
    expect(onCommit).toHaveBeenCalledWith(11);
  });

  it('滚轮向上一格=加 1;Shift=加 10', () => {
    const { input, onCommit } = renderField();
    fireEvent.wheel(input, { deltaY: -100 });
    expect(input.value).toBe('13');
    fireEvent.wheel(input, { deltaY: -100, shiftKey: true });
    expect(input.value).toBe('23');
    act(() => { vi.advanceTimersByTime(300); });
    expect(onCommit).toHaveBeenCalledTimes(1); // 连滚只提交一次(停手值)
    expect(onCommit).toHaveBeenCalledWith(23);
  });

  it('触摸板小增量累积过一格才步进', () => {
    const { input, onCommit } = renderField();
    for (let i = 0; i < 9; i++) fireEvent.wheel(input, { deltaY: 10 });
    expect(input.value).toBe('12'); // 90px 不足一格
    fireEvent.wheel(input, { deltaY: 10 });
    expect(input.value).toBe('11'); // 累积 100px=一格
    act(() => { vi.advanceTimersByTime(300); });
    expect(onCommit).toHaveBeenCalledWith(11);
  });

  it('钳在 min/max', () => {
    const { input, onCommit } = renderField({ min: 1, max: 20 });
    fireEvent.wheel(input, { deltaY: -5000 });
    expect(input.value).toBe('20');
    act(() => { vi.advanceTimersByTime(300); });
    expect(onCommit).toHaveBeenCalledWith(20);
    fireEvent.wheel(input, { deltaY: 5000 });
    expect(input.value).toBe('1');
    act(() => { vi.advanceTimersByTime(300); });
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it('外部值变化回灌显示', () => {
    const utils = render(
      <NumField label="T" tip="字号" value={12} min={0.1} max={1296} onCommit={() => undefined} />,
    );
    const input = utils.container.querySelector('input') as HTMLInputElement;
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input.value).toBe('11');
    utils.rerender(<NumField label="T" tip="字号" value={40} min={0.1} max={1296} onCommit={() => undefined} />);
    expect(input.value).toBe('40');
  });
});
