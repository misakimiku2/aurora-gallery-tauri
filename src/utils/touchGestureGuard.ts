// 多指手势守护：当第二根手指落下时，立即取消所有"单指长按"类定时器
// （长按选择、右键菜单、范围选择），避免双指捏合时误触长按选择文件。
// usePinchZoom 检测到 2 触点时广播 signalMultiTouchCancel()，
// 各卡片组件把 clearAllTimers 通过 onMultiTouch() 注册进来即可。

type CancelHook = () => void;

const cancelHooks = new Set<CancelHook>();

export function onMultiTouch(cancel: CancelHook): () => void {
  cancelHooks.add(cancel);
  return () => {
    cancelHooks.delete(cancel);
  };
}

export function signalMultiTouchCancel() {
  cancelHooks.forEach(hook => {
    try {
      hook();
    } catch {
      // 单个 hook 异常不影响其他 hook
    }
  });
}