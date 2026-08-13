// 全局 SVG 颜色通道滤镜定义（纯静态，无 props）。
// 供 ImageViewer/FileGrid 等处的通道分离（R/G/B/亮度）效果使用。
export const SvgColorFilters = () => (
  <svg style={{ display: 'none' }}><defs><filter id="channel-r"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter><filter id="channel-g"><feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter><filter id="channel-b"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" /></filter><filter id="channel-l"><feColorMatrix type="saturate" values="0" /></filter></defs></svg>
);
