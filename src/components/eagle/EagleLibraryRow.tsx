import React from 'react';
import { AlertTriangle, ArrowRight, FolderOpen, Loader2 } from 'lucide-react';
import type { PixcallRootRelation } from '../../api/tauri-bridge';
import { libraryDisplayName } from '../../utils/pixcallReport';
import EagleLogo from './EagleLogo';

/**
 * Eagle 库的一行展示。**结构与样式照抄 PixcallLibraryRow**（调研 §13.7：v4.13 口径，
 * 与 PixCall 同一张列表、同构同宽），只换标识与 i18n 命名空间：
 * - Eagle 的库是一个 `*.library` 目录本身（如 `C:\...\Test.library`）；
 * - 徽章 / 悬停路径 / 两态占位等全部规则照搬，不另起一套。
 *
 * 传 `onClick` 就是动作行（点了从该库导入），不传是纯展示行。
 */

interface Props {
  root: string;
  /** 与当前打开的库同目录（两个根重合） */
  isCurrent?: boolean;
  onClick?: () => void;
  /** 这一行正在处理：图标换转圈、禁用点击 */
  busy?: boolean;
  disabled?: boolean;
  /** 图标位换 Eagle 标记；默认是文件夹图标 */
  sourceIcon?: boolean;
  /** 与资源根的位置关系。`outside` 时导入会先切根，卡内要提前说明 */
  relation?: PixcallRootRelation;
  t: (key: string) => string;
}

const EagleLibraryRow: React.FC<Props> = ({
  root,
  isCurrent,
  onClick,
  busy,
  disabled,
  sourceIcon,
  relation,
  t,
}) => {
  const name = libraryDisplayName(root);
  const boxed = !!onClick;
  // 悬停时整卡让位给路径（与 PixCall 同一规则：路径横贯全宽，图标留不住）
  const pathInset = boxed ? 'left-3 right-8' : 'left-0 right-0';
  const fade = 'transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0';
  const showHint = relation === 'outside';

  /** 关系徽章：inside 与 outside 各一枚，same 走既有的「当前库」（isCurrent）。 */
  const relationBadge = relation === 'inside' ? (
    <span
      data-testid="eagle-library-inside-badge"
      title={t('eagle.libraryInsideRoot')}
      className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
    >
      {t('eagle.libraryInsideRoot')}
    </span>
  ) : showHint ? (
    <span
      data-testid="eagle-library-switch-badge"
      className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
    >
      {t('eagle.libraryWillSwitch')}
    </span>
  ) : null;

  const content = (
    <>
      {/* 第一行：图标 + 文件夹名 + 徽章 + 箭头。提示行使卡片变两行，故外层改成纵向 */}
      <div className={`flex w-full min-w-0 items-center gap-2.5 ${fade}`}>
        {/* 行首图标不铺底方块；22px 比标题行的 28px 小一档，层级靠尺寸分 */}
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center text-blue-600 dark:text-blue-300 ${fade}`}
        >
          {sourceIcon ? (
            <EagleLogo size={22} />
          ) : busy ? (
            <Loader2 size={22} className="animate-spin" />
          ) : (
            <FolderOpen size={22} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{name}</span>
          {isCurrent && (
            <span className="shrink-0 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-300">
              {t('eagle.currentLibrary')}
            </span>
          )}
          {relationBadge}
        </span>
        {boxed && !busy && (
          <ArrowRight
            size={14}
            className="shrink-0 text-gray-400 opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-70 dark:text-gray-500"
          />
        )}
      </div>

      {/* 第二行（只在 outside）：卡内说明。与第一行一起淡出，悬停时让位给完整路径 */}
      {showHint && (
        <p
          data-testid="eagle-library-outside-hint"
          className={`mt-1 flex items-start gap-1.5 pl-[34px] text-[11px] leading-snug text-amber-700 dark:text-amber-400 ${fade}`}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{t('eagle.libraryOutsideRoot')}</span>
        </p>
      )}

      <span
        data-testid="eagle-library-path"
        className={`pointer-events-none absolute inset-y-0 flex items-center truncate font-mono text-[11px] text-gray-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-gray-400 ${pathInset}`}
      >
        {root}
      </span>
    </>
  );

  // 两行布局：第一行自己管排列，外层只负责纵向堆叠（提示行要跟在卡片**内部**）
  const stackClass = 'group relative flex w-full flex-col';

  if (!onClick) {
    return (
      <div data-testid="eagle-library-row" className={stackClass}>
        {content}
      </div>
    );
  }

  return (
    <button
      data-testid="eagle-library-row"
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`${stackClass} rounded-lg bg-white px-3 py-2 text-left ring-1 ring-transparent transition-all hover:bg-blue-50/70 hover:ring-blue-400/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white disabled:hover:ring-transparent dark:bg-black/20 dark:hover:bg-blue-500/10 dark:disabled:hover:bg-black/20`}
    >
      {content}
    </button>
  );
};

export default EagleLibraryRow;
