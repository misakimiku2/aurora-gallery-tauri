import React, { useState, useRef, useEffect } from 'react';
import { Search, X, ChevronDown, Globe, FileText, Folder } from 'lucide-react';
import { SearchScope } from '../../api/types';

export interface SearchInputProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onPerformSearch: (query: string) => Promise<void>;
  searchScope: SearchScope;
  onSearchScopeChange: (scope: SearchScope) => void;
  placeholder?: string;
  t: (key: string) => string;
}

export const SearchInput: React.FC<SearchInputProps> = ({
  searchQuery,
  onSearchChange,
  onPerformSearch,
  searchScope,
  onSearchScopeChange,
  placeholder,
  t,
}) => {
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (scopeMenuRef.current && !scopeMenuRef.current.contains(event.target as Node)) {
        setScopeMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getScopeIcon = (scope: SearchScope) => {
    switch (scope) {
      case 'file':
        return <FileText size={14} />;
      case 'folder':
        return <Folder size={14} />;
      default:
        return <Globe size={14} />;
    }
  };

  const scopeOptions: { id: SearchScope; icon: React.ElementType; label: string }[] = [
    { id: 'all', icon: Globe, label: t('search.scopeAll') || '全部' },
    { id: 'file', icon: FileText, label: t('search.scopeFile') || '文件名' },
    { id: 'folder', icon: Folder, label: t('search.scopeFolder') || '文件夹' },
  ];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onPerformSearch(searchQuery);
    }
  };

  const handleClear = () => {
    onSearchChange('');
    onPerformSearch('');
  };

  return (
    <div className="flex-1 max-w-2xl relative">
      <div
        className={`flex items-center bg-gray-100 dark:bg-gray-800 rounded-full px-3 py-1.5 transition-all border ${
          searchQuery ? 'border-blue-500 shadow-sm' : 'border-transparent'
        }`}
      >
        <div className="relative flex-shrink-0" ref={scopeMenuRef}>
          <button
            onClick={() => setScopeMenuOpen(!scopeMenuOpen)}
            className="flex items-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mr-2 pr-2 border-r border-gray-300 dark:border-gray-600 whitespace-nowrap"
          >
            {getScopeIcon(searchScope)}
            <ChevronDown size={12} className="ml-1 opacity-70" />
          </button>
          {scopeMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setScopeMenuOpen(false)}></div>
              <div className="absolute top-full left-0 mt-2 w-40 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md rounded-lg shadow-xl z-50 py-1 overflow-hidden animate-fade-in">
                {scopeOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => {
                      onSearchScopeChange(opt.id);
                      setScopeMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center hover:bg-blue-50 dark:hover:bg-blue-900/20 ${
                      searchScope === opt.id
                        ? 'text-blue-600 dark:text-blue-400 font-bold'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <opt.icon size={14} className="mr-2" />
                    {opt.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          className="bg-transparent border-none focus:outline-none text-sm w-full text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 min-w-0"
          placeholder={placeholder || t('search.placeholder') || '搜索...'}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="flex items-center space-x-1 ml-2 flex-shrink-0">
          {searchQuery && (
            <button
              onClick={handleClear}
              className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 flex-shrink-0"
            >
              <X size={14} />
            </button>
          )}
          <button
            onClick={() => onPerformSearch(searchQuery)}
            className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-blue-500 flex-shrink-0"
            title={t('search.search') || '搜索'}
          >
            <Search size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default SearchInput;
