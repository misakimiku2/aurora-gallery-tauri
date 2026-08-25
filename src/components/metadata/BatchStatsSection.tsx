import { PieChart } from 'lucide-react';
import DistributionChart from './DistributionChart';
import { formatSize } from '../../utils/mockFileSystem';

interface BatchStatsSectionProps {
    batchStats: { totalSize: number; typeCount: Record<string, number>; allTags: string[] } | null;
    batchChartData: { label: string; value: number; color: string }[];
    totalFiles: number;
    t: (key: string) => string;
}

const BatchStatsSection = ({ batchStats, batchChartData, totalFiles, t }: BatchStatsSectionProps) => {
    if (!batchStats) return null;

    return (
        <div className="bg-surface rounded-lg border border-subtle p-4 shadow-sm">
            <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center">
                <PieChart size={12} className="mr-1.5" /> {t('meta.typeDistribution')}
            </div>
            <DistributionChart data={batchChartData} totalFiles={totalFiles} />

            {/* Total Files Summary */}
            <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-3 mt-3 border-t border-subtle">
                <span>{t('meta.totalFiles')}</span>
                <span className="font-bold text-gray-600 dark:text-gray-300 bg-surface px-2 py-0.5 rounded-full">{totalFiles}</span>
            </div>
            {/* Total Size Summary */}
            <div className="text-xs text-gray-400 dark:text-gray-500 flex justify-between items-center pt-2">
                <span>{t('meta.totalSize')}</span>
                <span className="font-bold text-gray-600 dark:text-gray-300 bg-surface px-2 py-0.5 rounded-full">{formatSize(batchStats.totalSize)}</span>
            </div>
        </div>
    );
};

export default BatchStatsSection;
