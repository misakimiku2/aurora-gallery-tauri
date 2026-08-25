import { PieChart } from 'lucide-react';
import { FileNode, FileType } from '../../types';
import { Folder3DIcon } from '../Folder3DIcon';
import DistributionChart from './DistributionChart';

interface FolderDetails {
    types: Record<string, number>;
    totalFiles: number;
    subFolderCount: number;
}

interface FolderInfoSectionProps {
    file: FileNode | null;
    folderPreviewImages: string[];
    folderDetails: FolderDetails | null;
    chartData: { label: string; value: number; color: string }[];
    t: (key: string) => string;
}

const FolderInfoSection = ({ file, folderPreviewImages, folderDetails, chartData, t }: FolderInfoSectionProps) => {
    if (!file || file.type !== FileType.FOLDER) return null;

    return (
        <div className="flex flex-col">
            <div className="w-full rounded-lg overflow-hidden bg-surface border border-subtle flex justify-center items-center py-8 mb-4 shadow-sm relative group">
                <div className="w-[200px] h-[200px]">
                    <Folder3DIcon
                        previewSrcs={folderPreviewImages}
                        count={file.children?.length}
                        category={file.category}
                        className="w-full h-full text-blue-500 dark:text-blue-400"
                    />
                </div>
            </div>

            {/* File Type Distribution */}
            {folderDetails && (
                <div className="bg-surface rounded-lg border border-subtle p-4 shadow-sm">
                    <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                        <PieChart size={12} className="mr-1.5" /> {t('meta.fileDistribution')}
                    </div>
                    <DistributionChart data={chartData} totalFiles={folderDetails.totalFiles + folderDetails.subFolderCount} />

                    {/* Total Files Summary */}
                    <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-3 mt-3 border-t border-subtle">
                        <span>{t('meta.totalFiles')}</span>
                        <span className="font-bold text-gray-600 dark:text-gray-300 bg-surface px-2 py-0.5 rounded-full">{folderDetails.totalFiles}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default FolderInfoSection;
