const NON_TEXT_INPUT_TYPES = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'image',
  'color',
]);

/**
 * 焦点是否落在「文本类」编辑目标上。
 *
 * 全局快捷键用它让路：在标签、描述、重命名等输入框里打字时，
 * 空格 / m / f / , / . 这类单键命令不应把字符吞掉。
 * range / checkbox 一类控件不算编辑目标 —— 它们的键位仍交给全局快捷键。
 */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}
