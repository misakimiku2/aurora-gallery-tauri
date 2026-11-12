// 轻量非破坏图片调整 —— Tauri 命令桥(2026-11-13 设计 §5/§9)。
// params 一律以 JSON 字符串过桥(Rust 侧 AdjustParams 是权威 schema)。

import { invoke } from '@tauri-apps/api/core';
import { AdjustParams } from '../../utils/adjust';

export interface FileEditEntry {
  fileId: string;
  params: string;
  updatedAt: number;
  path?: string;
}

export interface BakeOutcome {
  outPath: string;
  fileId: string;
  width: number;
  height: number;
}

export interface BakeOptions {
  /** 'png' | 'jpeg';缺省由调用方按源格式决定 */
  format?: string;
  /** JPEG 质量 1-100,默认 90 */
  quality?: number;
  /** 导出最大宽度(只缩不放) */
  maxWidth?: number;
}

export function editGetParams(fileId: string): Promise<string | null> {
  return invoke<string | null>('edit_get_params', { fileId });
}

export function editSetParams(fileId: string, params: AdjustParams): Promise<void> {
  return invoke<void>('edit_set_params', { fileId, params: JSON.stringify(params) });
}

export function editClearParams(fileId: string): Promise<void> {
  return invoke<void>('edit_clear_params', { fileId });
}

export function editGetAllParams(): Promise<FileEditEntry[]> {
  return invoke<FileEditEntry[]>('edit_get_all_params');
}

/**
 * 烘焙导出:按参数产**新文件**(`<原名>-edited.<ext>`,同目录),原图与参数不动;
 * 写盘后 Rust 侧自动入 file_index 并发 metadata-updated(网格即时可见)。
 * AVIF/JXL 源暂不支持(解码 crate 缺位),报错文案由 Rust 给出。
 */
export function bakeEdits(srcPath: string, params: AdjustParams, opts?: BakeOptions): Promise<BakeOutcome> {
  return invoke<BakeOutcome>('bake_edits', {
    srcPath,
    paramsJson: JSON.stringify(params),
    format: opts?.format ?? null,
    quality: opts?.quality ?? null,
    maxWidth: opts?.maxWidth ?? null,
  });
}
