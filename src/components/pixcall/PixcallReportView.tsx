import React from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { MigrationReport } from '../../api/tauri-bridge';
import {
  buildEmptyResult,
  buildReportDetails,
  buildReportNotes,
  buildReportStats,
  fillTemplate,
  isRootMismatch,
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
  const lines: Array<{ text: string; hint?: string; danger?: boolean }> = [
    ...buildReportNotes(report, t),
    ...details.map(detail => ({ text: detail })),
  ];
  // 说明性的走同一列；要人动手纠正的（根不对）单独提一行琥珀色，别混在灰字里读过去
  const plain = lines.filter(line => !line.danger);
  const alerts = lines.filter(line => line.danger);
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

      {plain.length > 0 &&
        (dense ? (
          <p className="mt-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            {plain.map((line, index) => (
              <span key={line.text} title={line.hint}>
                {index > 0 && <span className="mx-1 opacity-50">·</span>}
                {line.text}
              </span>
            ))}
          </p>
        ) : (
          <ul className="mt-2.5 space-y-1">
            {plain.map(line => (
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

      {alerts.map(alert => (
        <p
          key={alert.text}
          className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
        >
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{alert.text}</span>
        </p>
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

      {/* Eagle 期新增栏（调研 §13.7 H2）：未命中的源条目名明细。PixCall 期的报告没有
          unmatchedItems 这栏（undefined）→ 整块不渲染，展示行为对 PixCall 零变化。 */}
      {detailed && report.unmatchedItems && report.unmatchedItems.length > 0 && (
        <div className="mt-3 rounded-lg border border-subtle bg-white px-3 py-2 dark:bg-black/20">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {t('import.unmatchedItems')}
          </div>
          <ul className="mt-1 space-y-0.5">
            {report.unmatchedItems.map((item, index) => (
              <li key={index} className="truncate text-xs text-gray-500 dark:text-gray-400" title={item}>
                {item}
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

/**
 * 「这次什么都没落」那一行。根不对的情况不能说成「没有可迁移的标注」——
 * 那会让人以为 PixCall 里没有东西，而实际是我们没扫到那些文件。
 */
export const PixcallEmptyResult: React.FC<{ report: MigrationReport; t: (key: string) => string }> = ({
  report,
  t,
}) => {
  const mismatch = isRootMismatch(report);
  return (
    <p
      className={`flex items-start gap-1.5 text-xs leading-relaxed ${
        mismatch ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'
      }`}
    >
      {mismatch && <AlertCircle size={12} className="mt-0.5 shrink-0" />}
      <span>{buildEmptyResult(report, t)}</span>
    </p>
  );
};

export default PixcallReportView;
