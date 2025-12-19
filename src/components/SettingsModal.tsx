import React, { useState, useEffect } from 'react';
import { Settings, Sliders, Palette, Database, Globe, Check, Sun, Moon, Monitor, WifiOff, Download, Upload, Brain, Activity, Zap, Server, ChevronRight, XCircle, LogOut, HelpCircle, Languages } from 'lucide-react';
import { AppState, SettingsCategory, AppSettings } from '../types';

interface SettingsModalProps {
  state: AppState;
  onClose: () => void;
  onUpdateSettings: (updates: Partial<AppState>) => void;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
  onUpdatePath: (type: 'resource') => void;
  t: (key: string) => string;
  onUpdateAIConnectionStatus: (status: 'checking' | 'connected' | 'disconnected') => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ state, onClose, onUpdateSettings, onUpdateSettingsData, onUpdatePath, onUpdateAIConnectionStatus, t }) => {
  // ... (keep existing state and checkConnection logic)
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  // Use AI connection status from AppState instead of local state
  const connectionStatus = state.aiConnectionStatus;

  const checkConnection = async (manual: boolean = false) => {
      // ... (keep existing implementation)
      if (manual) {
          setIsTesting(true);
          setTestStatus('testing');
      } else {
          onUpdateAIConnectionStatus('checking');
      }

      try {
          const { provider, openai, ollama, lmstudio } = state.settings.ai;
          let url = '';
          let headers: Record<string, string> = {};

          const cleanUrl = (u: string) => u.replace(/\/+$/, '');

          if (provider === 'openai') {
              url = `${cleanUrl(openai.endpoint)}/models`;
              headers = { 'Authorization': `Bearer ${openai.apiKey}` };
          } else if (provider === 'ollama') {
              url = `${cleanUrl(ollama.endpoint)}/api/tags`;
          } else if (provider === 'lmstudio') {
              let ep = cleanUrl(lmstudio.endpoint);
              if (!ep.endsWith('/v1')) {
                  ep = `${ep}/v1`;
              }
              url = `${ep}/models`;
          }

          let result: any = null;
          let isError = false;
          
          const res = await fetch(url, { method: 'GET', headers });
          if (!res.ok) {
              isError = true;
          } else {
              result = await res.json();
          }
          
          if (isError) {
              if (manual) {
                  setTestStatus('failed');
              }
              onUpdateAIConnectionStatus('disconnected');
          } else {
              if (manual) {
                  setTestStatus('success');
              }
              onUpdateAIConnectionStatus('connected');
          }

          if (provider === 'lmstudio' && result && result.data && Array.isArray(result.data) && result.data.length > 0) {
              const detectedModel = result.data[0].id;
              if (detectedModel !== state.settings.ai.lmstudio.model) {
                  onUpdateSettingsData({ ai: { ...state.settings.ai, lmstudio: { ...state.settings.ai.lmstudio, model: detectedModel } } });
              }
          }

      } catch (e) {
          console.error(e);
          if (manual) {
              setTestStatus('failed');
          }
          onUpdateAIConnectionStatus('disconnected');
      } finally {
          if (manual) setIsTesting(false);
      }
  };

  useEffect(() => {
      if (state.settingsCategory === 'ai') {
          const timer = setTimeout(() => {
              checkConnection(false);
          }, 500); 
          return () => clearTimeout(timer);
      }
  }, [state.settingsCategory, state.settings.ai.provider, state.settings.ai.openai.endpoint, state.settings.ai.ollama.endpoint, state.settings.ai.lmstudio.endpoint, state.settings.ai.openai.apiKey]);

  const handleExportData = () => {
    // ... (keep existing implementation)
    const dataToExport = {
      tags: state.customTags,
      people: state.people
    };
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aurora_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportData = (e: React.ChangeEvent<HTMLInputElement>) => {
    // ... (keep existing implementation)
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        if (json.tags || json.people) {
           const newTags = json.tags && Array.isArray(json.tags) ? json.tags : [];
           const newPeople = json.people && typeof json.people === 'object' ? json.people : {};
           
           const combinedTags = Array.from(new Set([...state.customTags, ...newTags]));
           const combinedPeople = { ...state.people, ...newPeople };
           
           onUpdateSettings({ customTags: combinedTags, people: combinedPeople });
           alert(t('settings.importSuccess'));
        } else {
           throw new Error('Invalid format');
        }
      } catch (err) {
        console.error(err);
        alert(t('settings.importError'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-8 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-xl w-[900px] h-[600px] shadow-2xl border border-gray-200 dark:border-gray-600 flex overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>
          
          <div className="w-64 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col">
              {/* ... (Sidebar buttons, same as before) ... */}
              <div className="p-6">
                 <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center">
                     <Settings size={24} className="mr-2 text-blue-500"/> {t('settings.title')}
                 </h2>
              </div>
              <div className="flex-1 px-4 space-y-1">
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'general' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'general' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <Sliders size={18} className="mr-3"/> {t('settings.catGeneral')}
                  </button>
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'ai' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'ai' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <Brain size={18} className="mr-3"/> {t('settings.catAi')}
                  </button>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-800">
                  <button 
                     onClick={onClose} 
                     className="w-full py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-sm text-gray-800 dark:text-gray-200 transition-colors"
                  >
                     {t('viewer.done')}
                  </button>
              </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8">
              {state.settingsCategory === 'general' && (
                 /* ... General Settings Content ... */
                 <div className="space-y-8 animate-fade-in">
                     <section>
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-b border-gray-100 dark:border-gray-700 pb-2">{t('settings.catGeneral')}</h3>
                         <div className="space-y-6">
                             <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.language')}</label>
                                <div className="flex space-x-3">
                                    {['zh', 'en'].map(lang => (
                                        <button
                                            key={lang}
                                            onClick={() => onUpdateSettingsData({ language: lang as any })}
                                            className={`px-4 py-2 rounded border text-sm flex items-center ${state.settings.language === lang ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700'}`}
                                        >
                                            <Globe size={14} className="mr-2"/>
                                            {lang === 'zh' ? '中文' : 'English'}
                                        </button>
                                    ))}
                                </div>
                             </div>
                             
                             <div className="bg-gray-50 dark:bg-gray-700/30 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                                 <div className="flex items-center justify-between mb-3">
                                     <div>
                                        <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.autoStart')}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.autoStartDesc')}</div>
                                     </div>
                                     <button 
                                        onClick={() => {
                                        const newValue = !state.settings.autoStart;
                                        onUpdateSettingsData({ autoStart: newValue });
                                    }}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${state.settings.autoStart ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                      >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${state.settings.autoStart ? 'translate-x-6' : 'translate-x-1'}`} />
                                      </button>
                                 </div>
                                 
                                 <div className="flex items-center justify-between mb-3 pt-3 border-t border-gray-200 dark:border-gray-600">
                                     <div>
                                        <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.animateOnHover')}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.animateOnHoverDesc')}</div>
                                     </div>
                                     <button 
                                        onClick={() => {
                                            const newValue = !state.settings.animateOnHover;
                                            onUpdateSettingsData({ animateOnHover: newValue });
                                        }}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${state.settings.animateOnHover ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                      >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${state.settings.animateOnHover ? 'translate-x-6' : 'translate-x-1'}`} />
                                      </button>
                                 </div>
                                 
                                 <div className="pt-3 border-t border-gray-200 dark:border-gray-600">
                                     <div className="flex items-center justify-between">
                                         <span className="font-bold text-gray-800 dark:text-gray-200">{t('settings.exitAction')}</span>
                                         <select 
                                            value={state.settings.exitAction || 'ask'} 
                                            onChange={(e) => onUpdateSettingsData({ exitAction: e.target.value as any })}
                                            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm outline-none text-gray-800 dark:text-gray-200"
                                         >
                                             <option value="ask">{t('settings.exitActionAsk')}</option>
                                             <option value="minimize">{t('settings.exitActionMinimize')}</option>
                                             <option value="exit">{t('settings.exitActionExit')}</option>
                                         </select>
                                     </div>
                                 </div>
                             </div>
                         </div>
                     </section>

                     <section className="mt-8 border-t border-gray-100 dark:border-gray-700 pt-6">
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Palette size={20} className="mr-2 text-blue-500"/> {t('settings.catAppearance')}</h3>
                         <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-4">{t('settings.theme')}</label>
                            <div className="grid grid-cols-3 gap-4">
                                {['light', 'dark', 'system'].map(mode => (
                                    <button
                                        key={mode}
                                        onClick={() => onUpdateSettingsData({ theme: mode as any })}
                                        className={`relative rounded-lg border-2 p-1 overflow-hidden group ${state.settings.theme === mode ? 'border-blue-500' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'}`}
                                    >
                                        <div className={`h-24 rounded flex items-center justify-center mb-2 ${mode === 'light' ? 'bg-white border border-gray-200' : mode === 'dark' ? 'bg-gray-900 border border-gray-700' : 'bg-gradient-to-br from-gray-200 to-gray-800'}`}>
                                             {mode === 'light' && <Sun size={24} className="text-gray-400"/>}
                                             {mode === 'dark' && <Moon size={24} className="text-gray-500"/>}
                                             {mode === 'system' && <Monitor size={24} className="text-gray-300"/>}
                                        </div>
                                        <div className="text-center text-xs font-medium text-gray-600 dark:text-gray-400 py-1">
                                            {mode === 'light' ? t('settings.themeLight') : mode === 'dark' ? t('settings.themeDark') : t('settings.themeSystem')}
                                        </div>
                                        {state.settings.theme === mode && (
                                            <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5">
                                                <Check size={12} strokeWidth={3}/>
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                         </div>
                     </section>

                     <section className="mt-8 border-t border-gray-100 dark:border-gray-700 pt-6">
                        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Database size={20} className="mr-2 text-blue-500"/> {t('settings.catStorage')}</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.resourceRoot')}</label>
                                <div className="flex items-center">
                                    <div className="flex-1 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-l px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate font-mono">
                                        {state.settings.paths.resourceRoot}
                                    </div>
                                    <button 
                                        onClick={() => onUpdatePath('resource')}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium rounded-r"
                                    >
                                        {t('settings.change')}
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.cacheRoot')}</label>
                                <div className="flex items-center">
                                    <div className="flex-1 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-l px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate font-mono">
                                        {state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : t('settings.notSet')}
                                    </div>
                                    <button 
                                        onClick={() => {
                                            const cachePath = state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : '';
                                            if (cachePath) {
                                                import('../api/tauri-bridge').then(({ openPath }) => {
                                                    openPath(cachePath);
                                                });
                                            }
                                        }}
                                        disabled={!state.settings.paths.resourceRoot}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium rounded-r border border-l-0 border-blue-600"
                                    >
                                        打开
                                    </button>
                                </div>
                            </div>
                        </div>
                     </section>

                     <section className="mt-8 border-t border-gray-100 dark:border-gray-700 pt-6">
                        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Database size={20} className="mr-2 text-blue-500"/> {t('settings.dataBackup')}</h3>
                        <div className="flex space-x-4">
                            <button 
                                onClick={handleExportData}
                                className="flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-gray-200 dark:border-gray-700"
                            >
                                <Download size={16} className="mr-2"/>
                                {t('settings.exportTags')}
                            </button>
                            <div className="relative">
                                <input 
                                    type="file" 
                                    id="import-file" 
                                    name="import-file"
                                    accept=".json" 
                                    onChange={handleImportData} 
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                />
                                <button 
                                    className="flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-gray-200 dark:border-gray-700 pointer-events-none"
                                >
                                    <Upload size={16} className="mr-2"/>
                                    {t('settings.importTags')}
                                </button>
                            </div>
                        </div>
                     </section>
                 </div>
              )}

              {state.settingsCategory === 'ai' && (
                  <div className="space-y-8 animate-fade-in">
                      <section>
                          {/* ... Provider selection ... */}
                          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 pb-2 mb-4">
                              <h3 className="text-lg font-bold text-gray-800 dark:text-white flex items-center">
                                  <Brain size={20} className="mr-2 text-purple-500"/> {t('settings.catAi')}
                              </h3>
                              <div className={`flex items-center px-2 py-1 rounded text-xs font-bold ${
                                  connectionStatus === 'connected' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                  connectionStatus === 'disconnected' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                  'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                              }`}>
                                  {connectionStatus === 'connected' && <Check size={12} className="mr-1"/>}
                                  {connectionStatus === 'disconnected' && <XCircle size={12} className="mr-1"/>}
                                  {connectionStatus === 'checking' && <Activity size={12} className="mr-1 animate-spin"/>}
                                  {connectionStatus === 'connected' ? t('settings.statusConnected') : 
                                   connectionStatus === 'disconnected' ? t('settings.statusDisconnected') : 
                                   t('settings.statusChecking')}
                              </div>
                          </div>
                          
                          {/* ... (Existing Provider UI) ... */}
                          <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.aiProvider')}</label>
                          <div className="grid grid-cols-3 gap-3 mb-6">
                              {[
                                  { id: 'ollama', icon: Zap, label: t('settings.aiProviderLocal') },
                                  { id: 'openai', icon: Globe, label: t('settings.aiProviderOnline') },
                                  { id: 'lmstudio', icon: Server, label: t('settings.aiProviderLmStudio') }
                              ].map((item) => (
                                  <button
                                      key={item.id}
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, provider: item.id as any } })}
                                      className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all ${
                                          state.settings.ai.provider === item.id 
                                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' 
                                          : 'border-gray-200 dark:border-gray-700 hover:border-purple-300 dark:hover:border-purple-700 text-gray-600 dark:text-gray-400'
                                      }`}
                                  >
                                      <item.icon size={24} className="mb-2"/>
                                      <span className="text-xs font-bold text-center">{item.label}</span>
                                      {state.settings.ai.provider === item.id && (
                                          <div className="absolute top-2 right-2 bg-purple-500 text-white rounded-full p-0.5">
                                              <Check size={10} strokeWidth={3}/>
                                          </div>
                                      )}
                                  </button>
                              ))}
                          </div>

                          {/* AI Model Connection Steps */}
                          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-5 border border-blue-200 dark:border-blue-800 space-y-3 mb-6">
                              <h4 className="text-sm font-bold text-blue-700 dark:text-blue-400 flex items-center">
                                  <HelpCircle size={16} className="mr-2"/>
                                  {t('settings.connectionSteps')}
                              </h4>
                              
                              {state.settings.ai.provider === 'ollama' && (
                                  <div className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                                      <ol className="list-decimal list-inside space-y-1">
                                          <li>{t('settings.ollamaStep1')}</li>
                                          <li>{t('settings.ollamaStep2')}</li>
                                          <li>{t('settings.ollamaStep3')}</li>
                                          <li>{t('settings.ollamaStep4')}</li>
                                          <li>{t('settings.ollamaStep5')}</li>
                                      </ol>
                                  </div>
                              )}
                              
                              {state.settings.ai.provider === 'openai' && (
                                  <div className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                                      <ol className="list-decimal list-inside space-y-1">
                                          <li>{t('settings.openaiStep1')}</li>
                                          <li>{t('settings.openaiStep2')}</li>
                                          <li>{t('settings.openaiStep3')}</li>
                                          <li>{t('settings.openaiStep4')}</li>
                                          <li>{t('settings.openaiStep5')}</li>
                                      </ol>
                                  </div>
                              )}
                              
                              {state.settings.ai.provider === 'lmstudio' && (
                                  <div className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                                      <ol className="list-decimal list-inside space-y-1">
                                          <li>{t('settings.lmStudioStep1')}</li>
                                          <li>{t('settings.lmStudioStep2')}</li>
                                          <li>{t('settings.lmStudioStep3')}</li>
                                          <li>{t('settings.lmStudioStep4')}</li>
                                          <li>{t('settings.lmStudioStep5')}</li>
                                      </ol>
                                  </div>
                              )}
                          </div>

                          <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-5 border border-gray-200 dark:border-gray-700 space-y-4">
                              {state.settings.ai.provider === 'openai' && (
                                  <>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-endpoint">{t('settings.endpoint')}</label>
                                          <input 
                                              type="text" 
                                              id="openai-endpoint"
                                              name="openai-endpoint"
                                              value={state.settings.ai.openai.endpoint}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, openai: { ...state.settings.ai.openai, endpoint: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="https://api.openai.com/v1"
                                          />
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-api-key">{t('settings.apiKey')}</label>
                                          <input 
                                              type="password" 
                                              id="openai-api-key"
                                              name="openai-api-key"
                                              value={state.settings.ai.openai.apiKey}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, openai: { ...state.settings.ai.openai, apiKey: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="sk-..."
                                          />
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-model">{t('settings.aiModel')}</label>
                                          <input 
                                              type="text" 
                                              id="openai-model"
                                              name="openai-model"
                                              value={state.settings.ai.openai.model}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, openai: { ...state.settings.ai.openai, model: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="gpt-4o"
                                          />
                                      </div>
                                  </>
                              )}

                              {state.settings.ai.provider === 'ollama' && (
                                  <>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ollama-endpoint">{t('settings.endpoint')}</label>
                                          <input 
                                              type="text" 
                                              id="ollama-endpoint"
                                              name="ollama-endpoint"
                                              value={state.settings.ai.ollama.endpoint}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, ollama: { ...state.settings.ai.ollama, endpoint: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="http://localhost:11434"
                                          />
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ollama-model">{t('settings.aiModelVision')}</label>
                                          <input 
                                              type="text" 
                                              id="ollama-model"
                                              name="ollama-model"
                                              value={state.settings.ai.ollama.model}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, ollama: { ...state.settings.ai.ollama, model: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="llava"
                                          />
                                      </div>
                                  </>
                              )}

                              {state.settings.ai.provider === 'lmstudio' && (
                                  <>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="lmstudio-endpoint">{t('settings.lmStudioEndpoint')}</label>
                                          <input 
                                              type="text" 
                                              id="lmstudio-endpoint"
                                              name="lmstudio-endpoint"
                                              value={state.settings.ai.lmstudio.endpoint}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, lmstudio: { ...state.settings.ai.lmstudio, endpoint: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="http://localhost:1234/v1"
                                          />
                                          <div className="text-[10px] text-gray-400 mt-1">{t('settings.lmStudioVersionHint')}</div>
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="lmstudio-model">{t('settings.aiModelOptional')}</label>
                                          <input 
                                              type="text" 
                                              id="lmstudio-model"
                                              name="lmstudio-model"
                                              value={state.settings.ai.lmstudio.model}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, lmstudio: { ...state.settings.ai.lmstudio, model: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="local-model"
                                          />
                                      </div>
                                  </>
                              )}
                          </div>

                          <div className="mt-6">
                              <button 
                                  onClick={() => checkConnection(true)}
                                  disabled={isTesting}
                                  className={`w-full py-2.5 rounded-lg text-sm font-bold flex items-center justify-center transition-all ${
                                      testStatus === 'success' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                      testStatus === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                      'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/30'
                                  }`}
                              >
                                  {isTesting ? <Activity size={16} className="mr-2 animate-spin"/> : <Zap size={16} className="mr-2"/>}
                                  {isTesting ? t('settings.testing') : 
                                   testStatus === 'success' ? t('settings.connectionSuccess') : 
                                   testStatus === 'failed' ? t('settings.connectionFailed') : 
                                   t('settings.testConnection')}
                              </button>
                          </div>

                          <div className="mt-6 space-y-3">
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoTag')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, autoTag: !state.settings.ai.autoTag } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.autoTag ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.autoTag ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoDescription')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, autoDescription: !state.settings.ai.autoDescription } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.autoDescription ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.autoDescription ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              <div className="flex items-center justify-between pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                                  <span className={`text-sm font-medium ${state.settings.ai.autoDescription ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}>{t('settings.aiEnhancePersonDesc')}</span>
                                  <button 
                                      onClick={() => {
                                          if (state.settings.ai.autoDescription) {
                                              onUpdateSettingsData({ ai: { ...state.settings.ai, enhancePersonDescription: !state.settings.ai.enhancePersonDescription } });
                                          }
                                      }}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${state.settings.ai.autoDescription ? (state.settings.ai.enhancePersonDescription ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600') : 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enhancePersonDescription ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiFaceRec')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, enableFaceRecognition: !state.settings.ai.enableFaceRecognition } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.enableFaceRecognition ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enableFaceRecognition ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              
                              <div className="flex items-center justify-between pl-4 border-l-2 border-gray-200 dark:border-gray-700">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoAddPeople')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, autoAddPeople: !state.settings.ai.autoAddPeople } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.autoAddPeople ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.autoAddPeople ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>

                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiEnableOCR')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, enableOCR: !state.settings.ai.enableOCR } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.enableOCR ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enableOCR ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>

                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiEnableTranslation')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, enableTranslation: !state.settings.ai.enableTranslation } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.enableTranslation ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enableTranslation ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>

                              {state.settings.ai.enableTranslation && (
                                  <div className="flex items-center justify-between pl-4 border-l-2 border-gray-200 dark:border-gray-700 animate-fade-in">
                                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiTargetLang')}</span>
                                      <div className="flex space-x-2">
                                          {[
                                              { code: 'zh', label: '中文' },
                                              { code: 'en', label: 'English' },
                                              { code: 'ja', label: '日本語' },
                                              { code: 'ko', label: '한국어' }
                                          ].map(lang => (
                                              <button
                                                  key={lang.code}
                                                  onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, targetLanguage: lang.code as any } })}
                                                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                                                      state.settings.ai.targetLanguage === lang.code
                                                          ? 'bg-purple-500 text-white border-purple-500'
                                                          : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-purple-400'
                                                  }`}
                                              >
                                                  {lang.label}
                                              </button>
                                          ))}
                                      </div>
                                  </div>
                              )}
                              
                              <div className="pt-4">
                                  <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ai-confidence">{t('settings.aiConfidence')} ({Math.round(state.settings.ai.confidenceThreshold * 100)}%)</label>
                                  <input 
                                      type="range" 
                                      id="ai-confidence"
                                      name="ai-confidence"
                                      min="0.1" 
                                      max="0.9" 
                                      step="0.05"
                                      value={state.settings.ai.confidenceThreshold}
                                      onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, confidenceThreshold: parseFloat(e.target.value) } })}
                                      className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                                  />
                              </div>
                          </div>


                      </section>
                  </div>
              )}
          </div>
      </div>
    </div>
  );
};