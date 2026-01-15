import React, { useState } from 'react';
import { HardDrive, Sun, Moon, Monitor, ChevronRight } from 'lucide-react';
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
}

export const WelcomeModal: React.FC<WelcomeModalProps> = ({ show, onFinish, onSelectFolder, currentPath, settings, onUpdateSettings, t }) => {
    const [step, setStep] = useState(1);

    if (!show) return null;

    return (
        <div className="fixed inset-0 z-[200] bg-white dark:bg-gray-950 flex flex-col items-center justify-center p-8 animate-fade-in">
            <div className="max-w-2xl w-full bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 overflow-hidden flex flex-col md:flex-row h-[500px]">
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
                        <div className={`h-1.5 w-8 rounded-full transition-colors ${step === 1 ? 'bg-white' : 'bg-white/30'}`}></div>
                        <div className={`h-1.5 w-8 rounded-full transition-colors ${step === 2 ? 'bg-white' : 'bg-white/30'}`}></div>
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
                                </div>
                            )}
                        </div>
                    )}

                    {step === 2 && (
                        <div className="flex-1 space-y-6 flex flex-col justify-center">
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
                            disabled={step === 1 && !currentPath}
                            className={`px-6 py-2 rounded-full font-bold text-sm transition-all flex items-center ${step === 1 && !currentPath ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg'}`}
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
