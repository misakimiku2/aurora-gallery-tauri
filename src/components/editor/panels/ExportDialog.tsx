/**
 * 导出为对话框(上游 crates/ui-egui/src/export_dialog.rs 口径):
 * 左列=文件设置(格式/质量/无损/透明区域/元数据/色彩配置文件/嵌入 ICC/TGA 位深)
 * + 图像大小(Scale %/W/H px/约束比例/重采样);右列=300px 棋盘格预览(代理定型
 * 合成,nearest 时 pixelated 放大)+ 文件大小估计(≤40MP 精确/否则折算)。
 * 确认=记忆 14 键设置 → 系统保存对话框 → editorExportDocument 落盘(文档零改动、
 * 不入历史)。Esc 取消/Enter 确定由画布全局键接管(对话框打开期间吞其余键)。
 * 预设区(上游 Save Preset…)暂缺,引擎命令已就绪,后补。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closeExportDialog, confirmExportDialog, getSession, showEditorNotice, subscribeSession, updateExportDialog,
  type ExportDialogState,
} from '../editorStore';
import { editorExportEstimate, editorExportPreview } from '../editorBridge';
import {
  exportPixels, humanBytes, MAX_PX, resizeFromScale, resizeFromSide, RESAMPLE_OPTIONS,
} from '../exportDialogMath';
import { EditorSelect } from '../editorSelect';

const numCls = 'w-16 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300';
const labelCls = 'text-neutral-500 dark:text-neutral-400 shrink-0';
const sectionCls = 'text-[10px] font-medium text-neutral-500 dark:text-neutral-400 mt-1';
const sliderCls = 'flex-1 accent-sky-600 min-w-0';
const checkbox = 'accent-sky-600';

/** 滑杆 + 数值框(同 SelectMaskDialog 款)。 */
const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, suffix, onChange }) => (
  <label className="flex items-center gap-1.5">
    <span className={`${labelCls} w-16`}>{label}</span>
    <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className={sliderCls} />
    <input
      type="number" min={min} max={max} step={1} value={value}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
      }}
      className={numCls}
    />
    {suffix ? <span className="text-[10px] text-neutral-500 dark:text-neutral-400 w-5">{suffix}</span> : null}
  </label>
);

const FORMAT_ZH: Record<string, string> = { png: 'PNG', jpg: 'JPG', webp: 'WebP', tif: 'TIFF', tga: 'TGA', ico: 'ICO' };
const METADATA_ZH: Record<string, string> = { none: '无', exif: 'EXIF', all: '全部' };
const PROFILE_ZH: Record<string, string> = { document: '文档配置文件', srgb: '转换为 sRGB' };
const TGA_BITS_ZH: Record<string, string> = { auto: '自动', '24': '24 位/像素', '32': '32 位/像素' };

/** 对话框位置持久化(同 SelectMaskDialog 款:跨标签/重启保留)。 */
const POS_KEY = 'aurora-editor:export-pos';
function loadPos(): { x: number; y: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { x: number; y: number } | null;
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? p : null;
  } catch {
    return null;
  }
}
function savePos(p: { x: number; y: number }): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    /* 存储不可用忽略 */
  }
}
const clampPos = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.min(Math.max(p.x, 4), window.innerWidth - 680),
  y: Math.min(Math.max(p.y, 4), window.innerHeight - 120),
});

/** 桥层 f 参数(源尺寸不进设置,定型由 Rust 从真实源算)。 */
function settingsOf(ed: ExportDialogState): Record<string, unknown> {
  return {
    format: ed.format, quality: ed.quality, lossless: ed.lossless, transparency: ed.transparency,
    metadata: ed.metadata, profile: ed.profile, embedProfile: ed.embedProfile, tgaBits: ed.tgaBits,
    sizing: ed.sizing, scale: ed.scale, width: ed.width, height: ed.height,
    lockAspect: ed.lockAspect, resample: ed.resample,
  };
}

