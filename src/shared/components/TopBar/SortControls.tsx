import React, { useState, useRef, useEffect } from 'react';
import { ArrowDownUp, Check } from 'lucide-react';
import { SortOption, SortDirection } from '../../api/types';

export interface SortControlsProps {
  sortBy: SortOption;
  sortDirection: SortDirection;
  onSortChange: (option: SortOption) => void;
  onSortDirectionChange: () => void;
  t: (key: string) => string;
}

export const SortControls: React.FC<SortControlsProps> = ({
  sortBy,
  sortDirection,
  onSortChange,
  onSortDirectionChange,
  t,
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

  const sortOptions: { id: SortOption; label: string }[] = [
    { id: 'name', label: t('sort.name') || '名称' },
    { id: 'date', label: t('sort.date') || '日期' },
    { id: 'size', label: t('sort.size') || '大小' },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${
          menuOpen ? 'bg-gray-100 dark:bg-gray-800 text-blue-500' : 'text-gray-600 dark:text-gray-300'
        }`}
        title={t('sort.sortBy') || '排序'}
      >
        <ArrowDownUp size={18} />
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)}></div>
          <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 py-2 animate-zoom-in">
            <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">
              {t('sort.sortBy') || '排序方式'}
            </div>
            {sortOptions.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  onSortChange(opt.id);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
              >
                {opt.label}
                {sortBy === opt.id && <Check size={14} className="text-blue-500" />}
              </button>
            ))}
            <div className="border-t border-gray-100 dark:border-gray-700 my-1"></div>
            <button
              onClick={() => {
                onSortDirectionChange();
              }}
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
            >
              {sortDirection === 'asc' ? (t('sort.asc') || '升序') : (t('sort.desc') || '降序')}
              <ArrowDownUp
                size={14}
                className={sortDirection === 'asc' ? 'transform rotate-180' : ''}
              />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default SortControls;
