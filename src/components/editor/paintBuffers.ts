/**
 * 画笔像素缓冲注册表：source 路径 → 内存 canvas（LRU）。
 *
 * 独立成模块（不在 useEditorBrush 里）是因为**渲染侧也要读**：抬笔瞬间 source
 * 就换成新路径、文件由后台烘焙补上（性能方案 2026-10-25）——`EditorCanvasLayers`
 * 发现某层的 source 在注册表里有缓冲时，直接把缓冲画到 `<canvas>` 上显示
 * （零编码、即时），没有缓冲才回退 `<img src=convertFileSrc(...)>` 读文件。
 *
 * **forget 很关键**：每笔的缓冲是"同一个 canvas 对象边画边变"，换 key 时必须
 * 把旧 key 删掉——否则撤销回旧 source 时，注册表会返回**含新笔迹**的同一个对象
 * （旧 key 还指着它），画面显示"撤销不了"。
 */

const buffers = new Map<string, HTMLCanvasElement>();
const order: string[] = [];
/** 4000×3000 的缓冲约 48MB——6 块 ~288MB 封顶，再多就该让系统回收（重建=再读一次文件）。 */
const BUFFER_LIMIT = 6;

export function getPaintBuffer(source: string): HTMLCanvasElement | undefined {
  return buffers.get(source);
}

/** 登记（或换 key）一块缓冲并触碰 LRU；超上限逐出最久未用的。 */
export function rememberPaintBuffer(source: string, canvas: HTMLCanvasElement): void {
  const i = order.indexOf(source);
  if (i >= 0) order.splice(i, 1);
  buffers.set(source, canvas);
  order.push(source);
  while (order.length > BUFFER_LIMIT) {
    const evict = order.shift();
    if (evict) buffers.delete(evict);
  }
}

/** 删除某个 key（内容已被新 key 接管时，防止旧 key 返回被改写过的同一对象）。 */
export function forgetPaintBuffer(source: string): void {
  const i = order.indexOf(source);
  if (i >= 0) order.splice(i, 1);
  buffers.delete(source);
}
