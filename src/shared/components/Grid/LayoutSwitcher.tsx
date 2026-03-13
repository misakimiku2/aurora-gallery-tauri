import React, { useState, useRef, useEffect } from 'react';
import { LayoutGrid, Columns, Rows3, ChevronDown, Check, Grid } from 'lucide-react';
import { LayoutMode } from '../../api/types';

export interface LayoutSwitcherProps {
  mode: LayoutMode;
  onChange: (mode: LayoutMode) => void;
  className?: string;
}

const layoutOptions: { mode: LayoutMode; icon: React.ElementType; label: string }[] = [
  { mode: 'grid', icon: Grid, label: '网格' },
  { mode: 'masonry', icon: Columns, label: '瀑布流' },
  { mode: 'adaptive', icon: LayoutGrid, label: '自适应' },
];

export const LayoutSwitcher: React.FC<LayoutSwitcherProps> = ({
  mode,
  onChange,
  className = '',
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentOption = layoutOptions.find((opt) => opt.mode === mode) || layoutOptions[0];
  const CurrentIcon = currentOption.icon;

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="flex items-center gap-1.5 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-300"
        title="布局方式"
      >
        <CurrentIcon size={16} />
        <span className="hidden sm:inline">{currentOption.label}</span>
        <ChevronDown size={14} className={`transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
      </button>

      {menuOpen && (
        <div className="absolute top-full right-0 mt-2 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 py-1.5 animate-zoom-in">
          <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">
            布局方式
          </div>
          {layoutOptions.map((option) => {
            const Icon = option.icon;
            const isSelected = mode === option.mode;
            return (
              <button
                key={option.mode}
                onClick={() => {
                  onChange(option.mode);
                  setMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
              >
                <div className="flex items-center gap-2">
                  <Icon size={16} className="opacity-70" />
                  <span>{option.label}</span>
                </div>
                {isSelected && <Check size={14} className="text-blue-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LayoutSwitcher;
