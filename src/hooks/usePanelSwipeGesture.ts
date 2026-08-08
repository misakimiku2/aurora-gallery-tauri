import { useEffect, useRef } from 'react';

/**
 * 安卓端主界面左右面板滑动手势。
 *
 * - 无面板打开时：在屏幕任意位置（避开系统返回手势最边缘 24px）水平滑动即可跟手展开
 *   左侧边栏（向右滑）/ 右侧元数据面板（向左滑）。
 * - 面板已打开时：在内容区任意位置朝面板收起方向水平滑动可跟手收起该面板。
 * - 拖拽期间通过直接操作 DOM（设置 width / transform，关闭 transition）实现跟手；
 *   松手后恢复 transition，交由 React 状态切换驱动收尾动画，避免每帧 setState 造成网格重排。
 *
 * 与安卓系统全屏返回手势的区分：系统返回手势作用于屏幕最边缘（约 24dp），
 * 本 hook 仅在距边缘 24px 以内的起始位置放弃触发，交给系统处理；系统手势介入会触发 touchcancel 自动回退。
 * 水平手势判定（|dx| > 1.2·|dy| 且位移 >= 10px）确保竖向滚动、双指缩放等不被误判为面板手势。
 */

export interface PanelSwipeRefs {
  rowRef: React.RefObject<HTMLDivElement | null>;
  sidebarOuterRef: React.RefObject<HTMLDivElement | null>;
  sidebarInnerRef: React.RefObject<HTMLDivElement | null>;
  metadataOuterRef: React.RefObject<HTMLDivElement | null>;
  metadataInnerRef: React.RefObject<HTMLDivElement | null>;
  colorPickerOuterRef?: React.RefObject<HTMLDivElement | null>;
  colorPickerInnerRef?: React.RefObject<HTMLDivElement | null>;
}

export interface PanelSwipeOptions extends PanelSwipeRefs {
  enabled: boolean;
  isSidebarVisible: boolean;
  isMetadataVisible: boolean;
  isColorPickerVisible: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  openMetadata: () => void;
  closeRightPanel: () => void;
}

// 距屏幕边缘的内缩量（px），用于避开安卓系统返回手势区域（约 24dp）。
const EDGE_INSET = 24;
// 判定手势意图前的最小位移（px）。
const LOCK_DISTANCE = 10;
// 水平判定比例：|dx| > H_RATIO * |dy| 才视为水平手势。
const H_RATIO = 1.2;
// 松手时进度超过该比例即提交。
const COMMIT_RATIO = 0.5;
// 快速滑动速度阈值（px/ms），达到即在滑动方向提交。
const FLICK_VELOCITY = 0.4;

const OUTER_TRANS = 'width 300ms ease-out';
const INNER_TRANS = 'transform 300ms ease-out';

type Side = 'left' | 'right';
type Mode = 'open' | 'close';

interface DragState {
  side: Side;
  mode: Mode;
  panelWidth: number;
}

