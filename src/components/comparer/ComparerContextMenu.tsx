import React, { useRef, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

interface Option {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
    divider?: boolean;
    style?: string;
    disabled?: boolean;
    children?: Option[];
}

interface ComparerContextMenuProps {
    x: number;
    y: number;
    onClose: () => void;
    options: Option[];
    compact?: boolean;
}

export const ComparerContextMenu: React.FC<ComparerContextMenuProps> = ({ x, y, onClose, options, compact = false }) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({ x, y });
    const [isVisible, setIsVisible] = useState(false);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
    const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        window.addEventListener('mousedown', handleClickOutside);
        return () => window.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    useEffect(() => {
        const handleResize = () => {
            setWindowSize({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Calculate isCompact based on window size and compact prop
    const isCompact = compact || windowSize.height < 350;

    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            const menuWidth = isCompact ? 176 : 224; // w-44 = 176px, w-56 = 224px
            const menuHeight = rect.height;
            let newX = x;
            let newY = y;

            // Check right boundary
            if (newX + menuWidth > window.innerWidth) {
                newX = Math.max(10, newX - menuWidth);
            }
            // Check left boundary
            if (newX < 0) {
                newX = 10;
            }

            // Check bottom boundary
            if (newY + menuHeight > window.innerHeight) {
                newY = Math.max(10, newY - menuHeight);
            }
            // Check top boundary
            if (newY < 0) {
                newY = 10;
            }

            setPosition({ x: newX, y: newY });
            setIsVisible(true);
        }
    }, [x, y, isCompact]);

    const handleOptionClick = (e: React.MouseEvent, opt: Option) => {
        e.stopPropagation();
        if (opt.disabled) return;
        if (opt.children && opt.children.length > 0) {
            setExpandedGroup(expandedGroup === opt.label ? null : opt.label);
            return;
        }
        opt.onClick();
        onClose();
    };

    const renderOption = (opt: Option, index: number, isSubMenu = false) => {
        if (opt.divider) {
            return <div key={index} className={`bg-gray-200 dark:bg-gray-700 ${isCompact ? 'my-0.5' : 'my-1'} ${isSubMenu ? 'h-px' : 'h-px'}`} />;
        }

        const hasChildren = opt.children && opt.children.length > 0;
        const isExpanded = expandedGroup === opt.label;

        return (
            <div key={index}>
                <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => handleOptionClick(e, opt)}
                    disabled={opt.disabled}
                    className={`w-full text-left flex items-center transition-colors ${
                        opt.disabled
                            ? 'opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500'
                            : `hover:bg-gray-100 dark:hover:bg-gray-700 ${opt.style || 'text-gray-700 dark:text-gray-200'}`
                    } ${
                        isCompact
                            ? 'px-2 py-1 text-xs space-x-1.5'
                            : 'px-4 py-2 text-sm space-x-2'
                    }`}
                >
                    {opt.icon && (
                        <span className={`${opt.disabled ? 'opacity-40' : 'opacity-70'} ${isCompact ? 'scale-75' : ''}`}>
                            {opt.icon}
                        </span>
                    )}
                    <span className="truncate flex-1">{opt.label}</span>
                    {hasChildren && (
                        <ChevronRight size={isCompact ? 12 : 14} className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    )}
                </button>
                {hasChildren && isExpanded && (
                    <div className={`bg-gray-50 dark:bg-gray-800/50 ${isCompact ? 'py-0.5' : 'py-1'}`}>
                        {opt.children!.map((childOpt, childIndex) => renderOption(childOpt, childIndex, true))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div
            ref={menuRef}
            className={`fixed z-[9999] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden transition-opacity duration-100 ${
                isVisible ? 'opacity-100' : 'opacity-0'
            } ${
                isCompact ? 'w-44 py-0.5' : 'w-56 py-1'
            }`}
            style={{ left: position.x, top: position.y, maxHeight: '90vh', overflowY: 'auto' }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {options.map((opt, index) => renderOption(opt, index))}
        </div>
    );
};
