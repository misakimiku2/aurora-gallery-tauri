import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { MigrationReport } from '../../api/tauri-bridge';
import {
  buildReportDetails,
  buildReportNotes,
  buildReportStats,
  fillTemplate,
} from '../../utils/pixcallReport';

/**
 * 迁移报告的呈现（设计方案 §4.7）：数字徽章在上，短备注在下。
 *
 * welcome 卡片与设置-存储面板共用这一份，两处措辞与栏位不许各写一遍。
 * `dense` 给 welcome：向导第 1 步的高度是死的，备注压成一行点号分隔的短句，徽章收小一号。
 * `detailed` 只在设置面板打开：回收站实文件的名字与规则外状态（warnings）按 v4.5 拍板 A
 * 不在向导里铺开，但那两栏必须在设置里逐条可见，否则「跳过了什么」查不到。
 */

interface Props {
  report: MigrationReport;
  t: (key: string) => string;
  dense?: boolean;
  detailed?: boolean;
}

const PixcallReportView: React.FC<Props> = ({ report, t, dense, detailed }) => {
  const stats = buildReportStats(report, t);
  const details = detailed ? buildReportDetails(report, t) : [];
  // 备注与「只在展开区多给的几行」同属一句话级别的补充，合成一列读，不分两层
  const lines: Array<{ text: string; hint?: string }> = [
    ...buildReportNotes(report, t),
    ...details.map(detail => ({ text: detail })),
  ];
  const chip = dense
    ? 'rounded-md px-1.5 py-0.5 text-[11px]'
    : 'rounded-lg px-2 py-1 text-xs';

  return (
    <div>
      <div className={`flex flex-wrap ${dense ? 'gap-1' : 'gap-1.5'}`}>
        {stats.map(stat => (
          <span
            key={stat.label}
            className={`inline-flex items-baseline gap-1.5 bg-blue-50 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300 ${chip}`}
          >
            <span className="opacity-70">{stat.label}</span>
            <span className="font-semibold tabular-nums">{stat.value}</span>
          </span>
        ))}
      </div>

      {lines.length > 0 &&
        (dense ? (
          <p className="mt-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            {lines.map((line, index) => (
              <span key={line.text} title={line.hint}>
                {index > 0 && <span className="mx-1 opacity-50">·</span>}
                {line.text}
              </span>
            ))}
          </p>
        ) : (
          <ul className="mt-2.5 space-y-1">
            {lines.map(line => (
              <li
                key={line.text}
                title={line.hint}
                className="flex items-start gap-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400"
              >
                {line.hint && <Info size={12} className="mt-0.5 shrink-0 opacity-60" />}
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        ))}

      {detailed && report.excludedTrashNames.length > 0 && (
        <div className="mt-3 rounded-lg border border-subtle bg-white px-3 py-2 dark:bg-black/20">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {t('import.trashDetail')}
          </div>
          <ul className="mt-1 space-y-0.5">
            {report.excludedTrashNames.map(item => (
              <li key={item.name} className="truncate text-xs text-gray-500 dark:text-gray-400">
                {item.name}
                {item.originFolder && (
                  <span className="ml-1.5 opacity-70">
                    {fillTemplate(t('import.trashOrigin'), { folder: item.originFolder })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detailed && report.warnings.length > 0 && (
        <div className="mt-3 rounded-lg border border-subtle bg-white px-3 py-2 dark:bg-black/20">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            <AlertTriangle size={11} />
            {t('import.warningsDetail')}
          </div>
          <ul className="mt-1 space-y-0.5">
            {report.warnings.map((warning, index) => (
              <li key={index} className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default PixcallReportView;
