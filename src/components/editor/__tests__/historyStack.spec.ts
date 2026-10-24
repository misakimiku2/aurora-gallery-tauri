/**
 * 撤销栈纯函数面的单测（2026-10-26 架构轮）：doc 快照 + 像素补丁混合栈的
 * 压栈/游走/合并/上限。补丁里的 ImageData 只是引用（reducer 不读它的内容），
 * 用桩对象即可。
 */
import { describe, expect, it } from 'vitest';
import type { EditorCanvas, EditorLayer } from '../../../types';
import { createIdentityBox } from '../layerModel';
import {
  canRedo,
  canUndo,
  docSnapshotBelow,
  entryToRedo,
  entryToUndo,
  initialHistoryState,
  PAINT_ENTRY_LIMIT,
  pushDocEntry,
  pushPaintEntry,
  stepped,
  type PaintPatch,
} from '../historyStack';

const canvas: EditorCanvas = { width: 100, height: 80, background: 'transparent' };
const layersA: EditorLayer[] = [
  { id: 'L1', name: 'a', source: 'a.png', naturalWidth: 100, naturalHeight: 80, box: createIdentityBox(100, 80), visible: true },
];
const layersB = layersA.map(l => ({ ...l, box: { ...l.box, x: 10 } }));

const patch = (n: number): PaintPatch => ({
  key: `L${n}`,
  x: 0,
  y: 0,
  before: { width: 1, height: 1 } as unknown as ImageData,
  after: { width: 1, height: 1 } as unknown as ImageData,
});

describe('初始与游走', () => {
  it('建栈即可游走判断正确：无 undo 无 redo', () => {
    const s = initialHistoryState({ canvas, layers: layersA });
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
    expect(entryToUndo(s)).toBe(s.stack[0]); // 建栈快照本身
    expect(entryToRedo(s)).toBeUndefined();
  });

  it('doc 与 paint 混排：undo 逐条走，条目类型判得对', () => {
    let s = initialHistoryState({ canvas, layers: layersA });
    s = pushPaintEntry(s, patch(1)); // 画一笔
    s = pushDocEntry(s, { canvas, layers: layersB }, false); // 移动图层
    s = pushPaintEntry(s, patch(2)); // 再画一笔
    expect(s.stack).toHaveLength(4);
    expect(entryToUndo(s)?.kind).toBe('paint');
    s = stepped(s, -1);
    expect(entryToUndo(s)?.kind).toBe('doc');
    expect(canRedo(s)).toBe(true);
    s = stepped(s, -1);
    expect(entryToUndo(s)?.kind).toBe('paint');
    s = stepped(s, -1);
    expect(canUndo(s)).toBe(false); // 回到建栈态
  });

  it('undo 之后压新条目 → redo 尾巴被截断', () => {
    let s = initialHistoryState({ canvas, layers: layersA });
    s = pushPaintEntry(s, patch(1));
    s = pushPaintEntry(s, patch(2));
    s = stepped(s, -1); // 撤销一笔
    s = pushPaintEntry(s, patch(3)); // 画新的一笔
    expect(s.stack).toHaveLength(3); // patch2 没了
    expect(s.index).toBe(2);
    expect(canRedo(s)).toBe(false);
  });
});

describe('docSnapshotBelow（doc 撤销语义，审计 P0#2 的回归钉）', () => {
  it('纯 doc 栈：撤销 D2 恢复的是 D1（stack[index-1]），不是"当前状态"D2', () => {
    let s = initialHistoryState({ canvas, layers: layersA }); // S0
    s = pushDocEntry(s, { canvas, layers: layersB }, false); // D1（移动）
    const layersC = layersB.map(l => ({ ...l, box: { ...l.box, y: 5 } }));
    s = pushDocEntry(s, { canvas, layers: layersC }, false); // D2（再移动）
    // 第一次 Ctrl+Z：当前条目 D2 是 doc → 恢复它**下方最近的 doc 快照** D1
    const snap = docSnapshotBelow(s);
    expect(snap?.kind === 'doc' && snap.layers).toBe(layersB);
    s = stepped(s, -1);
    // 第二次 Ctrl+Z：恢复 S0（建栈态可撤销——off-by-one 的标志就是 S0 永远回不去）
    const snap0 = docSnapshotBelow(s);
    expect(snap0?.kind === 'doc' && snap0.layers).toBe(layersA);
    expect(stepped(s, -1).index).toBe(0);
    expect(canUndo(stepped(s, -1))).toBe(false);
  });

  it('混合栈：doc 撤销跳过中间的 paint 条目找最近的 doc 快照（笔迹不回退）', () => {
    let s = initialHistoryState({ canvas, layers: layersA }); // S0
    s = pushPaintEntry(s, patch(1)); // 画一笔（像素补丁，doc 不变）
    s = pushDocEntry(s, { canvas, layers: layersB }, false); // 移动图层
    const snap = docSnapshotBelow(s);
    // 撤销"移动"要恢复的是 S0 的**参数**（那时 paint1 之后的 doc 就是 layersA），
    // 不能把 paint1 也一起退掉，也不能恢复成 layersB（那是当前状态 = 无效撤销）
    expect(snap?.kind === 'doc' && snap.layers).toBe(layersA);
  });

  it('建栈态（index=0）之下没有 doc 快照，防御性返回 undefined', () => {
    const s = initialHistoryState({ canvas, layers: layersA });
    expect(docSnapshotBelow(s)).toBeUndefined();
  });
});

describe('doc 条目合并（调色滑杆口径）', () => {
  it('merge=true 替换栈顶而不是追加', () => {
    let s = initialHistoryState({ canvas, layers: layersA });
    s = pushDocEntry(s, { canvas, layers: layersA }, false);
    s = pushDocEntry(s, { canvas, layers: layersB }, true);
    expect(s.stack).toHaveLength(2); // 合并没有加长
    const top = s.stack[s.index];
    expect(top.kind === 'doc' && top.layers).toBe(layersB);
    expect(s.lastDocAt).toBeGreaterThan(0);
  });
});

describe('补丁条目上限（内存防线）', () => {
  it(`超过 ${PAINT_ENTRY_LIMIT} 个 paint 条目时从栈底丢最老，doc 条目不动`, () => {
    let s = initialHistoryState({ canvas, layers: layersA });
    s = pushDocEntry(s, { canvas, layers: layersB }, false); // doc 骨架在 paint 之间
    for (let i = 0; i < PAINT_ENTRY_LIMIT + 5; i += 1) {
      s = pushPaintEntry(s, patch(i));
    }
    const paints = s.stack.filter(e => e.kind === 'paint');
    expect(paints).toHaveLength(PAINT_ENTRY_LIMIT);
    expect(s.stack.some(e => e.kind === 'doc')).toBe(true); // doc 不被裁
    expect(s.index).toBe(s.stack.length - 1); // 栈顶仍是最新一笔
  });
});
