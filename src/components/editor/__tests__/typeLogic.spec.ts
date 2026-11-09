import { describe, expect, it } from 'vitest';
import {
  boxHandleAt, clickSelection, flowKey, imeRange, insideBox, layerNameFromText, makesBox,
  nextClickCount, paragraphOf, resizeBoxCalc, smartQuotes, splitParagraphs, wordBoundary,
  lineSelectionSpan, columnWidthVec, lineToText, affApply, affInvert, applyReplace, boxOfShape,
} from '../typeLogic';

describe('typeLogic(二期 二-6,上游 type_tool.rs 移植)', () => {
  it('wordBoundary:字母数字 run 两端;中文连成一词;越界钳制', () => {
    const t = 'hello, 大世界!';
    expect(wordBoundary(t, 2, true)).toBe(5); // hello 词尾
    expect(wordBoundary(t, 5, true)).toBe(10); // 跳过「, 」→ 大世界 词尾
    expect(wordBoundary(t, 7, true)).toBe(10);
    expect(wordBoundary(t, 7, false)).toBe(0); // 词首起再跳过「, 」→ hello 词首
    expect(wordBoundary(t, 5, false)).toBe(0);
    expect(wordBoundary(t, 0, false)).toBe(0);
    expect(wordBoundary('abc def', 9, true)).toBe(7); // 越界钳到末尾
  });

  it('splitParagraphs/paragraphOf:\\n 与 \\r\\n 断段、去结尾换行、末尾越界落最后段', () => {
    expect(splitParagraphs('ab\ncd')).toEqual([[0, 3], [3, 5]]);
    expect(splitParagraphs('ab\r\ncd')).toEqual([[0, 4], [4, 6]]);
    expect(splitParagraphs('ab\ncd\n')).toEqual([[0, 3], [3, 6]]);
    expect(splitParagraphs('')).toEqual([]);
    expect(paragraphOf('ab\ncd\n', 4)).toEqual([3, 5]); // cd
    expect(paragraphOf('ab\ncd\n', 5)).toEqual([3, 5]); // 末尾换行前
    expect(paragraphOf('ab\ncd\n', 99)).toEqual([3, 5]); // 越界落最后段
    expect(paragraphOf('one', 1)).toEqual([0, 3]);
    expect(paragraphOf('', 0)).toEqual([0, 0]);
  });

  it('nextClickCount:慢/移开=1;快击递增到 5 后循环;首击即双击取 detail', () => {
    expect(nextClickCount(0, 1)).toBe(1);
    expect(nextClickCount(0, 2)).toBe(2); // 双击(前面无单击记录)
    expect(nextClickCount(0, 3)).toBe(3); // 三击
    expect(nextClickCount(1, 2)).toBe(2);
    expect(nextClickCount(2, 1)).toBe(1); // 慢点击开新串
    expect(nextClickCount(4, 2)).toBe(5);
    expect(nextClickCount(5, 2)).toBe(1); // 五连击后从头
  });

  const text = 'one two\nthree four\n';
  const lines = [
    { start: 0, end: 7, baseline: 10, x0: 0, x1: 40, ascent: 8, descent: 2 },
    { start: 7, end: 19, baseline: 30, x0: 0, x1: 60, ascent: 8, descent: 2 },
  ];

  it('clickSelection:2=词 3=命中行 4=段落 5=全部;1 与缺省=caret;越界钳制', () => {
    expect(clickSelection(text, 2, null, null, 2)).toEqual([0, 3]); // one
    expect(clickSelection(text, 10, null, null, 2)).toEqual([8, 13]); // three
    expect(clickSelection('中文词组', 1, null, null, 2)).toEqual([0, 4]); // CJK 连成一词
    expect(clickSelection(text, 10, lines, 0, 3)).toEqual([0, 7]); // 命中行 0 优先
    expect(clickSelection(text, 2, lines, null, 3)).toEqual([0, 7]); // caret 所在行
    expect(clickSelection(text, 18, lines, null, 3)).toEqual([7, 19]); // 末尾落最后行
    expect(clickSelection(text, 10, null, null, 3)).toEqual([8, 18]); // 无行=段落(区间含结尾换行,去尾=10 字)
    expect(clickSelection(text, 10, null, null, 4)).toEqual([8, 18]);
    expect(clickSelection(text, 10, null, null, 5)).toEqual([0, 19]);
    expect(clickSelection(text, 10, null, null, 1)).toEqual([10, 10]);
    expect(clickSelection(text, 99, null, null, 5)).toEqual([0, 19]);
    expect(clickSelection(text, 99, null, null, 2)).toEqual([19, 19]); // 钳到末尾
  });

  it('smartQuotes:起始/空白/括号后=开引号,字母旁=闭引号;连续键入逐字推移', () => {
    expect(smartQuotes('"hi"', undefined)).toBe('\u{201c}hi\u{201d}');
    expect(smartQuotes('say "x"', undefined)).toBe('say \u{201c}x\u{201d}'); // prev 逐字符更新:空白后开、字母旁闭
    expect(smartQuotes('"done"', '(')).toBe('\u{201c}done\u{201d}'); // 括号后=开引号
    expect(smartQuotes('\'a\'', undefined)).toBe('\u{2018}a\u{2019}');
    expect(smartQuotes('x\'', 'y')).toBe('x\u{2019}');
    expect(smartQuotes('"', '-')).toBe('\u{201c}');
    expect(smartQuotes('"', '\u{2013}')).toBe('\u{201c}');
  });

  it('layerNameFromText:首个非空行、裁剪、40 字符截断、空=Type Layer', () => {
    expect(layerNameFromText('Hello\nworld')).toBe('Hello');
    expect(layerNameFromText('\n  \n标题\n后续')).toBe('标题');
    expect(layerNameFromText('  padded  ')).toBe('padded');
    expect(layerNameFromText('x'.repeat(50))).toBe('x'.repeat(40));
    expect(layerNameFromText('')).toBe('Type Layer');
    expect(layerNameFromText('\n\n')).toBe('Type Layer');
  });

  it('handleSides:8 把手边位;boxHandleAt 经仿射命中角/边/中点,脱靶 null', () => {
    const shape: [number, number, number, number] = [10, 10, 100, 50];
    const m = [1, 0, 0, 1, 0, 0]; // 恒等
    expect(boxHandleAt(shape, m, 10, 10, 6)).toBe(0); // 左上角
    expect(boxHandleAt(shape, m, 110, 60, 6)).toBe(2); // 右下角
    expect(boxHandleAt(shape, m, 60, 10, 6)).toBe(4); // 上中
    expect(boxHandleAt(shape, m, 110, 35, 6)).toBe(5); // 右中
    expect(boxHandleAt(shape, m, 10, 35, 6)).toBe(7); // 左中
    expect(boxHandleAt(shape, m, 50, 35, 6)).toBeNull(); // 框心不是把手
    const rot = [0, 1, -1, 0, 0, 0]; // 90° 旋转:文字 (x,y) → 文档 (-y, x)
    expect(boxHandleAt(shape, rot, -10, 10, 6)).toBe(0); // 左上角转后
  });

  it('resizeBoxCalc:把手边随动+MIN_BOX 钳制;⌥ 绕按下中心镜像', () => {
    const shape: [number, number, number, number] = [10, 10, 100, 50];
    // 右下角 (2) 拖到 (200, 120):右/下边跟随
    expect(resizeBoxCalc(2, shape, 200, 120, false)).toEqual([10, 10, 190, 110]);
    // 左上角 (0) 拖过右下角:x/y 各自钳到对边内侧 MIN_BOX=4(y 已越过底边)
    expect(resizeBoxCalc(0, shape, 108, 108, false)).toEqual([106, 56, 4, 4]);
    // 上中 (4) 只动上边(下边保持 60,高度=60−(−20)=80)
    expect(resizeBoxCalc(4, shape, 0, -20, false)).toEqual([10, -20, 100, 80]);
    // ⌥ 右下角:中心 (60,35) 固定,对边镜像(右/下随指针,左/上翻到 2c−边)
    expect(resizeBoxCalc(2, shape, 160, 85, true)).toEqual([-40, -15, 200, 100]);
    // ⌥ 收得比 MIN_BOX/2 更小:钳半框
    expect(resizeBoxCalc(2, shape, 61, 36, true)).toEqual([58, 33, 4, 4]);
  });

  it('insideBox/makesBox:框内判定;两向 ≥min 才算拖框', () => {
    expect(insideBox([10, 10, 100, 50], 60, 35)).toBe(true);
    expect(insideBox([10, 10, 100, 50], 5, 35)).toBe(false);
    expect(makesBox([0, 0], [10, 8], 4)).toBe(true);
    expect(makesBox([0, 0], [10, 2], 4)).toBe(false);
    expect(makesBox([0, 0], [2, 8], 4)).toBe(false);
  });

  it('imeRange:进行中组字原位替换;无效区间落选区;空组字防御', () => {
    // preedit (2,2) 有效:原位替换
    expect(imeRange([2, 2], 8, 8, 10, '你好')).toEqual([2, 4, 2]);
    // preedit 越过文长:落当前选区
    expect(imeRange([9, 3], 4, 6, 10, 'x')).toEqual([4, 6, 1]);
    // 无 preedit:选区
    expect(imeRange(null, 4, 6, 10, 'x')).toEqual([4, 6, 1]);
    // 空组字且无进行中=扰动,不动
    expect(imeRange(null, 4, 4, 10, '')).toBeNull();
    // preedit 有效+空组字=IME 取消:删除组字文本(replace [2,4) with '')
    expect(imeRange([2, 2], 4, 4, 10, '')).toEqual([2, 4, 0]);
    // 空文本层 caret 越界钳制
    expect(imeRange(null, 5, 5, 0, '字')).toEqual([0, 0, 1]);
  });

  it('flowKey:横排原样;竖排 ↑↓=列内前后、←→=换列', () => {
    expect(flowKey('ArrowUp', false)).toBe('ArrowUp');
    expect(flowKey('ArrowLeft', true)).toBe('ArrowDown');
    expect(flowKey('ArrowDown', true)).toBe('ArrowRight');
    expect(flowKey('ArrowUp', true)).toBe('ArrowLeft');
    expect(flowKey('ArrowRight', true)).toBe('ArrowUp');
  });

  it('lineSelectionSpan:相交区间+换行尾巴;不相交 null;columnWidthVec/lineToText/affine/boxOfShape', () => {
    const line = { start: 5, end: 10, baseline: 0, x0: 0, x1: 30, ascent: 8, descent: 2 };
    expect(lineSelectionSpan(line, 0, 20)).toEqual({ span: [5, 10], tail: true });
    expect(lineSelectionSpan(line, 6, 8)).toEqual({ span: [6, 8], tail: false });
    expect(lineSelectionSpan(line, 6, 5)).toBeNull(); // 空
    expect(lineSelectionSpan(line, 10, 12)).toBeNull(); // [10,12) 与行尾不含
    expect(columnWidthVec([2, 0, 0, 2, 0, 0], line, false)).toEqual([60, 0]); // 横排:行盒宽 × scale
    expect(columnWidthVec([2, 0, 0, 2, 0, 0], line, true)).toEqual([0, 60]); // 竖排:(w,0)→(0,w) 再 ×scale
    expect(lineToText(3, 4, false)).toEqual([3, 4]);
    expect(lineToText(3, 4, true)).toEqual([-4, 3]); // 竖排 to_text (x,y)→(−y,x)
    expect(affApply([1, 0, 0, 1, 5, 7], 2, 3)).toEqual([7, 10]);
    expect(affApply([0, 1, -1, 0, 0, 0], 2, 3)).toEqual([-3, 2]);
    expect(affInvert([2, 0, 0, 2, 10, 20]).map((v) => v + 0)).toEqual([0.5, 0, 0, 0.5, -5, -10]); // +0 归一 −0
    expect(affInvert([1, 0, 0, 1, 0, 0]).map((v) => v + 0)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(affInvert([0, 0, 0, 0, 0, 0])).toEqual([1, 0, 0, 1, 0, 0]); // 退化=恒等
    expect(applyReplace('héllo', 1, 2, '你好')).toBe('h你好llo');
    expect(boxOfShape('Point')).toBeNull();
    expect(boxOfShape({ Box: { x: 1, y: 2, width: 3, height: 4 } })).toEqual([1, 2, 3, 4]);
  });
});