export const ExportDialog: React.FC<{ tabId: string; active: boolean }> = ({ tabId, active }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadPos);
  const s = getSession(tabId);
  const ed = s?.exportDialog ?? null;
  // 预览/估计(泵按设置键防抖;图层级导出首帧回填源尺寸)
  const [preview, setPreview] = useState<{ srcW: number; srcH: number; width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } | null>(null);
  const [estimate, setEstimate] = useState<{ bytes: number; exact: boolean } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsKey = ed
    ? JSON.stringify([ed.format, ed.quality, ed.lossless, ed.transparency, ed.metadata, ed.profile, ed.embedProfile, ed.tgaBits, ed.sizing, ed.scale, ed.width, ed.height, ed.lockAspect, ed.resample])
    : '';

  // 每次打开:已有位置钳进视口;没有则居中于编辑器画布
  useEffect(() => {
    if (!ed) return;
    setPos((p) => {
      if (p) return clampPos(p);
      const cv = document.querySelector('[data-editor-canvas]');
      const card = cardRef.current;
      if (!cv || !card) return null;
      const cr = cv.getBoundingClientRect();
      const kr = card.getBoundingClientRect();
      return clampPos({
        x: Math.round(cr.left + cr.width / 2 - kr.width / 2),
        y: Math.round(cr.top + cr.height / 2 - kr.height / 2),
      });
    });
    setPreview(null);
    setEstimate(null);
  }, [ed != null]);

  // 预览泵:设置键变化 250ms 防抖 → editorExportPreview(代理定型合成)
  useEffect(() => {
    const cur = getSession(tabId);
    const dlg = cur?.exportDialog;
    const docId = cur?.docId;
    if (!dlg || docId == null) return;
    const f = settingsOf(dlg);
    let alive = true;
    const t = window.setTimeout(() => {
      editorExportPreview(docId, dlg.layer, f)
        .then((r) => {
          if (!alive) return;
          setPreview(r);
          // 图层级导出:首帧回填源尺寸(种子 W/H 字段与锁定比例数学)
          if (dlg.srcW === 0 && r.srcW > 0) updateExportDialog(tabId, { srcW: r.srcW, srcH: r.srcH });
        })
        .catch((err) => {
          console.error('[editor] 导出预览失败', err);
          if (alive) setPreview(null);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [tabId, settingsKey, ed?.layer]);

  // 大小估计泵:600ms 防抖(比预览慢一拍,重编码贵);ICO 超限直接置空不请求
  useEffect(() => {
    const cur = getSession(tabId);
    const dlg = cur?.exportDialog;
    const docId = cur?.docId;
    if (!dlg || docId == null) return;
    const target = dlg.srcW > 0 ? exportPixels(dlg.srcW, dlg.srcH, dlg) : null;
    if (target && dlg.format === 'ico' && (target.w > 256 || target.h > 256)) {
      setEstimate(null);
      return;
    }
    const f = settingsOf(dlg);
    let alive = true;
    const t = window.setTimeout(() => {
      editorExportEstimate(docId, dlg.layer, f)
        .then((r) => {
          if (alive) setEstimate(r);
        })
        .catch((err) => {
          console.error('[editor] 大小估计失败', err);
          if (alive) setEstimate(null);
        });
    }, 600);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [tabId, settingsKey, ed?.layer, ed?.srcW]);

  // 预览位图上屏
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !preview) return;
    cv.width = preview.width;
    cv.height = preview.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(preview.rgba, preview.width, preview.height), 0, 0);
  }, [preview]);

  const onTitlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = cardRef.current?.getBoundingClientRect();
    if (!r) return;
    const base = pos ?? { x: r.left, y: r.top };
    setPos(base);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: base.x, oy: base.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onTitlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos(clampPos({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
  };
  const onTitlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setPos((p) => {
      if (p) savePos(p);
      return p;
    });
  };

  if (!active || !s || !ed) return null;

  const docId = s.docId;
  const patch = (p: Partial<ExportDialogState>) => updateExportDialog(tabId, p);
  const layerName = ed.layer != null ? s.state?.layers.find((l) => l.id === ed.layer)?.name ?? null : null;
  const isJpg = ed.format === 'jpg';
  const isWebp = ed.format === 'webp';
  const showQuality = isJpg || (isWebp && !ed.lossless);
  const target = ed.srcW > 0 ? exportPixels(ed.srcW, ed.srcH, ed) : null;
  const icoOversize = ed.format === 'ico' && target != null && (target.w > 256 || target.h > 256);

  const onScale = (v: number) => {
    const r = resizeFromScale(ed.srcW, ed.srcH, v);
    if (r) patch({ scale: r.scale, width: r.width, height: r.height, sizing: 'scale' });
    else showEditorNotice(`缩放比例须在 1..1000,尺寸不超过 ${MAX_PX} 像素`);
  };
  const onSide = (editedWidth: boolean, v: number) => {
    const r = resizeFromSide(ed.srcW, ed.srcH, editedWidth ? v : ed.width, editedWidth ? ed.height : v, ed.lockAspect, editedWidth);
    if (r) patch({ width: r.width, height: r.height, scale: r.scale, sizing: 'pixels' });
  };

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center pointer-events-none">
      <div
        ref={cardRef}
        className="pointer-events-auto w-[680px] max-h-[86vh] overflow-y-auto rounded-md bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 p-3 text-[11px] flex flex-col gap-1.5"
        style={pos ? { position: 'fixed', left: pos.x, top: pos.y } : undefined}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center cursor-grab active:cursor-grabbing select-none touch-none shrink-0"
          title="按住拖动窗口"
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
          onPointerCancel={onTitlePointerUp}
        >
          <span className="text-[12px] font-medium">{layerName ? `导出为:${layerName}` : '导出为'}</span>
          <div className="flex-1" />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">Enter 导出 · Esc 取消</span>
        </div>
        <div className="flex gap-3 min-h-0">
          {/* 左列:文件设置 + 图像大小(上游 body 顺序) */}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className={sectionCls}>文件设置</div>
            <label className="flex items-center gap-1.5">
              <span className={`${labelCls} w-16`}>格式</span>
              <EditorSelect
                value={ed.format}
                onChange={(v) => patch({ format: v })}
                className="flex-1"
                options={Object.keys(FORMAT_ZH).map((k) => ({ value: k, label: FORMAT_ZH[k] }))}
              />
            </label>
            {isWebp ? (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={ed.lossless} onChange={(e) => patch({ lossless: e.target.checked })} className={checkbox} />
                无损
              </label>
            ) : null}
            {showQuality ? <Slider label="品质" value={ed.quality} min={1} max={100} onChange={(v) => patch({ quality: Math.round(v) })} /> : null}
            {ed.format === 'tga' ? (
              <label className="flex items-center gap-1.5">
                <span className={`${labelCls} w-16`}>分辨率</span>
                <EditorSelect
                  value={ed.tgaBits}
                  onChange={(v) => patch({ tgaBits: v })}
                  className="flex-1"
                  options={Object.keys(TGA_BITS_ZH).map((k) => ({ value: k, label: TGA_BITS_ZH[k] }))}
                />
              </label>
            ) : null}
            {!isJpg ? (
              <label className="flex items-center gap-1.5" title="关闭时压平到背景色(jpg 恒无透明)">
                <input type="checkbox" checked={ed.transparency} onChange={(e) => patch({ transparency: e.target.checked })} className={checkbox} />
                保留透明区域
              </label>
            ) : null}
            <label className="flex items-center gap-1.5">
              <span className={`${labelCls} w-16`}>元数据</span>
              <EditorSelect
                value={ed.metadata}
                onChange={(v) => patch({ metadata: v })}
                className="flex-1"
                options={Object.keys(METADATA_ZH).map((k) => ({ value: k, label: METADATA_ZH[k] }))}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className={`${labelCls} w-16`}>色彩配置</span>
              <EditorSelect
                value={ed.profile}
                onChange={(v) => patch({ profile: v })}
                className="flex-1"
                options={Object.keys(PROFILE_ZH).map((k) => ({ value: k, label: PROFILE_ZH[k] }))}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={ed.embedProfile} onChange={(e) => patch({ embedProfile: e.target.checked })} className={checkbox} />
              嵌入颜色配置文件
            </label>
            <div className={sectionCls}>图像大小</div>
            <label className="flex items-center gap-1.5">
              <span className={`${labelCls} w-16`}>缩放</span>
              <input
                type="number" min={1} max={1000} value={Math.round(ed.scale)}
                onChange={(e) => onScale(Number(e.target.value))}
                className={numCls}
              />
              <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
            </label>
            <div className="flex items-center gap-1.5">
              <span className={`${labelCls} w-16`}>尺寸</span>
              <input
                type="number" min={1} max={MAX_PX} value={Math.round(ed.width)}
                title="宽度(编辑后按所选模式生效)"
                onChange={(e) => onSide(true, Number(e.target.value))}
                className={numCls}
              />
              <span className="text-[10px] text-neutral-500 dark:text-neutral-400">×</span>
              <input
                type="number" min={1} max={MAX_PX} value={Math.round(ed.height)}
                title="高度(编辑后按所选模式生效)"
                onChange={(e) => onSide(false, Number(e.target.value))}
                className={numCls}
              />
              <span className="text-[10px] text-neutral-500 dark:text-neutral-400">px</span>
              <label className="flex items-center gap-1 ml-1" title="改一边时另一边按源纵横比">
                <input type="checkbox" checked={ed.lockAspect} onChange={(e) => patch({ lockAspect: e.target.checked })} className={checkbox} />
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">约束比例</span>
              </label>
            </div>
            <label className="flex items-center gap-1.5">
              <span className={`${labelCls} w-16`}>重新采样</span>
              <EditorSelect
                value={ed.resample}
                onChange={(v) => patch({ resample: v })}
                className="flex-1"
                options={RESAMPLE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
              />
            </label>
            <div className={`text-[10px] mt-0.5 ${icoOversize ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400'}`}>
              {target
                ? `${Math.round(target.w)} × ${Math.round(target.h)} px${icoOversize ? ' — ICO 上限 256 × 256 像素,请减小导出比例' : ''}`
                : '… × … px'}
            </div>
          </div>
          {/* 右列:预览 + 估计(上游 preview + estimate) */}
          <div className="w-[300px] shrink-0 flex flex-col gap-1.5">
            <div className={sectionCls}>预览</div>
            <div
              className="w-[300px] h-[300px] flex items-center justify-center overflow-hidden rounded border border-black/10 dark:border-white/10"
              style={{ background: 'repeating-conic-gradient(#c8c8c8 0% 25%, #ffffff 0% 50%) 50% / 16px 16px' }}
            >
              {preview ? (
                <canvas
                  ref={canvasRef}
                  className="max-w-full max-h-full"
                  style={ed.resample === 'nearest' ? { imageRendering: 'pixelated' } : undefined}
                />
              ) : (
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">…</span>
              )}
            </div>
            <div className="text-[10px] text-neutral-500 dark:text-neutral-400" title={estimate?.exact ? '精确值(全量编码)' : '按代理折算的近似值'}>
              {FORMAT_ZH[ed.format] ?? ed.format.toUpperCase()}  ≈ {estimate ? humanBytes(estimate.bytes) : '…'}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-1.5 pt-1 shrink-0">
          <button
            onClick={() => closeExportDialog(tabId, false)}
            className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
          >
            取消
          </button>
          <button
            onClick={() => {
              if (docId == null) return;
              void confirmExportDialog(tabId);
            }}
            className="px-3 py-0.5 rounded text-[11px] bg-sky-600 text-white hover:bg-sky-500"
          >
            导出
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
