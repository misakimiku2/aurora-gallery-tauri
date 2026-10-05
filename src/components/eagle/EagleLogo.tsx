import React from 'react';
import eagleLogoMarkup from '../../assets/eagle_logo.svg?raw';

/**
 * Eagle 的标记（`src/assets/eagle_logo.svg`）。
 *
 * 渲染方式与 PixcallLogo 同构：`?raw` 把 SVG 文本打进 bundle、再内联渲染，而不是
 * `<img src>`——内联之后运行时零请求，打包与 CSP 怎么收都不影响它出图。
 * 尺寸由调用方给；它就是「这一路来自 Eagle」的标识位。
 *
 * 注意：当前这份 SVG 是**占位手绘**（蓝底 + 白色飞鸟弧线），不是 Eagle 官方 logo——
 * 官方资产拿到后只替换那个 .svg 文件，组件不用动。
 */
interface Props {
  size?: number;
  className?: string;
}

const EagleLogo: React.FC<Props> = ({ size = 18, className = '' }) => (
  <span
    aria-hidden="true"
    data-testid="eagle-logo"
    className={`block shrink-0 [&>svg]:h-full [&>svg]:w-full ${className}`}
    style={{ width: size, height: size }}
    dangerouslySetInnerHTML={{ __html: eagleLogoMarkup }}
  />
);

export default EagleLogo;
