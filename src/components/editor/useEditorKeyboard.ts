/**
 * 编辑器的键盘面：快捷键、空格抓手、Alt、窗口失焦复位。
 *
 * **一个 window keydown 监听器收口所有按键**——不拆成多个监听器（顺序 /
 * stopPropagation 会复杂化）。空格与 Alt 的按下状态在这里管，视口（抓手平移、
 * 缩放工具的 Alt 反向）通过返回值消费。
 *
 * 快捷键要能读到最新的 handler，而键盘 effect 只依赖 `onToolChange`（重挂监听
 * 会让拖拽中的按键状态错乱），所以所有 handler 都在内部走 ref。
 *
 * 搬出 ImageEditor（2026-10-24 防膨胀批次 A，见进度文档 §7）。
 */
import { useEffect, useRef, useState } from 'react';
import type { EditorToolId } from '../../types';
import { isTextEditingTarget } from '../../utils/keyboardTarget';
import { EDITOR_SHORTCUT_KEYS } from './editorTools';

export interface EditorKeyActions {
  undo: () => void;
  redo: () => void;
  saveProject: (saveAs: boolean) => void | Promise<void>;
  openProject: () => void | Promise<void>;
  deleteActiveLayer: () => void;
  /** Ctrl+Alt+G：切换活动图层的剪贴蒙版（PS 键位） */
  toggleActiveClip: () => void;
  commitCrop: () => void;
  cancelCrop: () => void;
  cancelTransform: () => void;
}

export function useEditorKeyboard(opts: {
  isActive: boolean;
  tool: EditorToolId | null;
  /** 新建文档弹窗开着时，按键只归弹窗（Esc 它自己 capture 处理） */
  showNewDoc: boolean;
  /** 活动层锁了像素/位置（Ctrl+T 拒绝进入自由变换，PS：按了没反应） */
  transformLocked: boolean;
  onToolChange: (tool: EditorToolId | null) => void;
  actions: EditorKeyActions;
}) {
  const { onToolChange, actions } = opts;

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [altHeld, setAltHeld] = useState(false);

  // 下面这些值键盘 effect 只读"最新值"，全部 ref 化（effect 只依赖 onToolChange）
  const isActiveRef = useRef(opts.isActive);
  isActiveRef.current = opts.isActive;
  const toolRef = useRef(opts.tool);
  toolRef.current = opts.tool;
  const showNewDocRef = useRef(opts.showNewDoc);
  showNewDocRef.current = opts.showNewDoc;
  const transformLockedRef = useRef(opts.transformLocked);
  transformLockedRef.current = opts.transformLocked;

  const spaceHeldRef = useRef(false);
  const altHeldRef = useRef(false);

  const undoRef = useRef(actions.undo);
  undoRef.current = actions.undo;
  const redoRef = useRef(actions.redo);
  redoRef.current = actions.redo;
  const saveProjectRef = useRef(actions.saveProject);
  saveProjectRef.current = actions.saveProject;
  const openProjectRef = useRef(actions.openProject);
  openProjectRef.current = actions.openProject;
  const deleteLayerRef = useRef(actions.deleteActiveLayer);
  deleteLayerRef.current = actions.deleteActiveLayer;
  const toggleClipRef = useRef(actions.toggleActiveClip);
  toggleClipRef.current = actions.toggleActiveClip;
  const commitCropRef = useRef(actions.commitCrop);
  commitCropRef.current = actions.commitCrop;
  const cancelCropRef = useRef(actions.cancelCrop);
  cancelCropRef.current = actions.cancelCrop;
  const cancelTransformRef = useRef(actions.cancelTransform);
  cancelTransformRef.current = actions.cancelTransform;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      if (isTextEditingTarget(e.target)) return;
      // 新建文档弹窗开着时，按键只归弹窗（Esc 它自己 capture 处理）——
      // 不挡的话 V/C 这些快捷键会"穿透"弹窗改掉背后的工具（用户实测踩到）
      if (showNewDocRef.current) return;

      if (e.code === 'Space') {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        e.preventDefault();
        return;
      }
      if (e.key === 'Alt') {
        altHeldRef.current = true;
        setAltHeld(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoRef.current();
        else undoRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoRef.current();
        return;
      }
      // Ctrl+S / Ctrl+Shift+S / Ctrl+O：存工程与开工程（PS 的键位口径）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProjectRef.current(e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProjectRef.current();
        return;
      }
      // Ctrl+T：进入/退出自由变换（PS 行为）。活动层锁了像素/位置时**拒绝进入**
      // （PS：锁像素禁变换，菜单灰掉按了没反应——这里同样静默）。
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        if (transformLockedRef.current && toolRef.current !== 'transform') return;
        onToolChange(toolRef.current === 'transform' ? 'move' : 'transform');
        return;
      }
      // Ctrl+Alt+G：剪贴蒙版（PS 键位）。必须放在下面那条 `ctrl||meta||alt` 早退
      // **之前**——这个快捷键自己就带着 Alt。
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        toggleClipRef.current();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (toolRef.current === 'crop') {
        if (e.key === 'Enter') {
          commitCropRef.current();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          cancelCropRef.current();
          e.preventDefault();
          return;
        }
      }

      // 自由变换：Enter 提交 / Esc 取消（PS 行为）
      if (toolRef.current === 'transform') {
        if (e.key === 'Enter') {
          onToolChange('move');
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          cancelTransformRef.current();
          e.preventDefault();
          return;
        }
      }

      /**
       * Delete = 删除活动图层（PS 行为）。只认 `Delete`，不认 `Backspace`：
       * 后者在阅读/编辑时太容易误触，而 `isTextEditingTarget` 只能挡住输入框里的按键。
       *
       * 裁剪与自由变换状态下不抢这个键——那两个状态里没有"删图层"的语义，
       * 抢了反而会让人在调整构图时把图层删掉。
       */
      if (e.key === 'Delete' && toolRef.current !== 'crop' && toolRef.current !== 'transform') {
        e.preventDefault();
        deleteLayerRef.current();
        return;
      }

      const next = EDITOR_SHORTCUT_KEYS[e.key.toLowerCase()];
      if (next) {
        // 同一个工具的快捷键再按一次 = 取消选择（不选任何工具）
        onToolChange(toolRef.current === next ? null : next);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
      if (e.key === 'Alt') {
        altHeldRef.current = false;
        setAltHeld(false);
      }
    };
    // 窗口失焦时复位：否则「按住空格切走」会永久卡在抓手
    const onBlur = () => {
      spaceHeldRef.current = false;
      altHeldRef.current = false;
      setSpaceHeld(false);
      setAltHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onToolChange]);

  return { spaceHeld, altHeld, altHeldRef, toolRef };
}
