import React from 'react';
import { ArrowRight, FolderOpen, Loader2 } from 'lucide-react';
import { libraryDisplayName } from '../../utils/pixcallReport';
import PixcallLogo from './PixcallLogo';

/**
 * PixCall 库的一行展示（设计方案 §6.1 第 3/4 条的「多库给选择列表」）。
 *
 * 只印文件夹名：`C:\Users\Misaki\Videos\NVIDIA` 这类整串路径在按钮里既读不出重点，
 * 也会把卡片撑破。悬停（和键盘聚焦）时整行的图标与名字让位，路径横贯全宽
 * ——向导那一列只有 ~240px，图标留着会把路径截成「C:\Users\Misaki\Videos\N…」。
 * 两种状态占同一块版面，行高不随悬停变化。
 *
 * 传 `onClick` 就是动作行（点了从该库导入），不传是纯展示行（welcome 跑起来之后）。
 */

interface Props {
  root: string;
  /** 与当前打开的库同目录（§6.3 的两个根重合） */
  isCurrent?: boolean;
  onClick?: () => void;
  /** 这一行正在处理：图标换转圈、禁用点击 */
  busy?: boolean;
  disabled?: boolean;
  /** 图标位换 PixCall 标记（welcome 那张卡片没有别的品牌位）；默认是文件夹图标 */
  sourceIcon?: boolean;
  t: (key: string) => string;
}

const PixcallLibraryRow: React.FC<Props> = ({ root, isCurrent, onClick, busy, disabled, sourceIcon, t }) => {
  const name = libraryDisplayName(root);
  const boxed = !!onClick;
  // 悬停时整行让位给路径：向导那一列只有 ~240px，图标留着就把路径挤断了
  const pathInset = boxed ? 'left-3 right-8' : 'left-0 right-0';
  const fade = 'transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0';

  const content = (
    <>
      {/* 行首图标不铺底方块；22px 比标题行的 28px 小一档，层级靠尺寸分 */}
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center text-blue-600 dark:text-blue-300 ${fade}`}
      >
        {sourceIcon ? (
          <PixcallLogo size={22} />
        ) : busy ? (
          <Loader2 size={22} className="animate-spin" />
        ) : (
          <FolderOpen size={22} />
        )}
      </span>
      <span className={`flex min-w-0 flex-1 items-center gap-2 ${fade}`}>
        <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{name}</span>
        {isCurrent && (
          <span className="shrink-0 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-300">
            {t('import.currentLibrary')}
          </span>
        )}
      </span>
      {boxed && !busy && (
        <ArrowRight
          size={14}
          className="shrink-0 text-gray-400 opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-70 dark:text-gray-500"
        />
      )}
      <span
        data-testid="pixcall-library-path"
        className={`pointer-events-none absolute inset-y-0 flex items-center truncate font-mono text-[11px] text-gray-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-gray-400 ${pathInset}`}
      >
        {root}
      </span>
    </>
  );

  if (!onClick) {
    return (
      <div data-testid="pixcall-library-row" className="group relative flex items-center gap-2.5">
        {content}
      </div>
    );
  }

  return (
    <button
      data-testid="pixcall-library-row"
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="group relative flex w-full items-center gap-2.5 rounded-lg bg-white px-3 py-2 text-left ring-1 ring-transparent transition-all hover:bg-blue-50/70 hover:ring-blue-400/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white disabled:hover:ring-transparent dark:bg-black/20 dark:hover:bg-blue-500/10 dark:disabled:hover:bg-black/20"
    >
      {content}
    </button>
  );
};

export default PixcallLibraryRow;
