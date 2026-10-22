/**
 * 调色矩阵（与 `core/src/imaging/adjust.rs` 一一对应）。
 *
 * ## 为什么两端各写一份，而不是让 Rust 算好传过来
 *
 * 预览必须是**实时的**：拖动滑杆时每一帧都要重算，走一次 IPC + 重新编码代理图
 * 要 0.4–0.5 秒，手感直接废掉。所以预览走浏览器原生的 SVG `feColorMatrix`
 * （GPU 加速，零延迟），导出才走 Rust。
 *
 * 两份实现的风险是**漂移**——预览偏暖、导出偏冷，用户会以为导出坏了。
 * 对策：公式照抄，并且两端用**同一组采样值**做单测
 * （输入 120/90/60 + 参数 0.2/0.3/0.4/0.5 → 必须都得到 190/100/29）。
 * 改任何一边都会让那边的测试红。
 *
 * ## 参数口径
 *
 * 四个参数都是 `-100 ..= 100`，0 = 不变。内部先 `/100` 归一，再构矩阵。
 * 顺序固定：亮度 → 对比度 → 饱和度 → 色温（矩阵不可交换，换顺序结果不同）。
 */

/** 3×3 矩阵 + 偏移（偏移以 0–255 为单位，与 Rust 侧一致） */
export interface ColorMatrix {
  m: number[][];
  offset: number[];
}

const IDENTITY: ColorMatrix = {
  m: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  offset: [0, 0, 0],
};

/** 先应用 a，再应用 b（等价矩阵左乘 b） */
function then(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const m = [0, 1, 2].map(r => [0, 1, 2].map(c => [0, 1, 2].reduce((sum, k) => sum + b.m[r][k] * a.m[k][c], 0)));
  const offset = [0, 1, 2].map(r => [0, 1, 2].reduce((sum, k) => sum + b.m[r][k] * a.offset[k], 0) + b.offset[r]);
  return { m, offset };
}

/** 亮度：增益（乘法，与 CSS brightness 一致） */
function brightness(p: number): ColorMatrix {
  const g = 1 + p;
  return {
    m: [
      [g, 0, 0],
      [0, g, 0],
      [0, 0, g],
    ],
    offset: [0, 0, 0],
  };
}

/** 对比度：绕中灰缩放 */
function contrast(p: number): ColorMatrix {
  const c = 1 + p;
  const off = 127.5 * (1 - c);
  return {
    m: [
      [c, 0, 0],
      [0, c, 0],
      [0, 0, c],
    ],
    offset: [off, off, off],
  };
}

/** 饱和度：以亮度为轴插值（W3C saturate 矩阵） */
function saturation(p: number): ColorMatrix {
  const s = 1 + p;
  const LR = 0.213;
  const LG = 0.715;
  const LB = 0.072;
  return {
    m: [
      [LR + (1 - LR) * s, LG - LG * s, LB - LB * s],
      [LR - LR * s, LG + (1 - LG) * s, LB - LB * s],
      [LR - LR * s, LG - LG * s, LB + (1 - LB) * s],
    ],
    offset: [0, 0, 0],
  };
}

/** 色温：暖调抬红压蓝，冷调相反；绿通道保持 */
function temperature(p: number): ColorMatrix {
  const t = p * 0.3;
  return {
    m: [
      [1 + t, 0, 0],
      [0, 1, 0],
      [0, 0, 1 - t],
    ],
    offset: [0, 0, 0],
  };
}

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
}

export const ZERO_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
};

export const isZeroAdjustments = (a?: Adjustments | null): boolean =>
  !a || (a.brightness === 0 && a.contrast === 0 && a.saturation === 0 && a.temperature === 0);

/** 参数（-100..100）→ 合成矩阵（偏移以 0–255 计） */
export function buildAdjustMatrix(a?: Adjustments | null): ColorMatrix {
  if (isZeroAdjustments(a)) return IDENTITY;
  const { brightness: b, contrast: c, saturation: s, temperature: t } = a!;
  return then(
    then(
      then(brightness(b / 100), contrast(c / 100)),
      saturation(s / 100),
    ),
    temperature(t / 100),
  );
}

/**
 * 转成 SVG `feColorMatrix` 的 values 字符串（4×5，20 个数）。
 *
 * 注意 **偏移那一列要 /255**：SVG 的偏移是加在 0–1 归一化颜色上的，
 * 而我们的内部表示用 0–255。这一处换算漏了会让对比度完全失效
 * （偏移变成 255 倍，画面直接炸白）。
 */
export function toFeColorMatrixValues(matrix: ColorMatrix): string {
  const [r, g, b] = matrix.m;
  const [or, og, ob] = matrix.offset;
  return [
    r[0], r[1], r[2], 0, or / 255,
    g[0], g[1], g[2], 0, og / 255,
    b[0], b[1], b[2], 0, ob / 255,
    0, 0, 0, 1, 0,
  ].join(' ');
}

/** 把矩阵作用到单个像素（只有测试和极端兜底会用到；预览走 SVG filter） */
export function applyMatrixToPixel(matrix: ColorMatrix, rgb: [number, number, number]): [number, number, number] {
  const clamp = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
  return [0, 1, 2].map(r =>
    clamp(matrix.m[r][0] * rgb[0] + matrix.m[r][1] * rgb[1] + matrix.m[r][2] * rgb[2] + matrix.offset[r]),
  ) as [number, number, number];
}
