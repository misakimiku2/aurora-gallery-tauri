/**
 * 编辑器统一自定义下拉(毛玻璃 portal 弹层,裁剪比例/渐变预设菜单同风格)。
 * 替代原生 <select>:原生控件跟随系统主题、与整体设计不一致(用户拍板统一)。
 * 按钮样式默认选项条规格,宽度等可经 className 覆盖;弹层外点关闭、
 * useLayoutEffect 钳进视口;打开期间 capture 阶段独占键盘(Esc 关、其余键吞,
 * 不落进画布全局键);支持 optgroup 式分组(group 变化处插组头)。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface EditorSelectOption {
  value: string;
  label: string;
  /** 分组名(同名的连续项归入同一组头;省略=不分组)。 */
  group?: string;
}

export const EditorSelect: React.FC<{
  value: string;
  options: readonly EditorSelectOption[];
  onChange: (v: string) => void;
  /** 追加到按钮的类(宽度/高度随现场;默认选项条 h-6 规格)。 */
  className?: string;
  title?: string;
  disabled?: boolean;
  /** 选中后回显归零恒显 blankLabel(上游 ComboBox 恒显 Custom 口径)。 */
  alwaysBlank?: boolean;
  blankLabel?: string;
  /** 弹层顶部加过滤输入框(长列表:字体目录上千项)。 */
  searchable?: boolean;
}> = ({ value, options, onChange, className = '', title, disabled, alwaysBlank, blankLabel = '预设…', searchable }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [query, setQuery] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      // 按钮与菜单内部的 mousedown 不关(否则菜单在 click 到达前被卸载,选项点击丢失)
      if (btnRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  // 打开期间 capture 阶段独占键盘:Esc 关弹层,其余键吞掉(不进画布全局键/对话框键)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(pos.left, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(pos.top, window.innerHeight - r.height - 4))}px`;
  }, [open, pos]);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 2 });
    setQuery('');
    setOpen(true);
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
  };
  const current = options.find((o) => o.value === value);
  const label = alwaysBlank ? blankLabel : current?.label ?? value;
  const ql = query.trim().toLowerCase();
  const shownOptions = ql ? options.filter((o) => o.label.toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql)) : options;
  const rows: React.ReactNode[] = [];
  if (searchable) {
    rows.push(
      <div key="search" className="px-2 pb-1">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && shownOptions.length) {
              onChange(shownOptions[0].value);
              setOpen(false);
            }
          }}
          placeholder="过滤…"
          className="w-full px-2 py-1 text-[12px] rounded border border-black/15 dark:border-white/15 bg-transparent outline-none focus:border-sky-500"
        />
      </div>,
    );
  }
  let lastGroup: string | undefined;
  for (const o of shownOptions) {
    if (o.group !== lastGroup) {
      rows.push(
        <div key={`g:${o.group ?? ''}:${o.value}`} className="px-3 pt-1.5 pb-0.5 text-[10px] text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
          {o.group}
        </div>,
      );
      lastGroup = o.group;
    }
    rows.push(
      <div
        key={o.value}
        className="mx-1.5 px-3 py-1.5 rounded hover:bg-blue-600 hover:text-white cursor-pointer whitespace-nowrap text-[12px] flex items-center gap-2"
        onClick={() => {
          onChange(o.value);
          setOpen(false);
        }}
      >
        <span>{o.label}</span>
        {o.value === value && <Check size={12} className="ml-auto opacity-80" />}
      </div>,
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`inline-flex items-center gap-1 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1.5 text-[11px] text-gray-800 dark:text-neutral-200 min-w-0 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0 opacity-60" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[1000] rounded-md bg-[#FAFAFA]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 py-1.5 w-max max-h-[70vh] overflow-y-auto"
            style={{ minWidth: btnRef.current?.getBoundingClientRect().width }}
          >
            {rows}
          </div>,
          document.body,
        )}
    </>
  );
};
