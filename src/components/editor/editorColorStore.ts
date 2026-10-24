/**
 * 前景/背景色（画笔轮起用）：**会话级** module store，不是文档状态。
 *
 * 为什么不放 `EditorDocument`：PS 的前/背景色跨文档共享、关掉文档还在、也不进
 * 撤销栈（换色不是对文档的修改）。`ImageEditor`（画笔取色）与 `EditorPanel`
 * （颜色区控件）是两棵子树，照 `editorViewStore` 的订阅模式共享，不提升进
 * React 树。吸管工具（下一轮）取色也写进这里。
 *
 * 快捷键（PS 口径，接在 useEditorKeyboard）：`D` 复位黑/白，`X` 交换前后景。
 */

export interface EditorColors {
  foreground: string;
  background: string;
}

let colors: EditorColors = { foreground: '#000000', background: '#ffffff' };
const listeners = new Set<() => void>();

/** `#rgb` / `#rrggbb` 归一成小写 `#rrggbb`；不合法返回 null（不猜）。 */
export function normalizeHexColor(raw: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return `#${hex}`;
}

function set(next: EditorColors) {
  if (next.foreground === colors.foreground && next.background === colors.background) return;
  colors = next;
  listeners.forEach(l => l());
}

export function setForeground(hex: string): void {
  const v = normalizeHexColor(hex);
  if (!v) return;
  set({ ...colors, foreground: v });
}

export function setBackground(hex: string): void {
  const v = normalizeHexColor(hex);
  if (!v) return;
  set({ ...colors, background: v });
}

/** `X`：交换前景/背景（画蒙版时黑白对调全靠它）。 */
export function swapEditorColors(): void {
  set({ foreground: colors.background, background: colors.foreground });
}

/** `D`：复位 PS 出厂的 黑前景 / 白背景。 */
export function resetEditorColors(): void {
  set({ foreground: '#000000', background: '#ffffff' });
}

export function getEditorColors(): EditorColors {
  return colors;
}

export function subscribeEditorColors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
