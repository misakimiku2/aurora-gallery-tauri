import React from 'react';
import { AdjustToneParams } from '../../../utils/adjust';

/**
 * 色温/色调的 SVG 对角增益滤镜(全局单例,挂一次)。
 *
 * 亮度/对比度/饱和度走 CSS 内建 filter 函数(公式与 Rust apply_tone_rgb 逐项一致);
 * 色温/色调 CSS 没有内建,用本滤镜补齐 —— feColorMatrix 对角增益:
 *   R' = R×(1+p·0.25),G' = G×(1-t·0.25),B' = B×(1-p·0.25),alpha 透传。
 *
 * ⚠️ 必须 colorInterpolationFilters="sRGB":SVG 滤镜默认在 linearRGB 里算,
 * 不显式指定会与 Rust/CSS 的 sRGB 数值语义错位(整张图发灰)。
 * feColorMatrix 输出自动 clamp [0,1],与 Rust 每步 clamp 口径一致。
 */
export const AdjustFilterDefs: React.FC<{ tone: AdjustToneParams }> = ({ tone }) => {
  const rGain = 1 + tone.temperature * 0.25;
  const gGain = 1 - tone.tint * 0.25;
  const bGain = 1 - tone.temperature * 0.25;
  const values = [
    rGain.toFixed(6), '0', '0', '0', '0',
    '0', gGain.toFixed(6), '0', '0', '0',
    '0', '0', bGain.toFixed(6), '0', '0',
    '0', '0', '0', '0', '1',
  ].join(' ');
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <filter
          id="aurora-adjust-tt"
          colorInterpolationFilters="sRGB"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <feColorMatrix type="matrix" values={values} />
        </filter>
      </defs>
    </svg>
  );
};
