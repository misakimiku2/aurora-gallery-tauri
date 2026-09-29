import React from 'react';
import pixcallLogoMarkup from '../../assets/pixcall_logo.svg?raw';

/**
 * PixCall 的官方标记（`src/assets/pixcall_logo.svg`）。
 *
 * 用 `?raw` 把 SVG 文本打进 bundle、再内联渲染，而不是 `<img src>`：后者在真应用里出过破图
 * （资源请求要过 Tauri 的 CSP 与协议，浏览器里却一切正常），内联之后运行时零请求，
 * 打包与 CSP 怎么收都不影响它出图。原始文件仍是唯一来源，改 logo 只改那个 .svg。
 *
 * 导入来源后续还会加（Eagle 等），所以这颗标记就是「这一路来自 PixCall」的标识位，尺寸由调用方给。
 */
interface Props {
  size?: number;
  className?: string;
}

const PixcallLogo: React.FC<Props> = ({ size = 18, className = '' }) => (
  <span
    aria-hidden="true"
    data-testid="pixcall-logo"
    className={`block shrink-0 [&>svg]:h-full [&>svg]:w-full ${className}`}
    style={{ width: size, height: size }}
    dangerouslySetInnerHTML={{ __html: pixcallLogoMarkup }}
  />
);

export default PixcallLogo;
