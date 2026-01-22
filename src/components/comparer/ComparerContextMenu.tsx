import React from 'react';

interface MenuProps {
    x: number;
    y: number;
    onClose: () => void;
    options: {
        label: string;
        onClick: () => void;
        icon?: React.ReactNode;
        divider?: boolean;
    }[];
}

export const ComparerContextMenu: React.FC<MenuProps> = ({ x, y, onClose, options }) => {
    return (
        <>
            <div className="fixed inset-0 z-[100]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
            <div
                className="fixed z-[101] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px] animate-in fade-in zoom-in duration-100"
                style={{ left: x, top: y }}
            >
                {options.map((opt, i) => (
                    <React.Fragment key={i}>
                        {opt.divider && <div className="my-1 border-t border-gray-100 dark:border-gray-700" />}
                        <button
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-400 flex items-center transition-colors"
                            onClick={() => { opt.onClick(); onClose(); }}
                        >
                            <span className="flex-1">{opt.label}</span>
                        </button>
                    </React.Fragment>
                ))}
            </div>
        </>
    );
};
