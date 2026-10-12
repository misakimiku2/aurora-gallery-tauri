import { FileNode, FileType, AppSettings, AppState } from '../../types';
import { AIRenameButton } from '../AIRenameButton';
import { AIRenamePreview } from '../AIRenamePreview';

interface FileInfoSectionProps {
    isMulti: boolean;
    file: FileNode | null;
    files: Record<string, FileNode>;
    selectedCount: number;
    t: (key: string) => string;
    settings?: AppSettings;
    aiConnectionStatus?: AppState['aiConnectionStatus'];
    previewName: string | null;
    isGenerating: boolean;
    onGenerateName: (file: FileNode) => void;
    onApplyRename: (file: FileNode) => void;
    onCancelRename: () => void;
}

const FileInfoSection = ({ isMulti, file, files, selectedCount, t, settings, aiConnectionStatus, previewName, isGenerating, onGenerateName, onApplyRename, onCancelRename }: FileInfoSectionProps) => {
    return (
        <div className="p-5 flex-shrink-0 bg-panel">
            {/* 文件名区域 - 使用相对定位，按钮绝对定位在右下角 */}
            <div className="relative">
                {/* 视频播放UI设计 §1.2：:25 与 :30 是同一个判断的两个变体 —— 都只服务于右下角的
                    「AI 重命名」按钮（:25 是给按钮留位而加的右内边距 pr-7）。
                    AI 重命名依赖 AI 分析，而「AI 不跑视频」是已拍板口径（§6.1），故此处
                    显式保留 FileType.IMAGE 门禁、不改为 !== FOLDER，让视频时按钮与其留白一起自然消失。 */}
                <div className={`font-bold text-lg text-gray-800 dark:text-white break-all leading-tight mb-1 ${!isMulti && file && file.type === FileType.IMAGE && settings && !previewName ? 'pr-7' : ''}`}>
                    {isMulti ? `${selectedCount} ${t('meta.items')}` : file?.name}
                </div>

                {/* 按钮绝对定位在右下角 —— 仅 AI 重命名（依赖 AI 分析，视频不显示，见上方注释） */}
                {!isMulti && file && file.type === FileType.IMAGE && settings && aiConnectionStatus === 'connected' && !previewName && (
                    <div className="absolute bottom-0 right-0">
                        <AIRenameButton
                            onClick={() => onGenerateName(file)}
                            isGenerating={isGenerating}
                            t={t}
                        />
                    </div>
                )}
            </div>

            {/* 父文件夹名称 */}
            {!isMulti && file && (
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {files[file.parentId || '']?.name || 'Root'}
                </div>
            )}

            {/* AI 重命名预览 - 显示在文件名下方 */}
            {!isMulti && file && previewName && (
                <AIRenamePreview
                    previewName={previewName}
                    onApply={() => onApplyRename(file)}
                    onCancel={onCancelRename}
                    t={t}
                />
            )}
        </div>
    );
};

export default FileInfoSection;
