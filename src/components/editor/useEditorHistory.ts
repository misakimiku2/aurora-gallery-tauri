/**
 * 编辑器的撤销 / 重做（历史栈）。
 *
 * **混合栈**（2026-10-26 画笔架构轮）：`doc` 条目 = 参数快照（canvas + layers 的
 * 引用——一个 3440×1440 的文档存十次像素快照就是几百 MB，老口径不变）；`paint`
 * 条目 = 画笔一笔的脏矩形补丁（见 `historyStack.ts`）。文档变更统一在[入栈 effect]
 * 里收口（签名判变 + 调色合并），画笔补丁由 `useEditorBrush` 抬笔时直接 `pushPaintOp`。
 *
 * 撤销一条 `paint` = 把 before 像素写回位图仓（版本 +1，画面即时重画，**零文件
 * 依赖**——旧架构在这里换回一个可能还没落盘的文件路径，就是"撤销整图消失"的元凶）。
 *
 * 搬出 ImageEditor（2026-10-24 防膨胀批次 D，见进度文档 §7）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorDocument } from '../../types';
import { documentGeometrySignature, documentStateSignature } from './layerModel';
import {
  applyBitmapPatch,
  ensureBitmapResident,
  bitmapMeta,
} from './layerBitmaps';
import {
  canRedo as stackCanRedo,
  canUndo as stackCanUndo,
  docSnapshotBelow,
  entryToRedo,
  entryToUndo,
  initialHistoryState,
  pushDocEntry,
  pushPaintEntry,
  stepped,
  type HistoryState,
  type PaintPatch,
} from './historyStack';

export type { PaintPatch } from './historyStack';

/** 撤销栈里一帧文档快照的形状（paint 条目见 `historyStack.HistoryEntry`）。 */
export interface DocSnapshot {
  canvas?: EditorDocument['canvas'];
  layers?: EditorDocument['layers'];
}

export function useEditorHistory(
  doc: EditorDocument | undefined,
  onDocumentChange: (next: EditorDocument) => void,
) {
  const canvas = doc?.canvas;
  const [history, setHistory] = useState<HistoryState>({ stack: [], index: -1, lastDocAt: 0 });
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
    setHistory(initialHistoryState({ canvas: doc.canvas, layers: doc.layers }));
  }, [docIdentity, doc]);

  // 所有**文档**变更最终都落到 doc 上，统一在这里入栈（像素补丁走 pushPaintOp）。
  useEffect(() => {
    if (!doc) return;
    const sig = documentStateSignature(doc);
    const prevSig = lastSignatureRef.current;
    // 撤销/重做自己造成的变化先判（在 sig 比较之前消费 flag）：恢复出"签名恰好没变"
    // 的快照时也要清掉 flag，否则它会吞掉下一次真实改动（审计 P2#7）。
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false;
      lastSignatureRef.current = sig;
      return;
    }
    lastSignatureRef.current = sig;
    if (prevSig === null) return; // 第一次由上面的 docIdentity 分支建栈
    if (sig === prevSig) return; // 只动了 dirty/选区这类不进签名的字段

    // 只有调色在动 = 用户正拖着滑杆 → 合并进栈顶，否则 Ctrl+Z 要按几百下
    const snap: DocSnapshot = { canvas: doc.canvas, layers: doc.layers };
    setHistory(h => {
      const at = h.stack[h.index];
      const geometryUnchanged =
        !!at &&
        at.kind === 'doc' &&
        documentGeometrySignature({ ...doc, ...at } as EditorDocument) ===
          documentGeometrySignature(doc);
      const merge = geometryUnchanged && Date.now() - h.lastDocAt < 700;
      return pushDocEntry(h, snap, merge);
    });
  }, [doc]);

  const canUndo = stackCanUndo(history);
  const canRedo = stackCanRedo(history);

  /** 画笔抬笔时进栈的一笔（一笔 = 一步撤销，PS 口径）。 */
  const pushPaintOp = useCallback((patch: PaintPatch) => {
    setHistory(h => pushPaintEntry(h, patch));
  }, []);

  /** 把补丁像素写回位图仓。位图可能已被逐出（clean 才逐得出）——先物化再写。 */
  const applyPatch = useCallback(async (patch: PaintPatch, mode: 'before' | 'after') => {
    const meta = bitmapMeta(patch.key);
    const fallback = meta
      ? { sourcePath: meta.bakedPath ?? meta.sourcePath ?? '', width: meta.width, height: meta.height }
      : null;
    if (!fallback || !fallback.sourcePath) return; // 键整个没见过：防御性丢弃
    const canvas = await ensureBitmapResident(patch.key, fallback);
    if (!canvas) return;
    applyBitmapPatch(patch.key, mode === 'before' ? patch.before : patch.after, patch.x, patch.y);
  }, []);

  const undo = useCallback(() => {
    if (!stackCanUndo(history)) return;
    const entry = entryToUndo(history);
    if (!entry) return;
    if (entry.kind === 'paint') {
      void applyPatch(entry.patch, 'before');
      setHistory(h => stepped(h, -1));
      // 像素变了但签名没变：只置 dirty（effect 里 flag 优先消费，不会误进栈）
      if (doc) onDocumentChange({ ...doc, dirty: true });
      return;
    }
    // doc 快照存"变更后"状态：撤销要恢复**下方最近的 doc 快照**，中间的 paint
    // 条目保持生效（它们的笔迹已在当前像素里，doc 撤销只管参数）——审计 P0#2。
    const snap = docSnapshotBelow(history);
    if (!snap) return;
    applyingHistoryRef.current = true;
    setHistory(h => stepped(h, -1));
    if (doc) onDocumentChange({ ...doc, canvas: snap.canvas, layers: snap.layers, dirty: true });
  }, [history, doc, onDocumentChange, applyPatch]);

  const redo = useCallback(() => {
    if (!stackCanRedo(history)) return;
    const entry = entryToRedo(history);
    if (!entry) return;
    if (entry.kind === 'paint') {
      void applyPatch(entry.patch, 'after');
      setHistory(h => stepped(h, 1));
      if (doc) onDocumentChange({ ...doc, dirty: true });
      return;
    }
    // 重做 doc 条目 = 恢复它自己的快照（那就是变更后的目标状态）
    applyingHistoryRef.current = true;
    setHistory(h => stepped(h, 1));
    if (doc) onDocumentChange({ ...doc, canvas: entry.canvas, layers: entry.layers, dirty: true });
  }, [history, doc, onDocumentChange, applyPatch]);

  return { docIdentity, canUndo, canRedo, undo, redo, pushPaintOp };
}
