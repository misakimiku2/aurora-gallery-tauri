import { useState, type RefObject } from 'react';
import { Tag, X, Check, FileText, Save, Globe, ExternalLink, Pencil } from 'lucide-react';
import { FileNode, FileType } from '../../types';
import { getSourceUrls } from '../../utils/sourceUrls';

interface EditSectionProps {
    isMulti: boolean;
    file: FileNode | null;
    files: Record<string, FileNode>;
    selectedFileIds: string[];
    // Tags
    newTagInput: string;
    onNewTagInputChange: (value: string) => void;
    systemTags: string[];
    onAddTag: (tag: string) => void;
    onRemoveTag: (tag: string) => void;
    onNavigateToTag: (tag: string) => void;
    // Description
    desc: string;
    onDescChange: (value: string) => void;
    batchDesc: string;
    onBatchDescChange: (value: string) => void;
    isDescMixed: boolean;
    showSavedDesc: boolean;
    textareaRef: RefObject<HTMLTextAreaElement>;
    // Source URL
    source: string;
    onSourceChange: (value: string) => void;
    /** 已保存的来源网址（P1(b)：可以有多条）。输入框里的 `source` 只是**新增用的草稿** */
    sourceUrls: string[];
    onRemoveSourceUrl: (url: string) => void;
    /** 就地改一条（旧值 → 新值） */
    onEditSourceUrl: (oldUrl: string, newUrl: string) => void;
    /** 多选时按文件删一条 */
    onRemoveSourceUrlOfFile: (fileId: string, url: string) => void;
    /** 多选时按文件改一条 */
    onEditSourceUrlOfFile: (fileId: string, oldUrl: string, newUrl: string) => void;
    batchSource: string;
    onBatchSourceChange: (value: string) => void;
    isSourceMixed: boolean;
    showSavedSource: boolean;
    // Common
    onUpdateMeta: () => void;
    t: (key: string) => string;
}

