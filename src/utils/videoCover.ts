/**
 * 视频抽帧封面 —— P1.5-A（前端 `<video>` + canvas，零原生依赖）
 *
 * 适用边界：**只处理 Chromium/WebView2 原生能解码的容器**（mp4 / m4v / mov / webm），
 * 其余 8 种（mkv / avi / flv / ts / 3gp / wmv / mpg / mpeg）走后端 ffmpeg（P1.5-B）。
 * 判断由 `mediaExtensions.isWebDecodableVideo` 给出，本模块不再维护容器清单。
 *
 * ── 三条硬约束（踩过的坑，改代码前先读）─────────────────────────────
 * 1. **必须 `crossOrigin = 'anonymous'`**：否则 <video> 会把 canvas 标记为 tainted，
 *    `toDataURL/toBlob` 直接抛 SecurityError（「复制当前帧」曾因此静默失败，指挥官实测确认）。
 *    安全性已核实：Tauri 2.11.6 asset 协议的每个响应都带
 *    `Access-Control-Allow-Origin: <window_origin>`（协议源码 asset.rs:39），Windows 上该值
 *    = `http://tauri.localhost`，与页面自身源精确吻合，不影响播放。
 * 2. **不得取 t=0**（设计方案 §11.2 实测：样本首帧纯黑，与 t=2~4s 帧像素差 188.7/255）。
 *    本模块**采样多个候选帧后挑「最亮且有一定鲜艳度」的一帧**（见 `frameScore`）——
 *    只判「是否近黑」会漏掉「暗但不算黑」的片头（2026-10-14 指挥官实测：某 13s 录像前段偏暗，
 *    10% 处抽到的暗帧被采纳 → 封面与主色一起偏暗，而片内其实很亮）。
 * 3. **产出的永远是 JPEG 数据 URL**，由调用方交给后端 `save_remote_thumbnail` 落库；
 *    本模块**绝不**把视频自身的 asset:// 地址写进任何缩略图缓存（见记忆 §2.1 事故）。
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { isWebDecodableVideo } from './mediaExtensions';
import {
  extractColorsFromImageData,
  averageLuma,
  averageColorfulness,
  DominantColorWithLab,
} from './dominantColors';

export interface VideoCoverResult {
  /** `data:image/jpeg;base64,...` —— 与 AVIF 回落路径同格式，可直接喂给 save_remote_thumbnail */
  dataUrl: string;
  colors: DominantColorWithLab[];
  width: number;
  height: number;
  /** 实际抽中的时间点（秒），便于排查「抽了个黑帧」类反馈 */
  seekTime: number;
}

/** 基础超时：20s。大文件按体积追加余量（机械盘 seek + 解码都慢），上限 120s */
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
/** 封面目标尺寸（短边缩到此值，与 AVIF 回落路径同口径） */
const TARGET_SIZE = 256;
/**
 * 候选抽帧时间点（占时长的比例）。首帧常为片头/黑场，从 10% 起步（设计方案 §11.2）；
 * 往后铺开是为了在「前段偏暗」的录像里也能取到亮帧。
 */
const SEEK_FRACTIONS = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];
/**
 * 平均亮度达到此值即认为「够亮」，停止继续采样。
 * 机械盘上每次 seek 要几十到几百毫秒；绝大多数视频首个候选就够亮 → 通常只抽 1 帧。
 */
const GOOD_LUMA = 85;
/** 选帧打分：亮度为主（避免暗封面），鲜艳度次要加权（避免「纯白闪过」压过有内容的亮帧） */
const SCORE_LUMA_CAP = 160;
const SCORE_SAT_WEIGHT = 0.5;

let probeVideo: HTMLVideoElement | null = null;
let queueTail: Promise<unknown> = Promise.resolve();

/** 全局复用的隐藏 <video>：同一时刻只允许一个解码器存在，避免滚动时的并发风暴 */
function getProbe(): HTMLVideoElement {
  if (!probeVideo) {
    const v = document.createElement('video');
    // crossOrigin 必须在 src 之前设置，否则本次加载不会走 CORS 模式
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText =
      'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(v);
    probeVideo = v;
  }
  return probeVideo;
}

/** 串行队列：所有抽帧请求排队执行，单个任务失败不得断链 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  // 单个任务失败不能断链
  queueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function waitEvent(
  el: HTMLVideoElement,
  event: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error('video element error'));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('aborted', 'AbortError'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 释放解码器：务必清 src 并 load()，否则大文件的解码资源会一直挂着 */
function releaseProbe(v: HTMLVideoElement) {
  try {
    v.pause();
    v.removeAttribute('src');
    v.load();
  } catch {
    /* 忽略：释放失败不影响主流程 */
  }
}

/**
 * 生成候选抽帧时间点（秒）：按 `SEEK_FRACTIONS` 铺开，接近片尾时收敛到 safe end，
 * 并去重（极短视频的多个比例可能落到同一毫秒）。
 */
