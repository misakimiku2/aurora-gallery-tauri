import { describe, it, expect } from 'vitest';
import {
  buildReportNotes,
  buildReportStats,
  libraryDisplayName,
  reportHasWrites,
} from '../pixcallReport';
import type { MigrationReport } from '../../api/tauri-bridge';

// 插值靠模板字符串，测试里给几条真模板，其余键原样回显
const templates: Record<string, string> = {
  'import.statTags': '标签',
  'import.statDescriptions': '描述',
  'import.noteExisting': '已有内容 {count} 项未覆盖',
  'import.noteTrash': '回收站 {count} 条未迁（仍在 PixCall 中）',
  'import.noteVideo': '视频标注 {count} 条未导入',
  'import.noteVideoHint': '支持视频后重新导入即可补齐',
};
const t = (key: string) => templates[key] ?? key;

const makeReport = (overrides: Partial<MigrationReport> = {}): MigrationReport => ({
  matched: 13,
  tagsUnioned: 0,
  tagsWordsAdded: 0,
  descriptionsWritten: 0,
  descriptionsSkippedExisting: 0,
  sourceUrlsWritten: 0,
  sourceUrlsSkippedExisting: 0,
  topicsCreated: 0,
  topicFilesAdded: 0,
  topicsMergedName: 0,
  topicsCovered: 0,
  topicsMaterialized: 0,
  topicsSkippedUnverifiable: 0,
  topicsReparented: 0,
  skippedUnsupportedType: 0,
  annotatedUnsupported: 0,
  topicMembersSkippedType: 0,
  excludedTrash: 0,
  excludedTrashNames: [],
  unmatched: 0,
  unmatchedPaths: [],
  warnings: [],
  ...overrides,
});

describe('libraryDisplayName', () => {
  it('只留文件夹名，反斜杠与正斜杠都认', () => {
    expect(libraryDisplayName('D:\\资源')).toBe('资源');
    expect(libraryDisplayName('C:/Users/Misaki/Videos/NVIDIA')).toBe('NVIDIA');
  });

  it('尾部分隔符不算一段', () => {
    expect(libraryDisplayName('D:\\资源\\')).toBe('资源');
    expect(libraryDisplayName('D:/资源/')).toBe('资源');
  });

  it('盘符根与单段名退回整串——孤零零一个「D:」不如原样', () => {
    expect(libraryDisplayName('D:\\')).toBe('D:\\');
    expect(libraryDisplayName('C:/')).toBe('C:/');
    expect(libraryDisplayName('Pix')).toBe('Pix');
  });
});

describe('buildReportStats', () => {
  it('0 的栏位不显示，免得一排「来源 0」', () => {
    const stats = buildReportStats(makeReport({ tagsUnioned: 8, descriptionsWritten: 9 }), t);
    expect(stats).toEqual([
      { label: '标签', value: 8 },
      { label: '描述', value: 9 },
    ]);
  });

  it('并入已有专题也算这次动过的专题（§10 偏差 12：否则「专题 0」被读成没动静）', () => {
    const stats = buildReportStats(makeReport({ topicsCreated: 1, topicsMergedName: 2 }), t);
    const topics = stats.find(stat => stat.label === 'import.statTopics');
    expect(topics?.value).toBe(3);
  });
});

describe('buildReportNotes', () => {
  it('让位是描述与来源链接两栏之和（§10 偏差 3）', () => {
    const notes = buildReportNotes(
      makeReport({ descriptionsSkippedExisting: 1, sourceUrlsSkippedExisting: 2 }),
      t
    );
    expect(notes[0].text).toBe('已有内容 3 项未覆盖');
  });

  it('回收站与视频各一栏，视频的后果挂在悬停提示上（§4.9 第 2 条不许静默丢弃）', () => {
    const notes = buildReportNotes(makeReport({ excludedTrash: 1, skippedUnsupportedType: 52 }), t);
    expect(notes.map(note => note.text)).toEqual(['回收站 1 条未迁（仍在 PixCall 中）', '视频标注 52 条未导入']);
    expect(notes[1].hint).toBe('支持视频后重新导入即可补齐');
  });

  it('什么都没跳过时不给备注', () => {
    expect(buildReportNotes(makeReport({ tagsUnioned: 8 }), t)).toEqual([]);
  });
});

describe('reportHasWrites', () => {
  it('全 0 报告不算动过库', () => {
    expect(reportHasWrites(makeReport())).toBe(false);
  });

  it('只并入了成员、或只补了一张封面，也算动过库', () => {
    expect(reportHasWrites(makeReport({ topicsMergedName: 1 }))).toBe(true);
    expect(reportHasWrites(makeReport({ topicsCovered: 1 }))).toBe(true);
  });
});
