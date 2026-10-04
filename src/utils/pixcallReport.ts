import { MigrationReport } from '../api/tauri-bridge';

/**
 * PixCall 迁移报告的文案口径（设计方案 §4.7 / §6.1）。
 *
 * welcome 卡片的结果区与设置-存储面板的报告展开区共用这一套，两处措辞不许各写一遍。
 * 呈现形态是「徽章 + 短备注」而不是长句：验收要的栏位一个不少，但读起来是一眼扫完的数字，
 * 不是一行用 · 串起来的段落。
 */

/** 现有 i18n 没有插值引擎，靠调用方 fillTemplate（与 StoragePanel 的 {count} 用法一致） */
export const fillTemplate = (text: string, pairs: Record<string, string | number>): string =>
  Object.entries(pairs).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    text
  );

/**
 * 库根 → 展示用的文件夹名。完整路径只在悬停时出现（见 PixcallLibraryRow），
 * 因为 `D:\资源` 这种串按钮里一排摆着既读不出重点，也撑破布局。
 */
export const libraryDisplayName = (root: string): string => {
  const segments = root.split(/[\\/]+/).filter(Boolean);
  // 盘符根（`D:\`）只剩一段时直接回原文，否则「D:」孤零零不如整串清楚
  return segments.length > 1 ? segments[segments.length - 1] : root;
};

/** §4.7 的计数栏 → 界面上的数字徽章（0 的不显示，全 0 时由 reportHasWrites 走「没有可迁移」） */
export interface ReportStat {
  label: string;
  value: number;
}

export const buildReportStats = (report: MigrationReport, t: (key: string) => string): ReportStat[] => {
  const stats: ReportStat[] = [
    { label: t('import.statTags'), value: report.tagsUnioned },
    { label: t('import.statDescriptions'), value: report.descriptionsWritten },
    { label: t('import.statLinks'), value: report.sourceUrlsWritten },
    // 并入已有专题也算「这次动过的专题」，否则新建 0 会被读成没动静（§10 偏差 12）
    { label: t('import.statTopics'), value: report.topicsCreated + report.topicsMergedName },
    { label: t('import.statFiles'), value: report.topicFilesAdded },
  ];
  return stats.filter(stat => stat.value > 0);
};

/**
 * 「一条标注都没落上，却有路径没命中」——这基本就是资源根没覆盖到那些文件（§6.3）。
 * 光报一个「未匹配 N 条」不指出出路，用户会以为迁移坏了。
 */
export const isRootMismatch = (report: MigrationReport): boolean => report.matched === 0 && report.unmatched > 0;

/** 结果区那句「这次什么都没落」到底怎么说：根不对时不能说成「没有可迁移的标注」 */
export const buildEmptyResult = (report: MigrationReport, t: (key: string) => string): string =>
  isRootMismatch(report)
    ? fillTemplate(t('import.unmatchedRootHint'), { count: report.unmatched })
    : t('import.nothingFound');

/**
 * 徽章之下的短备注。
 *
 * 「已有内容 N 项未覆盖」这一栏不能省：本机 PixCall 有 5 条夹子备注、实际只写进 4 条
 * （NTE 夹我们侧已有内容必须让位），没有它就像丢了数据。
 * `hint` 挂到悬停提示上——要交代的后果留着，但不占版面。
 *
 * 来源网址单列一栏（P1(b)）：它现在是**追加**，命中「已有」的意思是
 * 「这条我们本来就有，不重复加」，跟描述那种「让位不覆盖」不是一回事，不能并成一句。
 */
export interface ReportNote {
  text: string;
  hint?: string;
  /** 需要人动手纠正的（根不对那类），底色从灰提到琥珀，别混在说明文字里 */
  danger?: boolean;
}

export const buildReportNotes = (report: MigrationReport, t: (key: string) => string): ReportNote[] => {
  const notes: ReportNote[] = [];
  if (report.descriptionsSkippedExisting > 0)
    notes.push({ text: fillTemplate(t('import.noteExisting'), { count: report.descriptionsSkippedExisting }) });
  // 来源网址：新增优先。徽章里那个「来源 N」是新增数，但备注如果只说「N 条已有」，
  // 用户读到的是「什么都没加」——本机实测（2 条已有 + 源侧 1 条新）就是这么被误读的。
  // 所以有新值时把「新增」写进同一句；没有新增时才单说「已有」。
  if (report.sourceUrlsWritten > 0 && report.sourceUrlsSkippedExisting > 0)
    notes.push({
      text: fillTemplate(t('import.noteLinksAdded'), {
        added: report.sourceUrlsWritten,
        existing: report.sourceUrlsSkippedExisting,
      }),
    });
  else if (report.sourceUrlsWritten === 0 && report.sourceUrlsSkippedExisting > 0)
    notes.push({ text: fillTemplate(t('import.noteLinksExisting'), { count: report.sourceUrlsSkippedExisting }) });
  if (report.topicsMergedName > 0)
    notes.push({ text: fillTemplate(t('import.noteMerged'), { count: report.topicsMergedName }) });
  if (report.unmatched > 0) {
    notes.push(
      isRootMismatch(report)
        ? { text: fillTemplate(t('import.unmatchedRootHint'), { count: report.unmatched }), danger: true }
        : {
            text: fillTemplate(t('import.noteUnmatched'), { count: report.unmatched }),
            hint: t('import.noteUnmatchedHint'),
          }
    );
  }
  // v4.5 拍板 A：welcome 只给计数，名字明细在设置面板的展开区
  if (report.excludedTrash > 0)
    notes.push({ text: fillTemplate(t('import.noteTrash'), { count: report.excludedTrash }) });
  // §4.9 第 2 条：搁置的视频标注要说出来，不是静默丢弃
  if (report.skippedUnsupportedType > 0)
    notes.push({
      text: fillTemplate(t('import.noteVideo'), { count: report.skippedUnsupportedType }),
      hint: t('import.noteVideoHint'),
    });
  return notes;
};

/** 展开区多给的一行细节：welcome 版面窄，这些留在设置里 */
export const buildReportDetails = (report: MigrationReport, t: (key: string) => string): string[] => {
  const details: string[] = [];
  if (report.tagsWordsAdded > 0)
    details.push(fillTemplate(t('import.noteWords'), { count: report.tagsWordsAdded }));
  if (report.topicsMaterialized > 0)
    details.push(fillTemplate(t('import.noteMaterialized'), { count: report.topicsMaterialized }));
  if (report.topicsCovered > 0)
    details.push(fillTemplate(t('import.noteCovered'), { count: report.topicsCovered }));
  return details;
};

/** 报告里到底有没有真写进东西（决定结果显示摘要还是「没有可迁移的标注」） */
export const reportHasWrites = (report: MigrationReport): boolean =>
  report.tagsUnioned +
    report.descriptionsWritten +
    report.sourceUrlsWritten +
    report.topicsCreated +
    report.topicsMergedName +
    report.topicsCovered >
  0;
