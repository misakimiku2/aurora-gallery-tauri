import { MigrationReport } from '../api/tauri-bridge';

/**
 * PixCall 迁移报告的文案口径（设计方案 §4.7 / §6.1）。
 *
 * welcome 卡片的结果行与设置-存储面板的报告展开区共用这一套，两处措辞不许各写一遍。
 */

/** 现有 i18n 没有插值引擎，靠调用方 replace（与 StoragePanel 的 {count} 用法一致） */
export const fillTemplate = (text: string, pairs: Record<string, string | number>): string =>
  Object.entries(pairs).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    text
  );

/**
 * §4.7 各栏压成一句话。
 *
 * 「跳过 N 项已有内容」这一栏不能省：本机 PixCall 有 5 条夹子备注、实际只写进 4 条
 * （NTE 夹我们侧已有内容必须让位），没有这栏在验收时就像丢了数据。
 */
export const buildPixcallSummary = (report: MigrationReport, t: (key: string) => string): string => {
  const parts = [
    fillTemplate(t('import.summary'), {
      tags: report.tagsUnioned,
      words: report.tagsWordsAdded,
      desc: report.descriptionsWritten,
      links: report.sourceUrlsWritten,
      topics: report.topicsCreated,
      files: report.topicFilesAdded,
    }),
  ];
  const yielded = report.descriptionsSkippedExisting + report.sourceUrlsSkippedExisting;
  if (yielded > 0) parts.push(fillTemplate(t('import.skippedExisting'), { count: yielded }));
  // v4.9 拍板：同名不新建、成员并进去。这一栏要说出来，否则「专题 0 个」会被读成没动静
  if (report.topicsMergedName > 0)
    parts.push(fillTemplate(t('import.mergedTopics'), { count: report.topicsMergedName }));
  if (report.unmatched > 0) parts.push(fillTemplate(t('import.unmatched'), { count: report.unmatched }));
  // v4.5 拍板 A：welcome 卡片只给计数，名字明细在设置面板的导入详情里
  if (report.excludedTrash > 0) {
    parts.push(fillTemplate(t('import.trashSkipped'), { count: report.excludedTrash }));
  }
  // §4.9 第 2 条：搁置的视频标注要在文案里明说，不是静默丢弃
  if (report.skippedUnsupportedType > 0) {
    parts.push(fillTemplate(t('import.videoParked'), { count: report.skippedUnsupportedType }));
  }
  return parts.join(' · ');
};

/** 报告里到底有没有真写进东西（决定结果行显示摘要还是「未发现可迁移的标注」） */
export const reportHasWrites = (report: MigrationReport): boolean =>
  report.tagsUnioned + report.descriptionsWritten + report.sourceUrlsWritten + report.topicsCreated > 0;
