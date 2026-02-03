import React, { useState } from 'react';
import { HardDrive, Sun, Moon, Monitor, ChevronRight, Loader2 } from 'lucide-react';
import { AuroraLogo } from '../Logo';
import { AppSettings } from '../../types';

interface WelcomeModalProps {
    show: boolean;
    onFinish: () => void;
    onSelectFolder: () => void;
    currentPath: string | null;
    settings: AppSettings;
    onUpdateSettings: (updates: Partial<AppSettings>) => void;
    t: (key: string) => string;
    scanProgress?: { processed: number; total: number } | null;
    isScanning: boolean;
}

export const WelcomeModal: React.FC<WelcomeModalProps> = ({ show, onFinish, onSelectFolder, currentPath, settings, onUpdateSettings, t, scanProgress, isScanning }) => {
    const [step, setStep] = useState(1);

    if (!show) return null;

    return (
        <div className="fixed inset-0 z-[200] bg-white dark:bg-gray-950 flex flex-col items-center justify-center p-8 animate-fade-in overflow-hidden">
            {/* Background Decorative Elements */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                {/* Noise Texture to fix banding (color steps) */}
                <div className="absolute inset-0 opacity-[0.3] dark:opacity-[0.4] mix-blend-overlay" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 250 250' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")` }}></div>

                {/* Grid Texture - More distinct and larger points */}
                <div className="absolute inset-0 opacity-[0.15] dark:opacity-[0.1] text-blue-900 dark:text-blue-300" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, currentColor 1.5px, transparent 0)', backgroundSize: '40px 40px' }}></div>
                
                {/* Dynamic Color Blobs - Adjusted for softer blending */}
                <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-blue-400/30 dark:bg-blue-600/15 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: '7s' }}></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[70%] h-[70%] bg-purple-400/30 dark:bg-purple-600/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '2s', animationDuration: '10s' }}></div>
                <div className="absolute top-[20%] right-[10%] w-[45%] h-[45%] bg-cyan-400/25 dark:bg-cyan-600/10 rounded-full blur-[100px] animate-pulse" style={{ animationDelay: '4s', animationDuration: '13s' }}></div>
                <div className="absolute bottom-[20%] left-[10%] w-[40%] h-[40%] bg-indigo-400/30 dark:bg-indigo-600/20 rounded-full blur-[110px] animate-pulse" style={{ animationDelay: '1s', animationDuration: '9s' }}></div>
            </div>

            <div className="relative z-10 max-w-2xl w-full bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden flex flex-col md:flex-row h-[500px]">
                {/* Left Side: Branding & Info */}
                <div className="w-full md:w-1/2 bg-blue-600 p-8 flex flex-col justify-between text-white relative overflow-hidden">
                    <div className="z-10">
                        <div className="flex items-center space-x-2 mb-4">
                            <AuroraLogo size={40} className="shadow-lg" />
                            <span className="font-bold text-xl tracking-wider">AURORA</span>
                        </div>
                        <h1 className="text-3xl font-bold leading-tight mb-4">
                            {step === 1 ? t('welcome.step1Title') : t('welcome.step2Title')}
                        </h1>
                        <p className="text-blue-100 opacity-90">
                            {step === 1 ? t('welcome.step1Desc') : t('welcome.step2Desc')}
                        </p>
                    </div>

                    {/* Decorative Elements */}
                    <div className="absolute -bottom-20 -right-20 w-64 h-64 bg-blue-500 rounded-full opacity-50 blur-3xl"></div>
                    <div className="absolute top-20 -left-20 w-48 h-48 bg-purple-500 rounded-full opacity-30 blur-3xl"></div>

                    {/* Step Indicators */}
                    <div className="flex space-x-2 z-10">
                        <div
                            role="button"
                            aria-label="Go to step 1"
                            onClick={() => setStep(1)}
                            className={`h-1.5 w-8 rounded-full transition-colors ${step === 1 ? 'bg-white cursor-default' : 'bg-white/30 cursor-pointer hover:bg-white/70'}`}
                        />
                        <div
                            role="button"
                            aria-label="Back to step 1"
                            onClick={() => setStep(1)}
                            className={`h-1.5 w-8 rounded-full transition-colors ${step === 2 ? 'bg-white cursor-pointer' : 'bg-white/30 cursor-pointer hover:bg-white/70'}`}
                        />
                    </div>
                </div>

                {/* Right Side: Actions */}
                <div className="w-full md:w-1/2 p-8 flex flex-col relative bg-gray-50 dark:bg-gray-900">
                    {step === 1 && (
                        <div className="flex-1 flex flex-col justify-center space-y-6">
                            <div className="text-center">
                                <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mx-auto mb-4 text-blue-600 dark:text-blue-400">
                                    <HardDrive size={32} />
                                </div>
                                <button
                                    onClick={onSelectFolder}
                                    className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-blue-500/30 transition-all active:scale-95 flex items-center justify-center w-full"
                                >
                                    {t('welcome.selectFolder')}
                                </button>
                            </div>
                            {currentPath && (
                                <div className="bg-gray-100 dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-center">
                                    <div className="text-xs text-gray-500 uppercase font-bold mb-1">{t('welcome.currentPath')}</div>
                                    <div className="text-sm font-mono truncate px-2">{currentPath}</div>
                                    {/* Scan progress indicator (if available) - keep only progress bar here */}
                                    {/* Show progress while scanning, and keep total visible after scanning completes. */}
                                    {(isScanning || (scanProgress && scanProgress.total > 0)) && (
                                        <div className="mt-2">
                                            {scanProgress && scanProgress.total > 0 ? (
                                                <div>
                                                    <div className="text-xs text-gray-500 mb-1">{`${scanProgress.processed} / ${scanProgress.total} ${t('sidebar.files')}`}</div>
                                                    <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                                                        <div className={`h-2 ${isScanning ? 'bg-blue-600 transition-all' : 'bg-green-600'}`} style={{ width: `${Math.round((scanProgress.processed / scanProgress.total) * 100)}%` }}></div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                                                    <div className="h-2 bg-blue-600 animate-pulse w-1/3"></div>
                                                </div>
                                            )}

                                            {isScanning ? (
                                                <div className="mt-2 flex items-center justify-center text-blue-600 dark:text-blue-400">
                                                    <Loader2 size={16} className="animate-spin mr-2" />
                                                    <span className="text-xs font-medium">{t('welcome.scanning')}</span>
                                                </div>
                                            ) : (
                                                <div className="mt-2 flex items-center justify-center text-green-600 dark:text-green-400">
                                                    <svg className="w-4 h-4 mr-2" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 00-1.414-1.414L8 11.172 4.707 7.879a1 1 0 10-1.414 1.414l4 4a1 1 0 001.414 0l8-8z" clipRule="evenodd"/></svg>
                                                    <span className="text-xs font-medium">{t('welcome.scanComplete')}</span>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {step === 2 && (
                        <div className="flex-1 space-y-6 flex flex-col justify-center relative">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.language')}</label>
                                <div className="grid grid-cols-2 gap-3">
                                    {['zh', 'en'].map(lang => (
                                        <button
                                            key={lang}
                                            onClick={() => onUpdateSettings({ language: lang as 'zh' | 'en' })}
                                            className={`px-3 py-2 rounded-lg border text-sm font-medium transition-all ${settings.language === lang ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                                        >
                                            {lang === 'zh' ? '中文' : 'English'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.theme')}</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {['light', 'dark', 'system'].map(theme => (
                                        <button
                                            key={theme}
                                            onClick={() => onUpdateSettings({ theme: theme as 'light' | 'dark' | 'system' })}
                                            className={`px-2 py-2 rounded-lg border text-xs font-medium transition-all flex flex-col items-center justify-center ${settings.theme === theme ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                                        >
                                            {theme === 'light' && <Sun size={16} className="mb-1" />}
                                            {theme === 'dark' && <Moon size={16} className="mb-1" />}
                                            {theme === 'system' && <Monitor size={16} className="mb-1" />}
                                            {t(`settings.theme${theme.charAt(0).toUpperCase() + theme.slice(1)}`)}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Right-bottom hint */}
                            <div className="absolute right-4 bottom-4 text-xs text-gray-500">{t('welcome.step2ColorExtractDesc')}</div>
                        </div>
                    )}

                    <div className="mt-6 flex justify-between items-center pt-6 border-t border-gray-100 dark:border-gray-800">
                        {step === 2 ? (
                            <button
                                onClick={onFinish}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm font-medium px-4"
                            >
                                {t('welcome.skip')}
                            </button>
                        ) : (
                            <div></div>
                        )}
                        <button
                            onClick={() => {
                                if (step === 1) {
                                    if (currentPath) setStep(2);
                                } else {
                                    onFinish();
                                }
                            }}
                            disabled={step === 1 && (!currentPath || isScanning)}
                            className={`px-6 py-2 rounded-full font-bold text-sm transition-all flex items-center ${step === 1 && (!currentPath || isScanning) ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg'}`}
                        >
                            {step === 1 ? t('welcome.next') : t('welcome.finish')}
                            <ChevronRight size={16} className="ml-2" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
