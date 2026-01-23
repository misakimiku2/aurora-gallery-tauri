import React, { useRef, useEffect, useState } from 'react';

interface Option {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
    divider?: boolean;
    style?: string;
}

interface ComparerContextMenuProps {
    x: number;
    y: number;
    onClose: () => void;
    options: Option[];
}

export const ComparerContextMenu: React.FC<ComparerContextMenuProps> = ({ x, y, onClose, options }) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x, y });
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        // 简单的点击外部关闭逻辑
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        window.addEventListener('mousedown', handleClickOutside);
        return () => window.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // 边界检测
    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            let newX = x;
            let newY = y;

            // 如果右侧超出屏幕
            if (x + rect.width > window.innerWidth) {
                newX = x - rect.width;
            }
            // 如果底部超出屏幕
            if (y + rect.height > window.innerHeight) {
                newY = y - rect.height;
            }

            setPosition({ x: newX, y: newY });
            setIsVisible(true);
        }
    }, [x, y]);

    return (
        <div
            ref={menuRef}
            className={`fixed z-[9999] w-56 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 overflow-hidden transition-opacity duration-100 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
            style={{ left: position.x, top: position.y }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {options.map((opt, index) => (
                opt.divider ? (
                    <div key={index} className="h-px bg-gray-200 dark:bg-gray-700 my-1" />
                ) : (
                    <button
                        key={index}
                        onClick={() => {
                            opt.onClick();
                            onClose();
                        }}
                        className={`w-full text-left px-4 py-2 text-sm flex items-center space-x-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${opt.style || 'text-gray-700 dark:text-gray-200'}`}
                    >
                        {opt.icon && <span className="opacity-70">{opt.icon}</span>}
                        <span>{opt.label}</span>
                    </button>
                )
            ))}
        </div>
    );
};
