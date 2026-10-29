/**
 * 编辑器工具图标(photocraft 上游 assets/icons 原版 SVG,vendor 随引擎一并 vendored):
 * 24×24 stroke=currentColor,随按钮文字色染色。?raw 内联打包,无运行时请求。
 */
import type { FC } from 'react';
import move from '../../assets/editor-icons/move.svg?raw';
import squareDashed from '../../assets/editor-icons/square-dashed.svg?raw';
import ellipseDashed from '../../assets/editor-icons/ellipse-dashed.svg?raw';
import marqueeRow from '../../assets/editor-icons/marquee-row.svg?raw';
import marqueeColumn from '../../assets/editor-icons/marquee-column.svg?raw';
import lasso from '../../assets/editor-icons/lasso.svg?raw';
import pentagon from '../../assets/editor-icons/pentagon.svg?raw';
import lassoMagnetic from '../../assets/editor-icons/lasso-magnetic.svg?raw';
import crop from '../../assets/editor-icons/crop.svg?raw';
import pipette from '../../assets/editor-icons/pipette.svg?raw';
import brush from '../../assets/editor-icons/brush.svg?raw';
import eraser from '../../assets/editor-icons/eraser.svg?raw';
import gradient from '../../assets/editor-icons/gradient.svg?raw';
import paintBucket from '../../assets/editor-icons/paint-bucket.svg?raw';
import droplet from '../../assets/editor-icons/droplet.svg?raw';
import triangle from '../../assets/editor-icons/triangle.svg?raw';
import pointer from '../../assets/editor-icons/pointer.svg?raw';
import hand from '../../assets/editor-icons/hand.svg?raw';
import zoomIn from '../../assets/editor-icons/zoom-in.svg?raw';

/** 图标名 = 上游 assets/icons 文件名(icons.rs tool_icon 同名)。 */
export type EditorIconName =
  | 'move' | 'square-dashed' | 'ellipse-dashed' | 'marquee-row' | 'marquee-column'
  | 'lasso' | 'pentagon' | 'lasso-magnetic' | 'crop' | 'pipette' | 'brush' | 'eraser'
  | 'gradient' | 'paint-bucket' | 'droplet' | 'triangle' | 'pointer' | 'hand' | 'zoom-in';

const ICONS: Record<EditorIconName, string> = {
  move, 'square-dashed': squareDashed, 'ellipse-dashed': ellipseDashed,
  'marquee-row': marqueeRow, 'marquee-column': marqueeColumn,
  lasso, pentagon, 'lasso-magnetic': lassoMagnetic,
  crop, pipette, brush, eraser, gradient, 'paint-bucket': paintBucket,
  droplet, triangle, pointer, hand, 'zoom-in': zoomIn,
};

export const EditorIcon: FC<{ name: EditorIconName; size?: number; className?: string }> = ({
  name, size = 17, className,
}) => {
  const svg = ICONS[name]
    .replace(/width="24"/, `width="${size}"`)
    .replace(/height="24"/, `height="${size}"`);
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};
