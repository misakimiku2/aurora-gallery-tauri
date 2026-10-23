/**
 * 编辑器的撤销 / 重做（历史栈）。
 *
 * **只存参数不存像素**（`DocSnapshot` = canvas + layers 的引用快照）——一个
 * 3440×1440 的文档存十次像素快照就是几百 MB。所有变更（裁剪 / 旋转 / 翻转 /
 * 调色 / 图层操作）最终都落到 `doc` 上，所以统一在[入栈 effect]里收口，
 * 不用在每个 handler 里各记一次。
 *
 * 搬出 ImageEditor（2026-10-24 防膨胀批次 D，见进度文档 §7）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorCanvas, EditorDocument, EditorLayer } from '../../types';
import { documentGeometrySignature, documentStateSignature } from './layerModel';

/** 撤销栈里的一步：只存参数，不存像素。 */
export interface DocSnapshot {
  canvas?: EditorCanvas;
  layers?: EditorLayer[];
}

export function useEditorHistory(
  doc: EditorDocument | undefined,
  onDocumentChange: (next: EditorDocument) => void,
) {
  const canvas = doc?.canvas;
  const [history, setHistory] = useState<{ stack: DocSnapshot[]; index: number; lastAt: number }>({
    stack: [],
    index: -1,
    lastAt: 0,
  });
  const historyInitRef = useRef<string | null>(null);
  const applyingHistoryRef = useRef(false);
  const lastSignatureRef = useRef<string | null>(null);

  // 文档身份（是否已建画布）变化时以当前状态作为历史起点。
  //
  // **刻意不含 `doc.path`**：保存工程会把路径从 `photo.jpg` 换成 `photo.aurora`，
  // 若路径算进身份，"存一次"就等价于"换了一份文档"，撤销栈当场清空——用户刚存完
  // 想再撤销一步就发现没了。一个 Tab 恒等于一个文档（`openInEditor` / `openBlankDocument`
  // / `openProjectInEditor` 都是开新 Tab），所以"画布是否就绪"足以分段。
  const docIdentity = doc ? (canvas ? 'ready' : 'new') : null;

  useEffect(() => {
    if (!docIdentity || !doc) return;
    if (historyInitRef.current === docIdentity) return;
    historyInitRef.current = docIdentity;
    lastSignatureRef.current = documentStateSignature(doc);
    setHistory({ stack: [{ canvas: doc.canvas, layers: doc.layers }], index: 0, lastAt: 0 });
  }, [docIdentity, doc]);

  // 所有变更最终都落到文档上，所以统一在这里入栈。
  useEffect(() => {
    if (!doc) return;
    const sig = documentStateSignature(doc);
    const prevSig = lastSignatureRef.current;
    lastSignatureRef.current = sig;
    if (prevSig === null) return; // 第一次由上面的 docIdentity 分支建栈
    if (sig === prevSig) return;
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false; // 这次变化是撤销/重做自己造成的
      return;
    }

    // 只有调色在动 = 用户正拖着滑杆 → 合并进栈顶，否则 Ctrl+Z 要按几百下
    const snap: DocSnapshot = { canvas: doc.canvas, layers: doc.layers };
    setHistory(h => {
      const at = h.stack[h.index];
      const geometryUnchanged =
        !!at &&
        documentGeometrySignature({ ...doc, ...at } as EditorDocument) ===
          documentGeometrySignature(doc);
      const merge = geometryUnchanged && Date.now() - h.lastAt < 700;
      const head = h.stack.slice(0, merge ? h.index : h.index + 1);
      head.push(snap);
      return { stack: head, index: head.length - 1, lastAt: Date.now() };
    });
  }, [doc]);

  const canUndo = history.index > 0;
  const canRedo = history.index >= 0 && history.index < history.stack.length - 1;

  const applyHistoryAt = useCallback(
    (index: number) => {
      const snap = history.stack[index];
      if (!snap || !doc) return;
      applyingHistoryRef.current = true;
      setHistory(prev => ({ ...prev, index, lastAt: 0 }));
      onDocumentChange({ ...doc, canvas: snap.canvas, layers: snap.layers, dirty: true });
    },
    [history.stack, doc, onDocumentChange],
  );

  const undo = useCallback(() => {
    if (canUndo) applyHistoryAt(history.index - 1);
  }, [canUndo, history.index, applyHistoryAt]);
  const redo = useCallback(() => {
    if (canRedo) applyHistoryAt(history.index + 1);
  }, [canRedo, history.index, applyHistoryAt]);

  return { docIdentity, canUndo, canRedo, undo, redo };
}
