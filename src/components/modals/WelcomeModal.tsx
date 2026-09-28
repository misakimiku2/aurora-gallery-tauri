import React, { useEffect, useState } from 'react';
import { HardDrive, Sun, Moon, Monitor, ChevronRight, Loader2, Globe, Zap, Server, Smartphone, type LucideIcon } from 'lucide-react';
import { AuroraLogo } from '../Logo';
import { AppSettings, AIConfig } from '../../types';
import { lanShareStart, lanShareStop } from '../../api/tauri-bridge';
import { androidApkDownloadUrl } from '../../api/tauri-bridge/updater';
import { aiService } from '../../services/aiService';

/** 双端下载页（update/android.json homepage 主源；安卓 APK 与桌面安装包同仓发布）。 */
const DOWNLOAD_PAGE_URL = 'https://gitee.com/misakimiku2/aurora_gallery/releases';

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

const WELCOME_STEPS = [1, 2, 3, 4] as const;

const AI_PROVIDERS: { id: AIConfig['provider']; label: string; icon: LucideIcon }[] = [
    // openai=OpenAI 兼容的在线云端 API（对齐设置面板 AISettingsPanel 的「在线云端」档，短标签）
    { id: 'openai', label: 'welcome.aiProviderOnline', icon: Globe },
    { id: 'ollama', label: 'Ollama', icon: Zap },
    { id: 'lmstudio', label: 'LM Studio', icon: Server },
];

const generateAccessCode = (): string => {
    return Math.floor(1000 + Math.random() * 9000).toString();
};

const generateQRCodeUrl = (text: string): string => {
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
};

