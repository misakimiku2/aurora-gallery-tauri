import { Folder, Book, Film } from 'lucide-react';

const CategorySelector = ({ current, onChange, t }: any) => (
    <div className="space-y-2 pt-4 border-t border-subtle">
        <div className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold mb-2">{t('meta.folderCategory')}</div>
        <div className="flex bg-surface p-1.5 rounded-xl gap-2">
            {['general', 'book', 'sequence'].map((cat) => {
                const isActive = current === cat;
                return (
                    <button
                        key={cat}
                        onClick={() => onChange(cat)}
                        className={`flex-1 flex flex-col items-center justify-center py-3 rounded-lg text-xs font-medium transition-all ${isActive
                            ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-md ring-1 ring-black/5 dark:ring-white/10'
                            : 'text-gray-500 hover:bg-surface hover:text-gray-900 dark:hover:text-gray-100'
                            }`}
                    >
                        {cat === 'general' && <Folder size={20} className={`mb-1.5 ${isActive ? 'fill-blue-100 dark:fill-blue-900/30' : ''}`} />}
                        {cat === 'book' && <Book size={20} className={`mb-1.5 ${isActive ? 'fill-amber-100 dark:fill-amber-900/30' : ''}`} />}
                        {cat === 'sequence' && <Film size={20} className={`mb-1.5 ${isActive ? 'fill-purple-100 dark:fill-purple-900/30' : ''}`} />}
                        {t(`meta.cat${cat.charAt(0).toUpperCase() + cat.slice(1)}`)}
                    </button>
                );
            })}
        </div>
    </div>
);

export default CategorySelector;
