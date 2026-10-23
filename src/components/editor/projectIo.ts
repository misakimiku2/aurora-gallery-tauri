/**
 * `.aurora` 工程的**命令式流程**：文件对话框 + IPC + 结果映射。
 *
 * 与 `projectFile.ts` 的分工：那边是纯函数（形状转换，可单测、无 Tauri 依赖），
 * 这里是"点一下按钮会发生什么"。单独成文件是为了让**两处入口共用同一套流程**：
 * 编辑器文档栏的按钮，以及应用顶栏的「打开工程」（后者在没有任何编辑器标签时
 * 也能用——否则新启动的应用要先进某张图才能打开工程，等于没有入口）。
 */
import { invoke } from '@tauri-apps/api/core';
import type { EditorDocument } from '../../types';
import {
  buildSavePayload,
  defaultProjectPath,
  isProjectPath,
  projectDisplayName,
  projectPayloadToDocument,
  type OpenedProjectPayload,
} from './projectFile';

/** `editor_save_project` 的返回（对应 Rust `SaveReport`）。 */
export interface SaveReport {
  path: string;
  bytes: number;
  layerCount: number;
  imageCount: number;
  /** 内容去重省掉的字节数 */
  dedupedBytes: number;
}

export interface SaveProjectOutcome {
  report: SaveReport;
  /** 保存后的文档：`path` 换成工程路径、`name` 换成工程名、`dirty` 清掉 */
  document: EditorDocument;
}

export interface OpenedProjectOutcome {
  document: EditorDocument;
  /** 非致命提示（某层被跳过、尺寸被修正……） */
  warnings: string[];
}

const PROJECT_FILTERS = [{ name: 'Aurora 工程', extensions: ['aurora'] }];

/**
 * 保存工程。`saveAs=false` 且文档**已经是** `.aurora` 时直接覆盖，否则弹对话框。
 *
 * 从图库打开的 `photo.jpg` 一定走对话框：把工程 ZIP 覆盖到 `.jpg` 上等于毁掉原图。
 *
 * @returns 用户取消时返回 `null`
 */
export async function saveProject(
  doc: EditorDocument,
  saveAs: boolean,
): Promise<SaveProjectOutcome | null> {
  const payload = buildSavePayload(doc); // 画布无效会在这里抛错（先于任何对话框）
  let target = !saveAs && isProjectPath(doc.path) ? (doc.path as string) : '';

  if (!target) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const picked = await save({
      title: saveAs ? '另存为工程' : '保存工程',
      filters: PROJECT_FILTERS,
      defaultPath: defaultProjectPath(doc),
    });
    if (!picked) return null;
    target = picked;
  }

  const report = await invoke<SaveReport>('editor_save_project', {
    doc: payload,
    targetPath: target,
  });

  // 只改 path / name / dirty：三项都不进文档签名，所以不会多出一步撤销
  return {
    report,
    document: {
      ...doc,
      path: report.path,
      name: projectDisplayName(report.path),
      dirty: false,
    },
  };
}

/** 打开指定路径的工程（已确认过路径时用这个）。 */
export async function openProjectFromPath(path: string): Promise<OpenedProjectOutcome> {
  const payload = await invoke<OpenedProjectPayload>('editor_open_project', { path });
  return {
    document: projectPayloadToDocument(payload, path),
    warnings: payload.warnings ?? [],
  };
}

/** 弹对话框并打开工程。
 *
 * @returns 用户取消时返回 `null`
 */
export async function openProjectDialog(): Promise<OpenedProjectOutcome | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    title: '打开工程',
    multiple: false,
    filters: PROJECT_FILTERS,
  });
  if (!picked || typeof picked !== 'string') return null;
  return openProjectFromPath(picked);
}