export const WelcomeModal: React.FC<WelcomeModalProps> = ({ show, onFinish, onSelectFolder, currentPath, settings, onUpdateSettings, t, scanProgress, isScanning }) => {
    const [step, setStep] = useState(1);
    // AI 步：草稿只在点「下一步」时提交（跳过不落盘）；进入该步时以当前设置重置
    const [aiDraft, setAiDraft] = useState<AIConfig>(settings.ai);
    const [aiTesting, setAiTesting] = useState(false);
    const [aiTestResult, setAiTestResult] = useState<'connected' | 'disconnected' | null>(null);
    // 互联步：开关即时起停服务（对齐 LanSharePanel 的 handleToggle），完成时设置已落盘
    const [mobileEnabled, setMobileEnabled] = useState(settings.lanShare.enabled);
    const [mobileStarting, setMobileStarting] = useState(false);
    const [mobileError, setMobileError] = useState<string | null>(null);
    const [serverInfo, setServerInfo] = useState<{ local_ip?: string; port: number } | null>(null);
    // 安卓端下载二维码：优先直连当前版本 APK（后端读发布清单，发版即更新），
    // 取不到（离线/清单异常）回退发行页——扫码落点至少是可下载的页面
    const [androidQrUrl, setAndroidQrUrl] = useState(DOWNLOAD_PAGE_URL);

    useEffect(() => {
        if (step === 3) {
            setAiDraft(settings.ai);
            setAiTestResult(null);
        }
    }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

    // 进互联步时取一次 APK 直链（失败静默——二维码保持发行页，不打断向导）
    useEffect(() => {
        if (step !== 4) return;
        let cancelled = false;
        androidApkDownloadUrl()
            .then(url => {
                if (!cancelled && url) setAndroidQrUrl(url);
            })
            .catch(() => { /* 保持发行页回退 */ });
        return () => { cancelled = true; };
    }, [step]);

    if (!show) return null;

    const stepTitles = [t('welcome.step1Title'), t('welcome.step2Title'), t('welcome.step3Title'), t('welcome.step4Title')];
    const stepDescs = [t('welcome.step1Desc'), t('welcome.step2Desc'), t('welcome.step3Desc'), t('welcome.step4Desc')];
    const isLastStep = step === WELCOME_STEPS.length;

    const goNext = () => {
        if (step === 1) {
            if (currentPath) setStep(2);
            return;
        }
        if (step === 3) {
            onUpdateSettings({ ai: aiDraft });
        }
        setStep(step + 1);
    };

    const handleSkip = () => {
        // 跳过：不落盘直接前进；尾步跳过等价完成
        if (isLastStep) {
            onFinish();
        } else {
            setStep(step + 1);
        }
    };

    const handleMobileToggle = async () => {
        setMobileError(null);
        if (!mobileEnabled) {
            if (!currentPath) {
                setMobileError(t('welcome.mobileNoRoot'));
                return;
            }
            setMobileStarting(true);
            try {
                const accessCode = settings.lanShare.accessCode || generateAccessCode();
                const updates = { ...settings.lanShare, enabled: true, accessCode };
                const info = await lanShareStart(updates, currentPath);
                onUpdateSettings({ lanShare: updates });
                setServerInfo({ local_ip: info.local_ip, port: info.port });
                setMobileEnabled(true);
            } catch (e: any) {
                console.error('Failed to start LAN share from welcome:', e);
                setMobileError(e?.message || t('welcome.mobileStartFailed'));
            } finally {
                setMobileStarting(false);
            }
        } else {
            try {
                await lanShareStop();
                onUpdateSettings({ lanShare: { ...settings.lanShare, enabled: false } });
            } catch (e) {
                console.error('Failed to stop LAN share from welcome:', e);
            }
            setServerInfo(null);
            setMobileEnabled(false);
        }
    };

    const handleAiTest = async () => {
        setAiTesting(true);
        setAiTestResult(null);
        try {
            const res = await aiService.checkConnection(aiDraft);
            setAiTestResult(res.status === 'connected' ? 'connected' : 'disconnected');
        } catch {
            setAiTestResult('disconnected');
        } finally {
            setAiTesting(false);
        }
    };

    const qrContent = serverInfo?.local_ip
        ? JSON.stringify({ type: 'aurora-lan', url: `http://${serverInfo.local_ip}:${serverInfo.port}`, code: settings.lanShare.accessCode })
        : null;

    const endpointValue = aiDraft.provider === 'openai' ? aiDraft.openai.endpoint : aiDraft.provider === 'ollama' ? aiDraft.ollama.endpoint : aiDraft.lmstudio.endpoint;
    const setEndpointValue = (v: string) => {
        setAiDraft(d => ({
            ...d,
            openai: { ...d.openai, endpoint: d.provider === 'openai' ? v : d.openai.endpoint },
            ollama: { ...d.ollama, endpoint: d.provider === 'ollama' ? v : d.ollama.endpoint },
            lmstudio: { ...d.lmstudio, endpoint: d.provider === 'lmstudio' ? v : d.lmstudio.endpoint },
        }));
    };
    const modelValue = aiDraft.provider === 'openai' ? aiDraft.openai.model : aiDraft.provider === 'ollama' ? aiDraft.ollama.model : aiDraft.lmstudio.model;
    const setModelValue = (v: string) => {
        setAiDraft(d => ({
            ...d,
            openai: { ...d.openai, model: d.provider === 'openai' ? v : d.openai.model },
            ollama: { ...d.ollama, model: d.provider === 'ollama' ? v : d.ollama.model },
            lmstudio: { ...d.lmstudio, model: d.provider === 'lmstudio' ? v : d.lmstudio.model },
        }));
    };

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
                            {/* SVG 自带圆角投影 filter，勿再加 box-shadow 类——svg 根元素是矩形盒，会画出方形投影 */}
                            <AuroraLogo size={40} />
                            <span className="font-bold text-xl tracking-wider">AURORA</span>
                        </div>
                        <h1 className="text-3xl font-bold leading-tight mb-4">{stepTitles[step - 1]}</h1>
                        <p className="text-blue-100 opacity-90">{stepDescs[step - 1]}</p>
                    </div>

                    {/* Decorative Elements */}
                    <div className="absolute -bottom-20 -right-20 w-64 h-64 bg-blue-500 rounded-full opacity-50 blur-3xl"></div>
                    <div className="absolute top-20 -left-20 w-48 h-48 bg-purple-500 rounded-full opacity-30 blur-3xl"></div>

                    {/* Step Indicators + 移动端下载入口（仅互联步：扫码即达下载页，双平台安装包同仓发布） */}
                    <div className="z-10 space-y-4">
                        {step === 4 && (
                            <div className="flex items-center gap-3">
                                <img
                                    data-testid="welcome-android-qr"
                                    src={generateQRCodeUrl(androidQrUrl)}
                                    alt="Android download QR"
                                    className="w-20 h-20 rounded-lg bg-white p-1.5"
                                />
                                <div className="text-sm text-blue-100 leading-snug">{t('welcome.scanDownloadAndroid')}</div>
                            </div>
                        )}
                        <div className="flex space-x-2">
                            {WELCOME_STEPS.map(s => (
                                <div
                                    key={s}
                                    role="button"
                                    aria-label={`Go to step ${s}`}
                                    data-testid={`welcome-step-dot-${s}`}
                                    onClick={() => { if (s < step) setStep(s); }}
                                    className={`h-1.5 w-8 rounded-full transition-colors ${step === s ? 'bg-white' : s < step ? 'bg-white/70 cursor-pointer hover:bg-white' : 'bg-white/30'}`}
                                />
                            ))}
                        </div>
                    </div>
                </div>

                {/* Right Side: Actions */}
                <div className="w-full md:w-1/2 p-8 flex flex-col relative bg-gray-50 dark:bg-gray-900 min-h-0">
                    {/* 内容区可滚动：AI 步字段多，固定 500px 卡内不溢出底部按钮（m-auto=短内容居中、长内容可滚） */}
                    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col" data-testid={`welcome-step-content-${step}`}>
                        <div className="m-auto w-full space-y-6">
                        {step === 1 && (
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
                                {currentPath && (
                                    <div className="mt-6 bg-gray-100 dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-center">
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
                            <div className="space-y-6 relative">
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

                        {step === 3 && (
                            <div className="space-y-4 relative">
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('welcome.aiProvider')}</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {AI_PROVIDERS.map(p => (
                                            <button
                                                key={p.id}
                                                data-testid={`welcome-ai-provider-${p.id}`}
                                                onClick={() => { setAiDraft(d => ({ ...d, provider: p.id })); setAiTestResult(null); }}
                                                className={`px-2 py-2 rounded-lg border text-xs font-bold transition-all flex flex-col items-center justify-center ${aiDraft.provider === p.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                                            >
                                                <p.icon size={18} className="mb-1" />
                                                {/* openai 档在欢迎页显示为「在线」短标签（对齐设置面板语义），其余为产品名 */}
                                                {p.id === 'openai' ? t(p.label) : p.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">{t('welcome.aiEndpoint')}</label>
                                    <input
                                        data-testid="welcome-ai-endpoint-input"
                                        value={endpointValue}
                                        onChange={e => setEndpointValue(e.target.value)}
                                        placeholder="http://127.0.0.1:1234"
                                        className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                {aiDraft.provider === 'openai' && (
                                    <div>
                                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1">{t('welcome.aiApiKey')}</label>
                                        <input
                                            data-testid="welcome-ai-apikey-input"
                                            type="password"
                                            value={aiDraft.openai.apiKey}
                                            onChange={e => setAiDraft(d => ({ ...d, openai: { ...d.openai, apiKey: e.target.value } }))}
                                            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                )}
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">{t('welcome.aiModel')}</label>
                                    <input
                                        data-testid="welcome-ai-model-input"
                                        value={modelValue}
                                        onChange={e => setModelValue(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <div className="flex items-center justify-between">
                                    <button
                                        data-testid="welcome-ai-test-button"
                                        onClick={handleAiTest}
                                        disabled={aiTesting}
                                        className="text-sm font-medium px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all disabled:opacity-50"
                                    >
                                        {aiTesting ? t('welcome.aiTesting') : t('welcome.aiTestConnection')}
                                    </button>
                                    {aiTestResult && (
                                        <span data-testid="welcome-ai-test-result" data-state={aiTestResult} className={`text-xs font-bold ${aiTestResult === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                            {aiTestResult === 'connected' ? t('welcome.aiConnected') : t('welcome.aiDisconnected')}
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}

                        {step === 4 && (
                            <div className="space-y-4 relative">
                                <div className="flex items-center justify-center w-14 h-14 mx-auto bg-cyan-100 dark:bg-cyan-900/30 rounded-full text-cyan-600 dark:text-cyan-400">
                                    <Smartphone size={28} />
                                </div>
                                <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3">
                                    <span className="text-sm font-bold text-gray-700 dark:text-gray-300">{t('welcome.mobileEnable')}</span>
                                    <button
                                        data-testid="welcome-mobile-toggle"
                                        onClick={handleMobileToggle}
                                        disabled={mobileStarting}
                                        role="switch"
                                        aria-checked={mobileEnabled}
                                        className={`relative w-12 h-7 rounded-full transition-colors disabled:opacity-50 ${mobileEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
                                    >
                                        <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${mobileEnabled ? 'translate-x-5' : ''}`}></span>
                                    </button>
                                </div>
                                {mobileStarting && (
                                    <div className="flex items-center justify-center text-blue-600 dark:text-blue-400">
                                        <Loader2 size={16} className="animate-spin mr-2" />
                                        <span className="text-xs font-medium">{t('welcome.mobileStarting')}</span>
                                    </div>
                                )}
                                {mobileError && <div className="text-xs text-red-500 text-center">{mobileError}</div>}
                                {mobileEnabled && serverInfo?.local_ip && (
                                    <div data-testid="welcome-mobile-info" className="bg-gray-100 dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-center">
                                        <div className="text-xs text-green-600 dark:text-green-400 font-bold mb-1">{t('welcome.mobileRunning')}</div>
                                        <div className="text-sm font-mono">{`http://${serverInfo.local_ip}:${serverInfo.port}`}</div>
                                        <div className="text-xs text-gray-500 mt-1">{t('welcome.mobileAccessCode')}: {settings.lanShare.accessCode}</div>
                                        {qrContent && <img src={generateQRCodeUrl(qrContent)} alt="QR" className="w-28 h-28 mx-auto mt-2 rounded" />}
                                    </div>
                                )}
                                <div className="text-xs text-gray-500 text-center">{t('welcome.mobileHint')}</div>
                            </div>
                        )}
                        </div>
                    </div>

                    <div className="mt-6 flex justify-between items-center pt-6 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
                        {(step === 3 || step === 4) ? (
                            <button
                                data-testid="welcome-skip-button"
                                onClick={handleSkip}
                                className="whitespace-nowrap flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm font-medium px-4 py-2"
                            >
                                {t('welcome.skip')}
                            </button>
                        ) : (
                            <div></div>
                        )}
                        <button
                            data-testid="welcome-next-button"
                            onClick={() => { if (isLastStep) onFinish(); else goNext(); }}
                            disabled={step === 1 && (!currentPath || isScanning) || (step === 4 && mobileStarting)}
                            className={`whitespace-nowrap flex-shrink-0 px-6 py-2 rounded-full font-bold text-sm transition-all flex items-center ${step === 1 && (!currentPath || isScanning) || (step === 4 && mobileStarting) ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg'}`}
                        >
                            {isLastStep ? t('welcome.finish') : t('welcome.next')}
                            <ChevronRight size={16} className="ml-2" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
