import { Sparkles, Trash2, Smile, User, Scan, FileText, Languages, Copy } from 'lucide-react';
import { FileNode, Person } from '../../types';

interface AIAnalysisSectionProps {
    isMulti: boolean;
    file: FileNode | null;
    files: Record<string, FileNode>;
    selectedFileIds: string[];
    people?: Record<string, Person>;
    onUpdate: (id: string, updates: Partial<FileNode>) => void;
    onSelectPerson?: (id: string) => void;
    onCopyToClipboard: (text: string) => void;
    t: (key: string) => string;
}

const AIAnalysisSection = ({ isMulti, file, files, selectedFileIds, people, onUpdate, onSelectPerson, onCopyToClipboard, t }: AIAnalysisSectionProps) => {
    const hasAiData = selectedFileIds.some(id => files[id]?.aiData);
    if (!hasAiData) return null;

    return (
        <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-900/10 dark:to-blue-900/10 rounded-xl p-4 border border-purple-100 dark:border-purple-900/30">
            <div className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider mb-3 flex items-center justify-between">
                <div className="flex items-center"><Sparkles size={12} className="mr-1.5" /> {t('meta.aiSection')}</div>
                {(
                    (!isMulti && file && file.aiData) ||
                    (isMulti && selectedFileIds.some(id => files[id]?.aiData))
                ) && (
                        isMulti ? (
                            <button
                                onClick={() => {
                                    selectedFileIds.forEach(id => {
                                        if (files[id]?.aiData) {
                                            onUpdate(id, { aiData: undefined });
                                        }
                                    });
                                }}
                                className="p-2 rounded-md hover:bg-red-600/10 dark:hover:bg-red-500/20 text-red-600 dark:text-red-300 transition"
                                title={t('meta.clearAllAiData')}
                                aria-label={t('meta.clearAllAiData')}
                            >
                                <Trash2 size={16} />
                            </button>
                        ) : (
                            <button
                                onClick={() => file && onUpdate(file.id, { aiData: undefined })}
                                className="p-2 rounded-md hover:bg-red-600/10 dark:hover:bg-red-500/20 text-red-600 dark:text-red-300 transition"
                                title={t('meta.clearAiData')}
                                aria-label={t('meta.clearAiData')}
                            >
                                <Trash2 size={16} />
                            </button>
                        )
                    )}
            </div>

            {isMulti ? (
                // Multi-selection AI analysis summary
                <div className="space-y-3">
                    {/* Count of files with AI data */}
                    <div className="bg-surface p-2 rounded border border-subtle">
                        <div className="text-gray-400 text-xs mb-1">{t('meta.aiFilesCount')}</div>
                        <div className="font-medium text-gray-800 dark:text-gray-200">
                            {selectedFileIds.filter(id => files[id]?.aiData).length} / {selectedFileIds.length}
                        </div>
                    </div>

                    {/* Scene Categories */}
                    {(() => {
                        // Get all unique scene categories from selected files
                        const sceneCategories = new Map<string, number>();
                        selectedFileIds.forEach(id => {
                            const aiData = files[id]?.aiData;
                            if (aiData?.sceneCategory) {
                                const category = aiData.sceneCategory;
                                sceneCategories.set(category, (sceneCategories.get(category) || 0) + 1);
                            }
                        });

                        if (sceneCategories.size > 0) {
                            return (
                                <div className="bg-surface p-2 rounded border border-subtle">
                                    <div className="text-gray-400 text-xs mb-2 flex items-center">
                                        <span className="mr-1.5">{t('meta.aiScene')}</span>
                                        <span className="text-gray-500">({sceneCategories.size} {t('context.items')})</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {Array.from(sceneCategories.entries())
                                            .sort(([, a], [, b]) => b - a)
                                            .slice(0, 8)
                                            .map(([category, count]) => (
                                                <span key={category} className="px-2 py-1 bg-surface text-gray-600 dark:text-gray-400 text-[10px] rounded border border-subtle flex items-center">
                                                    <span className="mr-1 font-medium">{category}</span>
                                                    <span className="text-gray-500">({count})</span>
                                                </span>
                                            ))}
                                    </div>
                                </div>
                            );
                        }
                        return null;
                    })()}

                    {/* Detected Faces */}
                    {(() => {
                        // Get all unique faces from selected files
                        const faceNames = new Set<string>();
                        selectedFileIds.forEach(id => {
                            const aiData = files[id]?.aiData;
                            if (aiData?.faces) {
                                aiData.faces.forEach(face => {
                                    if (face.name) {
                                        faceNames.add(face.name);
                                    }
                                });
                            }
                        });

                        if (faceNames.size > 0) {
                            return (
                                <div className="bg-surface p-2 rounded border border-subtle">
                                    <div className="text-gray-400 text-xs mb-2 flex items-center">
                                        <span className="mr-1.5">{t('meta.aiFaces')}</span>
                                        <span className="text-gray-500">({faceNames.size} {t('context.items')})</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {Array.from(faceNames)
                                            .sort()
                                            .slice(0, 8)
                                            .map(name => {
                                                const personEntry = people ? Object.values(people).find(p => p.name === name) : null;
                                                return (
                                                    <span
                                                        key={name}
                                                        className={`px-2 py-1 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 text-[10px] rounded border border-purple-100 dark:border-purple-900/30 flex items-center transition-all ${personEntry ? 'cursor-pointer hover:bg-purple-100 dark:hover:bg-purple-800/30 active:scale-95' : ''}`}
                                                        onClick={() => personEntry && onSelectPerson && onSelectPerson(personEntry.id)}
                                                    >
                                                        {name}
                                                    </span>
                                                );
                                            })}
                                    </div>
                                </div>
                            );
                        }
                        return null;
                    })()}

                    {/* Detected Objects */}
                    {(() => {
                        // Get all unique objects from selected files
                        const objects = new Map<string, number>();
                        selectedFileIds.forEach(id => {
                            const aiData = files[id]?.aiData;
                            if (aiData?.objects) {
                                aiData.objects.forEach(obj => {
                                    objects.set(obj, (objects.get(obj) || 0) + 1);
                                });
                            }
                        });

                        if (objects.size > 0) {
                            return (
                                <div className="bg-surface p-2 rounded border border-subtle">
                                    <div className="text-gray-400 text-xs mb-2 flex items-center">
                                        <span className="mr-1.5">{t('meta.aiObjects')}</span>
                                        <span className="text-gray-500">({objects.size} {t('context.items')})</span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {Array.from(objects.entries())
                                            .sort(([, a], [, b]) => b - a)
                                            .slice(0, 12)
                                            .map(([obj, count]) => (
                                                <span key={obj} className="px-1.5 py-0.5 bg-surface text-gray-600 dark:text-gray-400 text-[10px] rounded border border-subtle flex items-center">
                                                    <span className="mr-1">{obj}</span>
                                                    <span className="text-gray-500 text-[9px]">({count})</span>
                                                </span>
                                            ))}
                                    </div>
                                </div>
                            );
                        }
                        return null;
                    })()}


                </div>
            ) : (
                // Single file AI analysis details
                file && file.aiData && (
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-surface p-2 rounded border border-subtle">
                                <div className="text-gray-400 mb-1">{t('meta.aiScene')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{file.aiData.sceneCategory}</div>
                            </div>
                            <div className="bg-surface p-2 rounded border border-subtle">
                                <div className="text-gray-400 mb-1">{t('meta.aiConfidence')}</div>
                                <div className="font-medium text-gray-800 dark:text-gray-200">{Math.round(file.aiData.confidence * 100)}%</div>
                            </div>
                        </div>

                        {file.aiData.faces.length > 0 && (
                            <div>
                                <div className="text-[10px] text-gray-400 font-bold mb-1.5 flex items-center"><Smile size={10} className="mr-1" /> {t('meta.aiFaces')}</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {file.aiData.faces.map((face, i) => (
                                        <div
                                            key={`${face.id}-${i}`}
                                            className={`flex items-center bg-surface px-2 py-1 rounded-full border border-purple-100 dark:border-purple-900/30 text-xs shadow-sm transition-all ${face.personId ? 'cursor-pointer hover:bg-purple-50 dark:hover:bg-purple-900/20 active:scale-95' : ''}`}
                                            onClick={() => face.personId && onSelectPerson && onSelectPerson(face.personId)}
                                        >
                                            <User size={10} className="mr-1 text-purple-500" />
                                            <span className="text-gray-700 dark:text-gray-300">{face.name}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {file.aiData.objects.length > 0 && (
                            <div>
                                <div className="text-[10px] text-gray-400 font-bold mb-1.5 flex items-center"><Scan size={10} className="mr-1" /> {t('meta.aiObjects')}</div>
                                <div className="flex flex-wrap gap-1">
                                    {file.aiData.objects.map((obj, i) => (
                                        <span key={`${obj}-${i}`} className="px-1.5 py-0.5 bg-surface text-gray-600 dark:text-gray-400 text-[10px] rounded border border-subtle">
                                            {obj}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {file.aiData.extractedText && (
                            <div className="mt-2 bg-surface p-2 rounded border border-subtle">
                                <div className="text-[10px] text-gray-400 font-bold mb-1 flex items-center justify-between">
                                    <div className="flex items-center"><FileText size={10} className="mr-1" /> {t('meta.aiExtractedText')}</div>
                                    <button
                                        onClick={() => onCopyToClipboard(file.aiData?.extractedText || '')}
                                        className="ml-2 p-1 rounded hover:bg-surface text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
                                        title={t('context.copy')}
                                        aria-label={t('context.copy')}
                                    >
                                        <Copy size={12} />
                                    </button>
                                </div>
                                <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{file.aiData.extractedText}</p>
                            </div>
                        )}

                        {file.aiData.translatedText && (
                            <div className="mt-2 bg-surface p-2 rounded border border-subtle">
                                <div className="text-[10px] text-gray-400 font-bold mb-1 flex items-center justify-between">
                                    <div className="flex items-center"><Languages size={10} className="mr-1" /> {t('meta.aiTranslatedText')}</div>
                                    <button
                                        onClick={() => onCopyToClipboard(file.aiData?.translatedText || '')}
                                        className="ml-2 p-1 rounded hover:bg-surface text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
                                        title={t('context.copy')}
                                        aria-label={t('context.copy')}
                                    >
                                        <Copy size={12} />
                                    </button>
                                </div>
                                <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{file.aiData.translatedText}</p>
                            </div>
                        )}


                    </div>
                )
            )}
        </div>
    );
};

export default AIAnalysisSection;