export function seekCandidates(duration: number): number[] {
  const safeEnd = Math.max(duration - 0.05, 0);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const f of SEEK_FRACTIONS) {
    const t = Math.min(duration * f, safeEnd);
    const key = Math.round(t * 1000);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/** 候选帧打分：越亮越好，其次越鲜艳越好。用于在候选帧中挑出代表帧。 */
export function frameScore(luma: number, colorfulness: number): number {
  return Math.min(luma, SCORE_LUMA_CAP) + colorfulness * SCORE_SAT_WEIGHT;
}

export interface VideoCoverMeta {
  /** 文件大小（字节）。只用于推算超时余量，**不是门槛**（流式播放不受体积限制，2026-10-14 复核） */
  sizeBytes?: number;
  /** `video/*` MIME：路径无扩展名时用来判容器 */
  format?: string;
  /** 取消信号。抽帧是串行队列，取消只在「排队前」与「每次 seek 前」生效，进不了单次解码内部 */
  signal?: AbortSignal;
}

/**
 * 体积感知的超时：基础 20s + 每 100MB 追加 1s，封顶 120s。
 *
 * 背景（2026-10-14，4500 文件夹实测）：固定 20s 在机械盘上对大文件不够——
 * 该场景下磁盘正被 4500 个文件的扫描与图片缩略图生成抢 IO，大视频的
 * metadata / seek / 解码很容易超时；而超时=失败=下次挂载重抽，恶性循环。
 * 模型很粗糙（并不真的顺序读全文件），但方向正确：大文件给更多余量。
 */
function timeoutFor(sizeBytes?: number): number {
  if (!sizeBytes || sizeBytes <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + sizeBytes / 100_000);
}

/**
 * 抽取视频封面帧 + 主色。
 *
 * 返回 null 的场合（调用方一律降级为占位图标，不得回落到视频路径）：
 * 不可解码的容器 / 超时 / 被取消 / 解码报错 / 全是黑帧。
 */
export async function extractVideoCover(
  filePath: string,
  meta?: VideoCoverMeta
): Promise<VideoCoverResult | null> {
  if (!filePath) return null;
  if (!isWebDecodableVideo(filePath, meta?.format)) return null;
  const timeoutMs = timeoutFor(meta?.sizeBytes);

  return enqueue(async () => {
    const v = getProbe();
    const started = Date.now();

    try {
      v.src = convertFileSrc(filePath);
      v.load();
      await waitEvent(v, 'loadedmetadata', timeoutMs);

      const duration = v.duration;
      if (!Number.isFinite(duration) || duration <= 0 || !v.videoWidth || !v.videoHeight) {
        return null;
      }

      // 目标尺寸：短边缩到 256（与 AVIF 回落同口径）。所有候选帧尺寸一致，先算一次。
      const srcW = v.videoWidth;
      const srcH = v.videoHeight;
      let w: number;
      let h: number;
      if (srcW < srcH) {
        w = TARGET_SIZE;
        h = Math.round((srcH * TARGET_SIZE) / srcW);
      } else {
        h = TARGET_SIZE;
        w = Math.round((srcW * TARGET_SIZE) / srcH);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;

      // 采样多个候选帧，取综合得分最高的一帧（亮度为主 + 鲜艳度加权）
      let best: { imageData: ImageData; score: number; seek: number } | null = null;
      for (const target of seekCandidates(duration)) {
        if (meta?.signal?.aborted) return null;
        if (Date.now() - started > timeoutMs) break;

        if (v.currentTime !== target) {
          v.currentTime = target;
          await waitEvent(v, 'seeked', Math.max(timeoutMs - (Date.now() - started), 1000));
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(v, 0, 0, w, h);

        let imageData: ImageData;
        try {
          imageData = ctx.getImageData(0, 0, w, h);
        } catch {
          // canvas 被污染（理论上加了 crossOrigin 不会发生）：直接放弃，不回退任何东西
          return null;
        }

        const luma = averageLuma(imageData.data);
        const score = frameScore(luma, averageColorfulness(imageData.data));
        if (!best || score > best.score) {
          best = { imageData, score, seek: target };
        }
        // 够亮就直接采用，省掉后续 seek（机械盘上很关键）
        if (luma >= GOOD_LUMA) break;
      }

      if (!best) return null;

      // 用最优帧的像素重建画布（putImageData 为精确拷贝）再导出 JPEG
      ctx.putImageData(best.imageData, 0, 0);
      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      } catch {
        return null;
      }
      if (!dataUrl || dataUrl.length < 100) return null;

      return {
        dataUrl,
        colors: extractColorsFromImageData(best.imageData.data, 8),
        width: w,
        height: h,
        seekTime: best.seek,
      };
    } catch {
      return null;
    } finally {
      releaseProbe(v);
    }
  });
}