export function usePanelSwipeGesture(opts: PanelSwipeOptions) {
  const {
    rowRef,
    sidebarOuterRef,
    sidebarInnerRef,
    metadataOuterRef,
    metadataInnerRef,
    colorPickerOuterRef,
    colorPickerInnerRef,
  } = opts;

  // 用 ref 保存最新状态/回调，保证触摸事件闭包内始终读取最新值。
  const stateRef = useRef(opts);
  stateRef.current = opts;

  const dragRef = useRef<DragState | null>(null);
  const startRef = useRef({ x: 0, y: 0, t: 0 });
  const lastRef = useRef({ x: 0, t: 0 });

  // 取当前打开的右侧面板（metadata 或 colorPicker）的 DOM。
  const rightPanelDom = () => {
    const s = stateRef.current;
    if (s.isColorPickerVisible && colorPickerOuterRef?.current && colorPickerInnerRef?.current) {
      return { outer: colorPickerOuterRef.current, inner: colorPickerInnerRef.current };
    }
    if (s.isMetadataVisible && metadataOuterRef.current && metadataInnerRef.current) {
      return { outer: metadataOuterRef.current, inner: metadataInnerRef.current };
    }
    return null;
  };

  // 取当前拖拽目标对应的 DOM。
  const dragDom = (d: DragState): { outer: HTMLDivElement; inner: HTMLDivElement } | null => {
    let outer: HTMLDivElement | null = null;
    let inner: HTMLDivElement | null = null;
    if (d.side === 'left') {
      outer = sidebarOuterRef.current;
      inner = sidebarInnerRef.current;
    } else if (d.mode === 'open') {
      // open 模式固定展开 metadata；close 模式取当前打开的右侧面板。
      outer = metadataOuterRef.current;
      inner = metadataInnerRef.current;
    } else {
      const rp = rightPanelDom();
      if (!rp) return null;
      outer = rp.outer;
      inner = rp.inner;
    }
    if (!outer || !inner) return null;
    return { outer, inner };
  };

  const applyProgress = (d: DragState, progress: number) => {
    const dom = dragDom(d);
    if (!dom) return;
    const p = Math.max(0, Math.min(d.panelWidth, progress));
    dom.outer.style.width = `${p}px`;
    if (d.side === 'left') {
      dom.inner.style.transform = `translateX(${p - d.panelWidth}px)`;
    } else {
      dom.inner.style.transform = `translateX(${d.panelWidth - p}px)`;
    }
  };

  const beginDrag = (d: DragState) => {
    const dom = dragDom(d);
    if (!dom) return;
    dragRef.current = d;
    dom.outer.style.transition = 'none';
    dom.inner.style.transition = 'none';
  };

  // 计算当前进度（可见宽度）。
  const currentProgress = (d: DragState, dx: number) => {
    if (d.mode === 'open') {
      return d.side === 'left' ? dx : -dx;
    }
    return d.side === 'left' ? d.panelWidth + dx : d.panelWidth - dx;
  };

  const finishDrag = (commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const dom = dragDom(d);
    if (!dom) return;
    const pw = d.panelWidth;

    if (commit) {
      // 提交：恢复 transition，由 React 状态切换驱动 width/transform 到目标值并触发动画。
      dom.outer.style.transition = OUTER_TRANS;
      dom.inner.style.transition = INNER_TRANS;
      const cb = stateRef.current;
      if (d.side === 'left') {
        if (d.mode === 'open') cb.openSidebar(); else cb.closeSidebar();
      } else {
        if (d.mode === 'open') cb.openMetadata(); else cb.closeRightPanel();
      }
    } else {
      // 回退：状态不变，命令式动画回当前状态对应位置。
      dom.outer.style.transition = OUTER_TRANS;
      dom.inner.style.transition = INNER_TRANS;
      const targetProgress = d.mode === 'open' ? 0 : pw;
      applyProgress(d, targetProgress);
    }
  };

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const onTouchStart = (e: TouchEvent) => {
      if (!stateRef.current.enabled) return;
      if (e.touches.length !== 1) return;
      if (dragRef.current) return;
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      lastRef.current = { x: t.clientX, t: Date.now() };
    };

    const onTouchMove = (e: TouchEvent) => {
      const s = stateRef.current;
      if (!s.enabled) {
        if (dragRef.current) finishDrag(false);
        return;
      }
      if (e.touches.length !== 1) {
        if (dragRef.current) finishDrag(false);
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - startRef.current.x;
      const dy = t.clientY - startRef.current.y;

      if (!dragRef.current) {
        if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return;
        if (Math.abs(dx) <= H_RATIO * Math.abs(dy)) return; // 非水平手势，交给滚动等处理

        const W = window.innerWidth;
        const sx = startRef.current.x;

        let started = false;
        if (s.isSidebarVisible && dx < 0) {
          const inner = sidebarInnerRef.current;
          if (inner) { beginDrag({ side: 'left', mode: 'close', panelWidth: inner.offsetWidth }); started = true; }
        } else if ((s.isMetadataVisible || s.isColorPickerVisible) && dx > 0) {
          const rp = rightPanelDom();
          if (rp) { beginDrag({ side: 'right', mode: 'close', panelWidth: rp.inner.offsetWidth }); started = true; }
        } else if (!s.isSidebarVisible && !s.isMetadataVisible && !s.isColorPickerVisible) {
          // 面板均未展开时，任意位置水平滑动即可展开对应方向面板
          // （向右滑展开左侧边栏，向左滑展开右侧面板）；仅避开系统返回手势最边缘 24px。
          if (sx > EDGE_INSET && sx < W - EDGE_INSET) {
            if (dx > 0) {
              const inner = sidebarInnerRef.current;
              if (inner) { beginDrag({ side: 'left', mode: 'open', panelWidth: inner.offsetWidth }); started = true; }
            } else if (dx < 0) {
              const inner = metadataInnerRef.current;
              if (inner) { beginDrag({ side: 'right', mode: 'open', panelWidth: inner.offsetWidth }); started = true; }
            }
          }
        }
        if (!started) return;
      }

      if (dragRef.current) {
        e.preventDefault();
        const d = dragRef.current;
        applyProgress(d, currentProgress(d, dx));
        lastRef.current = { x: t.clientX, t: Date.now() };
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startRef.current.x;
      const dt = Math.max(1, Date.now() - lastRef.current.t);
      const velocity = (t.clientX - lastRef.current.x) / dt; // 带符号 px/ms
      const progress = currentProgress(d, dx);
      const ratio = progress / d.panelWidth;

      let commit: boolean;
      if (d.mode === 'open') {
        const flickForward = d.side === 'left' ? velocity > FLICK_VELOCITY : velocity < -FLICK_VELOCITY;
        commit = ratio > COMMIT_RATIO || flickForward;
      } else {
        const flickForward = d.side === 'left' ? velocity < -FLICK_VELOCITY : velocity > FLICK_VELOCITY;
        commit = ratio < 1 - COMMIT_RATIO || flickForward;
      }
      finishDrag(commit);
    };

    const onTouchCancel = () => {
      if (dragRef.current) finishDrag(false);
    };

    row.addEventListener('touchstart', onTouchStart, { passive: true });
    row.addEventListener('touchmove', onTouchMove, { passive: false });
    row.addEventListener('touchend', onTouchEnd, { passive: false });
    row.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      row.removeEventListener('touchstart', onTouchStart);
      row.removeEventListener('touchmove', onTouchMove);
      row.removeEventListener('touchend', onTouchEnd);
      row.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [
    rowRef,
    sidebarOuterRef,
    sidebarInnerRef,
    metadataOuterRef,
    metadataInnerRef,
    colorPickerOuterRef,
    colorPickerInnerRef,
  ]);
}
