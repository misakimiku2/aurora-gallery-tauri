const DistributionChart = ({ data, totalFiles }: { data: { label: string, value: number, color: string }[], totalFiles: number }) => {
    const max = Math.max(...data.map(d => d.value), 1);

    return (
        <div className="space-y-3">
            {data.map((item) => (
                <div key={item.label} className="flex items-center text-xs group">
                    <div className="w-20 text-gray-500 dark:text-gray-400 font-medium truncate shrink-0" title={item.label}>
                        {item.label}
                    </div>
                    <div className="flex-1 mx-3 h-2 bg-surface rounded-full overflow-hidden">
                        <div
                            className={`h-full rounded-full ${item.color} shadow-sm transition-all duration-700 ease-out`}
                            style={{ width: `${(item.value / max) * 100}%` }}
                        />
                    </div>
                    <div className="w-12 text-right text-gray-700 dark:text-gray-300 font-mono font-medium">
                        {item.value}
                    </div>
                </div>
            ))}
            {data.length === 0 && (
                <div className="text-center text-gray-400 text-xs py-2 italic">No files found</div>
            )}
        </div>
    );
};

export default DistributionChart;
