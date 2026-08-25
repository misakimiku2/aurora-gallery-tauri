import type { RefObject } from 'react';
import { Tag, X, Check, FileText, Save, Globe, ExternalLink } from 'lucide-react';
import { FileNode, FileType } from '../../types';

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
    batchSource: string;
    onBatchSourceChange: (value: string) => void;
    isSourceMixed: boolean;
    showSavedSource: boolean;
    // Common
    onUpdateMeta: () => void;
    t: (key: string) => string;
}

const EditSection = ({ isMulti, file, files, selectedFileIds, newTagInput, onNewTagInputChange, systemTags, onAddTag, onRemoveTag, onNavigateToTag, desc, onDescChange, batchDesc, onBatchDescChange, isDescMixed, showSavedDesc, textareaRef, source, onSourceChange, batchSource, onBatchSourceChange, isSourceMixed, showSavedSource, onUpdateMeta, t }: EditSectionProps) => {
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
                <div className="flex items-center bg-surface rounded-lg border border-subtle focus-within:ring-2 focus-within:ring-blue-500/50 transition-all focus-within:border-blue-500">
                    <input
                        type="text"
                        value={isMulti ? batchSource : source}
                        onChange={(e) => isMulti ? onBatchSourceChange(e.target.value) : onSourceChange(e.target.value)}
                        onBlur={onUpdateMeta}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                onUpdateMeta();
                            }
                        }}
                        placeholder="https://..."
                        className="flex-1 bg-transparent border-none py-2 px-3 text-sm text-blue-600 dark:text-blue-400 placeholder-gray-400 focus:outline-none"
                    />
                    {(isMulti ? batchSource : source) && (
                        <button
                            onClick={() => window.open(isMulti ? batchSource : source, '_blank')}
                            className="p-2 text-gray-400 hover:text-blue-500"
                            title={t('meta.openSource')}
                        >
                            <ExternalLink size={14} />
                        </button>
                    )}
                </div>
                {isMulti && (
                    <div className="mt-3 space-y-2 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-gray-700 pr-1">
                        {selectedFileIds.map(id => {
                            const f = files[id];
                            if (!f || !f.sourceUrl) return null;
                            return (
                                <div key={id} className="flex items-center text-xs group bg-surface/50 p-1.5 rounded border border-transparent hover:border-subtle transition-colors">
                                    <div className="text-gray-500 dark:text-gray-400 w-20 truncate mr-2 font-medium shrink-0" title={f.name}>{f.name}</div>
                                    <button
                                        onClick={() => f.sourceUrl && window.open(f.sourceUrl, '_blank')}
                                        className="text-blue-500 dark:text-blue-400 truncate flex-1 text-left p-0 bg-transparent border-none hover:underline"
                                        title={f.sourceUrl}
                                    >
                                        {f.sourceUrl}
                                    </button>
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