const EditSection = ({ isMulti, file, files, selectedFileIds, newTagInput, onNewTagInputChange, systemTags, onAddTag, onRemoveTag, onNavigateToTag, desc, onDescChange, batchDesc, onBatchDescChange, isDescMixed, showSavedDesc, textareaRef, source, onSourceChange, sourceUrls, onRemoveSourceUrl, onEditSourceUrl, onRemoveSourceUrlOfFile, onEditSourceUrlOfFile, batchSource, onBatchSourceChange, isSourceMixed, showSavedSource, onUpdateMeta, t }: EditSectionProps) => {
    // Tauri 的 webview 里 window.open 唤不起系统浏览器，必须走封装好的 open_external_link 命令。
    const openUrl = (url: string) => {
        if (!url) return;
        import('../../api/tauri-bridge')
            .then(({ openExternalLink }) => openExternalLink(url))
            .catch((e) => console.error('[EditSection] 打开来源网址失败:', e));
    };

    // 就地编辑某一条来源网址。`key` 带上 fileId，多选时同名网址不会一起进编辑态。
    const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
    const urlKey = (url: string, fileId?: string) => (fileId ? `${fileId}::${url}` : url);

    const commitEdit = (fileId?: string) => {
        if (!editing) return;
        const trimmed = editing.value.trim();
        // 清空 = 放弃这次编辑（要删走 ×），原值不变
        if (trimmed) {
            const oldUrl = editing.key.includes('::') ? editing.key.slice(editing.key.indexOf('::') + 2) : editing.key;
            if (trimmed !== oldUrl) {
                if (fileId) onEditSourceUrlOfFile(fileId, oldUrl, trimmed);
                else onEditSourceUrl(oldUrl, trimmed);
            }
        }
        setEditing(null);
    };

    /** 一条来源网址：常态是「打开 + 编辑 + 删除」，编辑态是输入框 + 保存/取消 */
    const renderUrlRow = (url: string, fileId?: string) => {
        const key = urlKey(url, fileId);
        const isEditing = editing?.key === key;

        if (isEditing) {
            const changed = editing!.value.trim() !== url;
            return (
                <div key={key} className="bg-surface px-2 py-1.5 rounded border border-subtle">
                    <textarea
                        autoFocus
                        rows={2}
                        value={editing!.value}
                        onChange={(e) => setEditing({ key, value: e.target.value })}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                commitEdit(fileId);
                            } else if (e.key === 'Escape') {
                                setEditing(null);
                            }
                        }}
                        // 失焦 = 放弃：保存是立即写库、没有撤销，误存一次比多按一次回车贵
                        onBlur={() => setEditing(null)}
                        placeholder="https://..."
                        className="w-full bg-transparent border-none resize-none text-sm leading-relaxed text-blue-600 dark:text-blue-400 placeholder-gray-400 focus:outline-none"
                    />
                    <div className="flex items-center gap-1 mt-1">
                        <div className="flex-1 min-w-0 truncate">
                            {/* 没改过：说清怎么存、怎么反悔；改过了：给一键还原 */}
                            {changed ? (
                                <button
                                    onMouseDown={(e) => { e.preventDefault(); setEditing({ key, value: url }); }}
                                    className="w-full text-left text-[10px] text-gray-400 hover:text-blue-500 truncate"
                                    title={t('meta.revertSource')}
                                >
                                    ↺ {url}
                                </button>
                            ) : (
                                <span className="text-[10px] text-gray-400">{t('meta.editSourceHint')}</span>
                            )}
                        </div>
                        {/* mousedown + preventDefault：先于 blur 处理，否则 blur 会先把编辑取消掉 */}
                        <button
                            onMouseDown={(e) => { e.preventDefault(); commitEdit(fileId); }}
                            className="shrink-0 text-gray-400 hover:text-green-500"
                            title={t('meta.save')}
                        >
                            <Check size={12} />
                        </button>
                        <button
                            onMouseDown={(e) => { e.preventDefault(); setEditing(null); }}
                            className="shrink-0 text-gray-400 hover:text-red-500"
                            title={t('meta.cancelSource')}
                        >
                            <X size={12} />
                        </button>
                    </div>
                </div>
            );
        }

        return (
            <div key={key} className="flex items-center gap-1 text-xs bg-surface/50 px-1.5 py-1 rounded group">
                <button
                    onClick={() => openUrl(url)}
                    className="truncate flex-1 text-left p-0 bg-transparent border-none text-blue-600 dark:text-blue-400 hover:underline"
                    title={url}
                >
                    {url}
                </button>
                <button
                    onClick={() => setEditing({ key, value: url })}
                    className="shrink-0 text-gray-400 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('meta.editSource')}
                >
                    <Pencil size={10} />
                </button>
                <button
                    onClick={() => (fileId ? onRemoveSourceUrlOfFile(fileId, url) : onRemoveSourceUrl(url))}
                    className="shrink-0 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('meta.removeSource')}
                >
                    <X size={10} />
                </button>
            </div>
        );
    };

    return (
        <>
            {/* Tags Section */}
            {!isMulti && file && file.type !== FileType.FOLDER && (
                <div>
                    <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center">
                        <Tag size={12} className="mr-1.5" /> {t('meta.tags')}
                    </div>
                    <div className="flex flex-wrap gap-2 mb-2">
                        {file?.tags?.map((tag) => (
                            <span key={tag} className="inline-flex items-center px-2 py-1 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 text-xs border border-blue-100 dark:border-blue-900/30 group">
                                <span className="cursor-pointer" onClick={() => onNavigateToTag(tag)}>{tag}</span>
                                <button onClick={() => onRemoveTag(tag)} className="ml-1 text-blue-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        {file?.tags.length === 0 && (
                            <span className="text-xs text-gray-400 italic py-1">{t('context.noTags')}</span>
                        )}
                    </div>
                    <div className="relative">
                        <input
                            type="text"
                            value={newTagInput}
                            onChange={(e) => onNewTagInputChange(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && onAddTag(newTagInput)}
                            placeholder={t('meta.addTagPlaceholder')}
                            className="w-full bg-surface border border-subtle rounded-md py-2 px-3 text-sm text-gray-700 dark:text-gray-300 focus:ring-2 ring-blue-500/50 placeholder-gray-400 focus:border-blue-500 outline-none transition-all"
                        />
                        {newTagInput && (
                            <button
                                onClick={() => onAddTag(newTagInput)}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 bg-blue-500 text-white rounded hover:bg-blue-600 dark:hover:bg-blue-700"
                            >
                                <Check size={12} />
                            </button>
                        )}

                        {/* Tag Autocomplete Suggestions */}
                        {newTagInput && systemTags.filter(t => t.toLowerCase().includes(newTagInput.toLowerCase()) && !file?.tags?.includes(t)).length > 0 && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-subtle rounded shadow-lg z-10 max-h-32 overflow-y-auto">
                                {systemTags.filter(t => t.toLowerCase().includes(newTagInput.toLowerCase()) && !file?.tags?.includes(t)).map(tag => (
                                    <div
                                        key={tag}
                                        className="px-3 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 cursor-pointer text-xs flex items-center text-gray-700 dark:text-gray-200"
                                        onClick={() => onAddTag(tag)}
                                    >
                                        <Tag size={10} className="mr-2 opacity-50" /> {tag}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Description Section */}
            {!isMulti && (
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center">
                            <FileText size={12} className="mr-1.5" /> {t('meta.description')}
                        </div>
                        {showSavedDesc && <span className="text-green-500 flex items-center text-[10px] animate-fade-in"><Check size={10} className="mr-1" />{t('meta.saved')}</span>}
                    </div>
                    {isMulti && isDescMixed ? (
                        <div className="text-xs text-orange-500 italic mb-2 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded">{t('meta.mixedValues')}</div>
                    ) : null}
                    <div className="relative">
                        <textarea
                            ref={textareaRef}
                            value={isMulti ? batchDesc : desc}
                            onChange={(e) => isMulti ? onBatchDescChange(e.target.value) : onDescChange(e.target.value)}
                            onBlur={onUpdateMeta}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                                    e.preventDefault();
                                    onUpdateMeta();
                                }
                            }}
                            placeholder={t('meta.addDesc')}
                            className="w-full bg-surface border border-subtle rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300 resize-none focus:ring-2 ring-blue-500/50 min-h-[80px] leading-relaxed outline-none transition-all focus:border-blue-500"
                        />
                    </div>
                    <div className="flex justify-between items-center mt-2 text-[10px] text-gray-400">
                        <span>{t('meta.descSaveHint')}</span>
                        <button
                            onClick={onUpdateMeta}
                            className="flex items-center px-3 py-1.5 bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-400 text-white rounded-md font-medium transition-colors"
                        >
                            <Save size={12} className="mr-1.5" /> {t('meta.save')}
                        </button>
                    </div>
                </div>
            )}

            {/* Source URL Section */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center">
                        <Globe size={12} className="mr-1.5" /> {t('meta.sourceUrl')}
                    </div>
                    {showSavedSource && <span className="text-green-500 flex items-center text-[10px] animate-fade-in"><Check size={10} className="mr-1" />{t('meta.saved')}</span>}
                </div>
                {isMulti && isSourceMixed ? (
                    <div className="text-xs text-orange-500 italic mb-2 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded">{t('meta.mixedValues')}</div>
                ) : null}
                <div className="flex items-start bg-surface rounded-lg border border-subtle focus-within:ring-2 focus-within:ring-blue-500/50 transition-all focus-within:border-blue-500">
                    <textarea
                        rows={2}
                        value={isMulti ? batchSource : source}
                        onChange={(e) => isMulti ? onBatchSourceChange(e.target.value) : onSourceChange(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                onUpdateMeta();
                            }
                        }}
                        onBlur={onUpdateMeta}
                        placeholder="https://..."
                        className="flex-1 bg-transparent border-none resize-none py-2 px-3 text-sm leading-relaxed text-blue-600 dark:text-blue-400 placeholder-gray-400 focus:outline-none min-w-0"
                    />
                    {(isMulti ? batchSource : source) && (
                        <button
                            onClick={() => openUrl(isMulti ? batchSource : source)}
                            className="p-2 mt-0.5 text-gray-400 hover:text-blue-500"
                            title={t('meta.openSource')}
                        >
                            <ExternalLink size={14} />
                        </button>
                    )}
                </div>

                {/* 已保存的来源网址：一张图可以有多条（P1(b)），逐条可打开、可编辑、可删除。
                    输入框里那条只是草稿，回车/失焦才是「加进来」。 */}
                {!isMulti && sourceUrls.length > 0 && (
                    <div className="mt-2 space-y-1">
                        {sourceUrls.map(url => renderUrlRow(url))}
                    </div>
                )}

                {isMulti && (
                    <div className="mt-3 space-y-2 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-gray-700 pr-1">
                        {selectedFileIds.map(id => {
                            const f = files[id];
                            const urls = getSourceUrls(f);
                            if (!f || urls.length === 0) return null;
                            return (
                                <div key={id} className="bg-surface/50 p-1.5 rounded border border-transparent hover:border-subtle transition-colors">
                                    <div className="text-gray-500 dark:text-gray-400 text-xs truncate mb-1 font-medium" title={f.name}>{f.name}</div>
                                    {urls.map(url => renderUrlRow(url, id))}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );
};

export default EditSection;
