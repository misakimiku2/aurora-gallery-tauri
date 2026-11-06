/**
 * 形状数值对话框(二期 二-1,上游 shape_dialog):点击形状工具弹出,按数值创建。
 * Enter=确定 / Esc=取消(画布键盘已接管,此处只做输入框内回车提交);字段按 kind 增减:
 * rectangle=宽高+圆角(联动/四角)+从中心;ellipse=宽高+从中心;triangle=宽高+从中心;
 * polygon=宽高+边数+星形比率+从中心。偏好按 kind 记 localStorage(上游 prefs.dialogs)。
 */
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { closeShapeDialog, confirmShapeDialog, getSession, runCommand, showEditorNotice, updateShapeDialog } from './editorStore';
import { shapeDialogGeometry, shapeFillStroke, SHAPE_DIALOG_MAX_PX } from './toolLogic';

const KIND_TITLE: Record<string, string> = {
  rectangle: '创建矩形',
  ellipse: '创建椭圆',
  triangle: '创建三角形',
  polygon: '创建多边形',
};

export const ShapeDialog: React.FC<{ tabId: string }> = ({ tabId }) => {
  const s = getSession(tabId);
  const dlg = s?.shapeDialog;
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstRef.current?.select();
  }, []);

  if (!s || !dlg || !s.state) return null;
  const num = (v: number | undefined): string => (v == null || !Number.isFinite(v) ? '' : String(Math.round(v * 1000) / 1000));
  const parse = (v: string): number | undefined => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const field = 'w-28 px-2 py-1 text-sm rounded-md border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none focus:border-sky-500';
  const label = 'w-20 text-right text-xs text-gray-500 dark:text-neutral-400';

  const ok = () => {
    // confirmShapeDialog=记忆偏好+关闭,返回落盘前状态(与画布 Enter 路径同流)
    const st = confirmShapeDialog(tabId);
    if (!st || !s.state) return;
    const [geom, err] = shapeDialogGeometry(st.kind, st.at, st);
    if (!geom || err) {
      if (err) showEditorNotice(`形状创建失败:${err}`);
      return;
    }
    const { fill, stroke } = shapeFillStroke(s.options, s.state.foreground, s.state.background);
    void runCommand(tabId, 'shape.create', { ...geom, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) })
      .catch((e) => console.error('[editor] shape.create 失败', e));
  };

  return createPortal(
    <div className="fixed inset-0 z-[600] flex items-center justify-center p-4" onKeyDown={(e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        ok();
      }
    }}>
      <div className="absolute inset-0 bg-black/30" onClick={() => closeShapeDialog(tabId)} />
      <div className="relative w-72 rounded-lg bg-surface border border-black/10 dark:border-white/15 shadow-xl p-4 select-none">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-3">{KIND_TITLE[dlg.kind]}</div>
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className={label}>宽度(px)</span>
            <input ref={firstRef} type="number" min={1} max={SHAPE_DIALOG_MAX_PX} className={field}
              value={num(dlg.width)} onChange={(e) => updateShapeDialog(tabId, { width: parse(e.target.value) ?? dlg.width })} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={label}>高度(px)</span>
            <input type="number" min={1} max={SHAPE_DIALOG_MAX_PX} className={field}
              value={num(dlg.height)} onChange={(e) => updateShapeDialog(tabId, { height: parse(e.target.value) ?? dlg.height })} />
          </div>
          {dlg.kind === 'rectangle' && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>半径(px)</span>
                <input type="number" min={0} className={field} value={num(dlg.radii?.[0] ?? 0)}
                  onChange={(e) => {
                    const r = Math.max(0, parse(e.target.value) ?? 0);
                    updateShapeDialog(tabId, { radii: [r, r, r, r], linkRadii: true });
                  }} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>四角独立</span>
                <input type="checkbox" checked={dlg.linkRadii === false} className="w-4 h-4 accent-sky-600"
                  onChange={(e) => updateShapeDialog(tabId, { linkRadii: !e.target.checked })} />
              </div>
              {dlg.linkRadii === false && (
                <div className="flex items-center justify-between gap-2">
                  <span className={label}>四角半径</span>
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <input key={i} type="number" min={0} className="w-14 px-1.5 py-1 text-xs rounded-md border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none"
                        value={num(dlg.radii?.[i] ?? 0)}
                        onChange={(e) => {
                          const r = Math.max(0, parse(e.target.value) ?? 0);
                          const radii = [...(dlg.radii ?? [0, 0, 0, 0])] as [number, number, number, number];
                          radii[i] = r;
                          updateShapeDialog(tabId, { radii });
                        }} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {dlg.kind === 'polygon' && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>边数</span>
                <input type="number" min={3} max={100} className={field} value={num(dlg.sides ?? 5)}
                  onChange={(e) => updateShapeDialog(tabId, { sides: parse(e.target.value) ?? dlg.sides })} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>星形比率(%)</span>
                <input type="number" min={1} max={100} className={field} value={num(dlg.starRatio ?? 100)}
                  onChange={(e) => updateShapeDialog(tabId, { starRatio: parse(e.target.value) ?? dlg.starRatio })} />
              </div>
            </>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className={label}>从中心</span>
            <input type="checkbox" checked={dlg.fromCenter} className="w-4 h-4 accent-sky-600"
              onChange={(e) => updateShapeDialog(tabId, { fromCenter: e.target.checked })} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => closeShapeDialog(tabId)}
            className="px-3 py-1.5 text-xs rounded-md border border-subtle text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/10">取消</button>
          <button onClick={ok}
            className="px-3 py-1.5 text-xs rounded-md bg-sky-600 text-white hover:bg-sky-500">确定</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
