/**
 * 文档变换状态的比较与合并判定（纯函数，配合撤销/重做使用）。
 *
 * 历史栈里存的是**变换参数**而不是像素（见 ImageEditor 里的注释），所以"这一步
 * 和那一步是否相同"必须能可靠判断 —— 否则每次 React 产生新对象引用都会被当成
 * 一次新操作，撤销栈瞬间被灌满。
 */
import type { EditorTransform } from '../../types';

const cropSig = (c?: EditorTransform['crop']) =>
  c ? `${c.x},${c.y},${c.w},${c.h}` : 'none';

const adjustSig = (a?: EditorTransform['adjust']) =>
  a ? `${a.brightness},${a.contrast},${a.saturation},${a.temperature}` : 'none';

/** 两个变换状态是否等价（值比较，不看对象引用） */
export function isSameTransform(a: EditorTransform, b: EditorTransform): boolean {
  return (
    cropSig(a.crop) === cropSig(b.crop) &&
    (a.rotation ?? 0) === (b.rotation ?? 0) &&
    (a.flipH ?? false) === (b.flipH ?? false) &&
    (a.flipV ?? false) === (b.flipV ?? false) &&
    adjustSig(a.adjust) === adjustSig(b.adjust)
  );
}

/** 几何部分（裁剪 / 旋转 / 翻转）是否没变——用于判断"用户是否在拖调色滑杆" */
export function isSameGeometry(a: EditorTransform, b: EditorTransform): boolean {
  return (
    cropSig(a.crop) === cropSig(b.crop) &&
    (a.rotation ?? 0) === (b.rotation ?? 0) &&
    (a.flipH ?? false) === (b.flipH ?? false) &&
    (a.flipV ?? false) === (b.flipV ?? false)
  );
}

/** 是否"什么都没调"（无裁剪、无旋转、无翻转、四项调色全 0） */
export function isPristine(t: EditorTransform): boolean {
  return (
    !t.crop &&
    (t.rotation ?? 0) === 0 &&
    !t.flipH &&
    !t.flipV &&
    (!t.adjust ||
      (t.adjust.brightness === 0 &&
        t.adjust.contrast === 0 &&
        t.adjust.saturation === 0 &&
        t.adjust.temperature === 0))
  );
}
