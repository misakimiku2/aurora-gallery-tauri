export interface DominantColor {
  color: string;
  percentage: number;
}

export interface ImageTransform {
  scale: number;
  rotation: number;
  x: number;
  y: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageInfo {
  path: string;
  width: number;
  height: number;
  size?: number;
  format?: string;
  modified?: string;
}
