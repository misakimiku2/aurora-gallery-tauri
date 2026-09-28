import { renderHook, act } from '@testing-library/react';
import { useTags } from '../useTags';
import { dbUpsertFileMetadata } from '../../api/tauri-bridge';
import type { AppState, TabState } from '../../types';

vi.mock('../../api/tauri-bridge', () => ({
  dbUpsertFileMetadata: vi.fn().mockResolvedValue(undefined),
}));

const t = (k: string) => {
  const map: Record<string, string> = {
    'context.copied': '已复制',
    'context.tagsPasted': '已粘贴标签'
  };
  return map[k] || k;
};

const makeFile = (id: string, tags: string[], extra: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  name: `${id}.png`,
  type: 'file',
  path: `/root/${id}.png`,
  tags,
  ...extra
});

const makeState = (files: Record<string, unknown>, customTags: string[] = [], clipboardIds: string[] = ['a']) =>
  ({
    files,
    customTags,
    clipboard: { action: 'copy', items: { type: 'tag', ids: clipboardIds } },
    tabs: [],
    activeModal: { type: null }
  }) as unknown as AppState;

const activeTab = { selectedTagIds: [] } as unknown as TabState;

const setup = (initialState: AppState) => {
  let current = initialState;
  const setState = (updater: any) => {
    current = typeof updater === 'function' ? updater(current) : updater;
  };
  const showToast = vi.fn();
  const { result } = renderHook(
    ({ state }: { state: AppState }) =>
      useTags({
        state,
        setState,
        activeTab,
        t,
        showToast,
        groupedTags: {},
        closeContextMenu: () => {},
        updateActiveTab: () => {}
      }),
    { initialProps: { state: current } }
  );
  return { result, showToast };
};

describe('useTags persistence', () => {
  beforeEach(() => {
    vi.mocked(dbUpsertFileMetadata).mockClear();
    vi.mocked(dbUpsertFileMetadata).mockResolvedValue(undefined);
  });

  it('paste tags persists the full metadata row for every target file', async () => {
    const fileA = makeFile('a', ['old'], { description: 'desc-a', sourceUrl: 'http://s', category: 'general', aiData: { x: 1 } });
    const fileB = makeFile('b', [], { description: 'desc-b', sourceUrl: undefined, category: 'book', aiData: undefined });
    const { result, showToast } = setup(makeState({ a: fileA, b: fileB }, [], ['tag1', 'tag2']));

    await act(async () => {
      result.current.handlePasteTags(['a', 'b']);
    });

    expect(dbUpsertFileMetadata).toHaveBeenCalledTimes(2);
    expect(dbUpsertFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'a',
      path: '/root/a.png',
      tags: ['old', 'tag1', 'tag2'],
      description: 'desc-a',
      sourceUrl: 'http://s',
      category: 'general',
      aiData: { x: 1 },
      updatedAt: expect.any(Number)
    }));
    expect(dbUpsertFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'b',
      tags: ['tag1', 'tag2'],
      description: 'desc-b',
      category: 'book'
    }));
    expect(showToast).toHaveBeenCalledWith('已粘贴标签');
  });

  it('rename tag persists the full metadata row only for affected files', async () => {
    const affected = makeFile('a', ['old', 'keep'], { description: 'desc-a', aiData: { x: 1 } });
    const untouched = makeFile('b', ['other']);
    const { result } = setup(makeState({ a: affected, b: untouched }, ['old']));

    await act(async () => {
      result.current.handleRenameTag('old', 'new');
    });

    expect(dbUpsertFileMetadata).toHaveBeenCalledTimes(1);
    expect(dbUpsertFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'a',
      path: '/root/a.png',
      tags: ['new', 'keep'],
      description: 'desc-a',
      aiData: { x: 1 },
      updatedAt: expect.any(Number)
    }));
  });

  it('rename tag does not mutate the previous state objects in place', async () => {
    const affected = makeFile('a', ['old']);
    const files = { a: affected };
    const { result } = setup(makeState(files, ['old']));

    await act(async () => {
      result.current.handleRenameTag('old', 'new');
    });

    expect(affected.tags).toEqual(['old']);
  });

  it('rename with empty or unchanged name does not persist', async () => {
    const affected = makeFile('a', ['old']);
    const { result } = setup(makeState({ a: affected }, ['old']));

    await act(async () => {
      result.current.handleRenameTag('old', '  ');
      result.current.handleRenameTag('old', 'old');
    });

    expect(dbUpsertFileMetadata).not.toHaveBeenCalled();
  });

  it('delete tags keeps persisting affected files', async () => {
    const affected = makeFile('a', ['gone', 'keep'], { description: 'desc-a' });
    const { result } = setup(makeState({ a: affected }, ['gone']));

    await act(async () => {
      result.current.handleConfirmDeleteTags(['gone']);
    });

    expect(dbUpsertFileMetadata).toHaveBeenCalledTimes(1);
    expect(dbUpsertFileMetadata).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'a',
      tags: ['keep'],
      description: 'desc-a'
    }));
  });
});
