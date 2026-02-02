
import React from 'react';
import { Book, Film, Folder } from 'lucide-react';

export const Folder3DIcon = ({ previewSrcs, count, category = 'general', className = "", onImageError }: { previewSrcs?: string[], count?: number, category?: string, className?: string, onImageError?: (index: number) => void }) => {
    const styles: any = {
        general: { back: 'text-blue-600 dark:text-blue-500', front: 'text-blue-400 dark:text-blue-400' },
        book: { back: 'text-amber-600 dark:text-amber-500', front: 'text-amber-400 dark:text-amber-400' },
        sequence: { back: 'text-purple-600 dark:text-purple-500', front: 'text-purple-400 dark:text-purple-400' },
    };
    const style = styles[category] || styles.general;
    
    const Icon = category === 'book' ? Book : (category === 'sequence' ? Film : Folder);

    // Use whatever valid URLs are passed (base64 or asset://)
    const images = (previewSrcs || []).filter(src => !!src);
    
    return (
        <div className={`relative w-full h-full group select-none flex items-center justify-center ${className}`}>
            {/* Square container to maintain aspect ratio */}
            <div className="relative w-full aspect-square">
                {/* Back Plate */}
                <svg viewBox="0 0 100 100" className={`absolute w-full h-full drop-shadow-sm transition-colors ${style.back}`} preserveAspectRatio="none">
                    <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" fill="currentColor" />
                </svg>

                {/* Preview Images */}
                <div className="absolute left-[15%] right-[15%] top-[20%] bottom-[20%] z-10 transition-transform duration-300 group-hover:-translate-y-3 group-hover:scale-105">
                    {images[2] && (
                        <div className="absolute inset-0 bg-white shadow-md z-0 border-[2px] border-white rounded-sm overflow-hidden transform rotate-6 translate-x-2 -translate-y-3 scale-90 opacity-80">
                            <img 
                                src={images[2]} 
                                className="w-full h-full object-cover" 
                                loading="lazy" 
                                draggable="false"
                                onError={() => onImageError?.(2)}
                            />
                        </div>
                    )}
                    {images[1] && (
                        <div className="absolute inset-0 bg-white shadow-md z-10 border-[2px] border-white rounded-sm overflow-hidden transform -rotate-3 -translate-x-1 -translate-y-1.5 scale-95">
                            <img 
                                src={images[1]} 
                                className="w-full h-full object-cover" 
                                loading="lazy" 
                                draggable="false"
                                onError={() => onImageError?.(1)}
                            />
                        </div>
                    )}
                    {images[0] && (
                        <div className="absolute inset-0 bg-white shadow-md z-20 border-[2px] border-white rounded-sm overflow-hidden transform rotate-0 scale-100">
                            <img 
                                src={images[0]} 
                                className="w-full h-full object-cover" 
                                loading="lazy" 
                                draggable="false"
                                onError={() => onImageError?.(0)}
                            />
                        </div>
                    )}
                </div>

                {/* Front Plate */}
                <div 
                    className="absolute left-0 right-0 bottom-0 h-[60%] z-20 transition-transform duration-300 origin-bottom"
                    style={{ transform: 'perspective(800px) rotateX(-10deg)' }}
                >
                    <svg viewBox="0 0 100 65" className={`w-full h-full drop-shadow-lg ${style.front}`} preserveAspectRatio="none">
                        <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" fill="currentColor" />
                    </svg>
                    
                    <div className="absolute inset-0 flex items-center justify-center opacity-50 mix-blend-overlay">
                        <Icon size={32} className="text-white" strokeWidth={1.5} />
                    </div>
                    
                    {count !== undefined && (
                        <div className="absolute bottom-2 right-3 bg-black/20 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm shadow-sm">
                            {count}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
