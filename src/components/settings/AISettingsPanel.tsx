import React, { useState, useEffect } from 'react';
import { Brain, Check, XCircle, Activity, Zap, Globe, Server, HelpCircle, ChevronUp, ChevronDown, Save, PlusCircle, Trash2, RefreshCw } from 'lucide-react';
import { AIConfig, AppSettings, AIModelOption, AI_SERVICE_PRESETS } from '../../types';
import { aiService } from '../../services/aiService';
import { openExternalLink } from '../../api/tauri-bridge';

// AI 服务配置面板组件
interface AISettingsPanelProps {
  t: (key: string) => string;
  ai: AIConfig;
  connectionStatus: 'checking' | 'connected' | 'disconnected';
  isAndroid: boolean;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
  onUpdateAIConnectionStatus: (status: 'checking' | 'connected' | 'disconnected') => void;
}

const AISettingsPanel: React.FC<AISettingsPanelProps> = ({ t, ai, connectionStatus, isAndroid, onUpdateSettingsData, onUpdateAIConnectionStatus }) => {
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  const [showConnectionSteps, setShowConnectionSteps] = useState(false);
  const [editingPresetName, setEditingPresetName] = useState('');

  useEffect(() => {
    const currentPreset = ai.promptPresets?.find(p => p.id === ai.currentPresetId);
    if (currentPreset) {
      setEditingPresetName(currentPreset.name);
    } else {
      setEditingPresetName(t('settings.newPresetName'));
    }
  }, [ai.currentPresetId, ai.promptPresets?.length]);

  const checkConnection = async (manual: boolean = false) => {
    if (manual) {
      setIsTesting(true);
      setTestStatus('testing');
    } else {
      onUpdateAIConnectionStatus('checking');
    }

    try {
      const res = await aiService.checkConnection(ai);

      if (res.status === 'connected') {
        if (manual) setTestStatus('success');
        onUpdateAIConnectionStatus('connected');
      } else {
        if (manual) setTestStatus('failed');
        onUpdateAIConnectionStatus('disconnected');
      }

      if (ai.provider === 'lmstudio' && res.result && res.result.data && Array.isArray(res.result.data) && res.result.data.length > 0) {
        const detectedModel = res.result.data[0].id;
        if (detectedModel !== ai.lmstudio.model) {
          onUpdateSettingsData({ ai: { ...ai, lmstudio: { ...ai.lmstudio, model: detectedModel } } });
        }
      }
    } catch (e) {
      console.error(e);
      if (manual) setTestStatus('failed');
      onUpdateAIConnectionStatus('disconnected');
    } finally {
      if (manual) setIsTesting(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      checkConnection(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [ai.provider, ai.openai.endpoint, ai.ollama.endpoint, ai.lmstudio.endpoint, ai.openai.apiKey]);

  // 动态模型列表状态
  const [dynamicModels, setDynamicModels] = useState<Record<string, AIModelOption[]>>({});
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const [lastFetchedPresetId, setLastFetchedPresetId] = useState<string | null>(null);

  // 加载缓存的模型列表
  useEffect(() => {
    const loadCachedModels = () => {
      const cached: Record<string, AIModelOption[]> = {};
      AI_SERVICE_PRESETS.forEach(preset => {
        if (preset.id !== 'custom') {
          const models = aiService.getCachedModels(preset.id);
          if (models && models.length > 0) {
            cached[preset.id] = models;
          }
        }
      });
      setDynamicModels(cached);
    };
    loadCachedModels();
  }, []);

  // 刷新模型列表
  const handleFetchModels = async () => {
    const presetId = ai.onlineServicePreset;
    if (!presetId || presetId === 'custom') return;

    const preset = AI_SERVICE_PRESETS.find(p => p.id === presetId);
    if (!preset) return;

    // 如果没有 API Key，提示用户
    if (!ai.openai.apiKey) {
      setFetchModelsError(t('settings.apiKeyRequired') || '请先输入 API Key');
      return;
    }

    setIsFetchingModels(true);
    setFetchModelsError(null);
    setLastFetchedPresetId(null);

    try {
      const { models, fromApi } = await aiService.fetchModels(
        presetId,
        ai.openai.apiKey,
        presetId === 'custom' ? ai.openai.endpoint : undefined
      );

      if (models.length > 0) {
        setDynamicModels(prev => ({
          ...prev,
          [presetId]: models
        }));
        // 只有真正从 API 获取成功才显示成功提示
        if (fromApi) {
          setLastFetchedPresetId(presetId);
        } else {
          setFetchModelsError(t('settings.fetchModelsFailed') || '获取模型列表失败，显示预设模型');
        }
      } else {
        setFetchModelsError(t('settings.fetchModelsEmpty') || '未获取到模型列表');
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
      setFetchModelsError(t('settings.fetchModelsFailed') || '获取模型列表失败');
    } finally {
      setIsFetchingModels(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <section>
        <div className="flex items-center justify-between border-subtle pb-2 mb-4">
          <h3 className="text-lg font-bold text-gray-800 dark:text-white flex items-center">
            <Brain size={20} className="mr-2 text-purple-500" /> {t('settings.catAi')}
          </h3>
          <div className="flex items-center space-x-3">
            <div className={`flex items-center px-2 py-1 rounded text-xs font-bold ${connectionStatus === 'connected' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
              connectionStatus === 'disconnected' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
              }`}>
              {connectionStatus === 'connected' && <Check size={12} className="mr-1" />}
              {connectionStatus === 'disconnected' && <XCircle size={12} className="mr-1" />}
              {connectionStatus === 'checking' && <Activity size={12} className="mr-1 animate-spin" />}
              {connectionStatus === 'connected' ? t('settings.statusConnected') :
                connectionStatus === 'disconnected' ? t('settings.statusDisconnected') :
                  t('settings.statusChecking')}
            </div>
            <button
              onClick={() => checkConnection(true)}
              disabled={isTesting}
              title={t('settings.testConnection')}
              className={`inline-flex items-center px-3 py-1 text-xs font-bold rounded transition-colors bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              {isTesting ? <Activity size={12} className="mr-1 animate-spin" /> : <Zap size={12} className="mr-1" />}
              <span className="hidden sm:inline text-[11px]">{isTesting ? t('settings.testing') : t('settings.testConnection')}</span>
            </button>
          </div>
        </div>

        <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.aiProvider')}</label>
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { id: 'ollama', icon: Zap, label: t('settings.aiProviderLocal') },
            { id: 'openai', icon: Globe, label: t('settings.aiProviderOnline') },
            { id: 'lmstudio', icon: Server, label: t('settings.aiProviderLmStudio') }
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => onUpdateSettingsData({ ai: { ...ai, provider: item.id as any } })}
              className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all ${ai.provider === item.id
                ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300'
                : 'border-subtle hover:border-purple-300 dark:hover:border-purple-700 text-gray-600 dark:text-gray-400'
                }`}
            >
              <item.icon size={24} className="mb-2" />
              <span className="text-xs font-bold text-center">{item.label}</span>
              {ai.provider === item.id && (
                <div className="absolute top-2 right-2 bg-purple-500 text-white rounded-full p-0.5">
                  <Check size={10} strokeWidth={3} />
                </div>
              )}
            </button>
          ))}
        </div>

        {/* AI Model Connection Steps */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-5 space-y-3 mb-6">
          <button
            onClick={() => setShowConnectionSteps(!showConnectionSteps)}
            className="w-full flex items-center justify-between text-sm font-bold text-blue-700 dark:text-blue-400"
          >
            <span className="flex items-center">
              <HelpCircle size={16} className="mr-2" />
              {t('settings.connectionSteps')}
            </span>
            {showConnectionSteps ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showConnectionSteps && (
            <>
          {ai.provider === 'ollama' && (
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

          {ai.provider === 'openai' && (
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

          {ai.provider === 'lmstudio' && (
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
            </>
          )}
        </div>

        <div className="bg-surface rounded-xl p-5 border border-subtle space-y-4">
          {ai.provider === 'openai' && (
            <>
              {/* 服务商和模型选择 - 左右布局 */}
              <div className="grid grid-cols-2 gap-4">
                {/* 服务商下拉选择 */}
                <div>
                  <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-2">{t('settings.aiService') || 'AI 服务商'}</label>
                  <select
                    value={ai.onlineServicePreset || ''}
                    onChange={(e) => {
                      const presetId = e.target.value;
                      const preset = AI_SERVICE_PRESETS.find(p => p.id === presetId);
                      if (preset) {
                        // 切换服务商时清除错误状态和成功提示
                        setFetchModelsError(null);
                        setLastFetchedPresetId(null);

                        const newSettings = {
                          ...ai,
                          onlineServicePreset: presetId,
                          openai: {
                            ...ai.openai,
                            endpoint: preset.endpoint,
                            model: preset.models.find(m => m.recommended)?.id || preset.models[0].id
                          }
                        };
                        onUpdateSettingsData({ ai: newSettings });
                      }
                    }}
                    className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                  >
                    {AI_SERVICE_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 模型下拉选择 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-bold text-gray-500 dark:text-gray-400">{t('settings.aiModel')}</label>
                    {ai.onlineServicePreset && ai.onlineServicePreset !== 'custom' && (
                      <div className="flex items-center gap-2">
                        {dynamicModels[ai.onlineServicePreset] && (
                          <button
                            onClick={() => {
                              aiService.clearModelsCache(ai.onlineServicePreset);
                              setDynamicModels(prev => {
                                const newModels = { ...prev };
                                delete newModels[ai.onlineServicePreset!];
                                return newModels;
                              });
                            }}
                            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-red-500 transition-colors"
                            title={t('settings.clearModelsCache') || '清除模型缓存'}
                          >
                            <Trash2 size={10} />
                            {t('settings.clearCache') || '清除'}
                          </button>
                        )}
                        <button
                          onClick={handleFetchModels}
                          disabled={isFetchingModels}
                          className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
                          title={t('settings.fetchModels') || '获取最新模型列表'}
                        >
                          <RefreshCw size={10} className={isFetchingModels ? 'animate-spin' : ''} />
                          {isFetchingModels ? (t('settings.fetchingModels') || '获取中...') : (t('settings.refreshModels') || '刷新')}
                        </button>
                      </div>
                    )}
                  </div>
                  {ai.onlineServicePreset && ai.onlineServicePreset !== 'custom' ? (
                    <>
                      <select
                        value={ai.openai.model}
                        onChange={(e) => onUpdateSettingsData({
                          ai: {
                            ...ai,
                            openai: { ...ai.openai, model: e.target.value }
                          }
                        })}
                        className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                      >
                        {/* 优先显示动态获取的模型列表 */}
                        {(dynamicModels[ai.onlineServicePreset] ||
                          AI_SERVICE_PRESETS.find(p => p.id === ai.onlineServicePreset)?.models || []
                        ).map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} {model.recommended ? '(推荐)' : ''}
                          </option>
                        ))}
                      </select>
                      {fetchModelsError && (
                        <div className="text-[10px] text-red-500 mt-1">{fetchModelsError}</div>
                      )}
                      {lastFetchedPresetId === ai.onlineServicePreset && !fetchModelsError && (
                        <div className="text-[10px] text-green-600 dark:text-green-400 mt-1">
                          {t('settings.modelsUpdated') || '已获取最新模型列表'}
                        </div>
                      )}
                    </>
                  ) : (
                    <input
                      type="text"
                      value={ai.openai.model}
                      onChange={(e) => onUpdateSettingsData({ ai: { ...ai, openai: { ...ai.openai, model: e.target.value } } })}
                      className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                      placeholder="输入模型名称..."
                    />
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-endpoint">{t('settings.endpoint')}</label>
                <input
                  type="text"
                  id="openai-endpoint"
                  name="openai-endpoint"
                  value={ai.openai.endpoint}
                  onChange={(e) => onUpdateSettingsData({ ai: { ...ai, openai: { ...ai.openai, endpoint: e.target.value } } })}
                  className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-api-key">{t('settings.apiKey')}</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    id="openai-api-key"
                    name="openai-api-key"
                    value={ai.openai.apiKey}
                    onChange={(e) => onUpdateSettingsData({ ai: { ...ai, openai: { ...ai.openai, apiKey: e.target.value } } })}
                    className="flex-1 bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                    placeholder={AI_SERVICE_PRESETS.find(p => p.id === ai.onlineServicePreset)?.apiKeyPlaceholder || 'sk-...'}
                  />
                  {AI_SERVICE_PRESETS.find(p => p.id === ai.onlineServicePreset)?.apiKeyHelpUrl && (
                    <button
                      onClick={() => openExternalLink(AI_SERVICE_PRESETS.find(p => p.id === ai.onlineServicePreset)?.apiKeyHelpUrl || '')}
                      className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs font-medium transition-colors"
                      title="获取 API Key"
                    >
                      获取 Key
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {ai.provider === 'ollama' && (
            <>
              <div>
                <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ollama-endpoint">{t('settings.endpoint')}</label>
                <input
                  type="text"
                  id="ollama-endpoint"
                  name="ollama-endpoint"
                  value={ai.ollama.endpoint}
                  onChange={(e) => onUpdateSettingsData({ ai: { ...ai, ollama: { ...ai.ollama, endpoint: e.target.value } } })}
                  className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                  placeholder="http://localhost:11434"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ollama-model">{t('settings.aiModelVision')}</label>
                <input
                  type="text"
                  id="ollama-model"
                  name="ollama-model"
                  value={ai.ollama.model}
                  onChange={(e) => onUpdateSettingsData({ ai: { ...ai, ollama: { ...ai.ollama, model: e.target.value } } })}
                  className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                  placeholder="llava"
                />
              </div>
            </>
          )}

          {ai.provider === 'lmstudio' && (
            <>
              <div>
                <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="lmstudio-endpoint">{t('settings.lmStudioEndpoint')}</label>
                <input
                  type="text"
                  id="lmstudio-endpoint"
                  name="lmstudio-endpoint"
                  value={ai.lmstudio.endpoint}
                  onChange={(e) => onUpdateSettingsData({ ai: { ...ai, lmstudio: { ...ai.lmstudio, endpoint: e.target.value } } })}
                  className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
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
                  value={ai.lmstudio.model}
                  onChange={(e) => onUpdateSettingsData({ ai: { ...ai, lmstudio: { ...ai.lmstudio, model: e.target.value } } })}
                  className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                  placeholder="local-model"
                />
              </div>
            </>
          )}

        </div>

        <div className="mt-6">
          <h4 className="text-sm font-bold text-gray-800 dark:text-white mb-2">{t('settings.systemPrompt')}</h4>
          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <textarea
              id="ai-system-prompt"
              value={ai.systemPrompt || ''}
              onChange={(e) => onUpdateSettingsData({ ai: { ...ai, systemPrompt: e.target.value } })}
              className="w-full bg-panel rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200 min-h-[80px]"
              placeholder="..."
            />

            {/* 预设工具 */}
            <div className="mt-3 pt-3 border-subtle flex flex-wrap items-center gap-2">
              <select
                id="ai-preset-select"
                value={ai.currentPresetId || ''}
                onChange={(e) => {
                  const pid = e.target.value;
                  const preset = ai.promptPresets?.find(p => p.id === pid);
                  if (preset) {
                    onUpdateSettingsData({ ai: { ...ai, currentPresetId: pid, systemPrompt: preset.content } });
                  } else {
                    onUpdateSettingsData({ ai: { ...ai, currentPresetId: undefined } });
                  }
                }}
                className="flex-1 min-w-[120px] bg-panel rounded p-1.5 text-xs outline-none text-gray-800 dark:text-gray-200"
              >
                <option value="">{t('settings.selectPreset')}</option>
                {ai.promptPresets?.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>

              <input
                type="text"
                value={editingPresetName}
                onChange={(e) => setEditingPresetName(e.target.value)}
                placeholder={t('settings.presetName')}
                className="flex-1 min-w-[120px] bg-panel rounded p-1.5 text-xs outline-none text-gray-800 dark:text-gray-200"
              />

              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    const currentPresets = ai.promptPresets || [];
                    const pid = ai.currentPresetId;
                    if (pid) {
                      const updated = currentPresets.map(p => p.id === pid ? { ...p, name: editingPresetName, content: ai.systemPrompt || '' } : p);
                      onUpdateSettingsData({ ai: { ...ai, promptPresets: updated } });
                    }
                  }}
                  disabled={!ai.currentPresetId}
                  title={t('settings.savePreset')}
                  className="p-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Save size={16} />
                </button>

                <button
                  onClick={() => {
                    const newId = `preset_${Date.now()}`;
                    const newPreset = { id: newId, name: editingPresetName || t('settings.newPresetName'), content: ai.systemPrompt || '' };
                    const updated = [...(ai.promptPresets || []), newPreset];
                    onUpdateSettingsData({ ai: { ...ai, promptPresets: updated, currentPresetId: newId } });
                  }}
                  title={t('settings.saveAsNewPreset')}
                  className="p-2 rounded-lg bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 transition-colors"
                >
                  <PlusCircle size={16} />
                </button>

                <button
                  onClick={() => {
                    const pid = ai.currentPresetId;
                    if (pid) {
                      const updated = (ai.promptPresets || []).filter(p => p.id !== pid);
                      onUpdateSettingsData({ ai: { ...ai, promptPresets: updated, currentPresetId: undefined } });
                    }
                  }}
                  disabled={!ai.currentPresetId}
                  title={t('settings.deletePreset')}
                  className="p-2 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoTag')}</span>
            <button
              onClick={() => onUpdateSettingsData({ ai: { ...ai, autoTag: !ai.autoTag } })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ai.autoTag ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.autoTag ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoDescription')}</span>
            <button
              onClick={() => onUpdateSettingsData({ ai: { ...ai, autoDescription: !ai.autoDescription } })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ai.autoDescription ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.autoDescription ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between pl-4 border-l-2 border-subtle" style={isAndroid ? { height: '55px' } : undefined}>
            <span className={`text-sm font-medium ${ai.autoDescription ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}>{t('settings.aiEnhancePersonDesc')}</span>
            <button
              onClick={() => {
                if (ai.autoDescription) {
                  onUpdateSettingsData({ ai: { ...ai, enhancePersonDescription: !ai.enhancePersonDescription } });
                }
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${ai.autoDescription ? (ai.enhancePersonDescription ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600') : 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.enhancePersonDescription ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiFaceRec')}</span>
            <button
              onClick={() => onUpdateSettingsData({ ai: { ...ai, enableFaceRecognition: !ai.enableFaceRecognition } })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ai.enableFaceRecognition ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.enableFaceRecognition ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between pl-4 border-l-2 border-subtle" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoAddPeople')}</span>
            <button
              onClick={() => onUpdateSettingsData({ ai: { ...ai, autoAddPeople: !ai.autoAddPeople } })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ai.autoAddPeople ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.autoAddPeople ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiEnableOCR')}</span>
            <button
              onClick={() => onUpdateSettingsData({ ai: { ...ai, enableOCR: !ai.enableOCR } })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ai.enableOCR ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.enableOCR ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between" style={isAndroid ? { height: '55px' } : undefined}>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiEnableTranslation')}</span>
            <button
              onClick={() => onUpdateSettingsData({ ai: { ...ai, enableTranslation: !ai.enableTranslation } })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${ai.enableTranslation ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${ai.enableTranslation ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>

          {ai.enableTranslation && (
            <div className="flex items-center justify-between pl-4 border-l-2 border-subtle animate-fade-in" style={isAndroid ? { height: '55px' } : undefined}>
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
                    onClick={() => onUpdateSettingsData({ ai: { ...ai, targetLanguage: lang.code as any } })}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${ai.targetLanguage === lang.code
                      ? 'bg-purple-500 text-white border-purple-500'
                      : 'bg-surface text-gray-600 dark:text-gray-400 border-subtle hover:border-purple-400'
                      }`}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="pt-4">
            <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ai-confidence">{t('settings.aiConfidence')} ({Math.round(ai.confidenceThreshold * 100)}%)</label>
            <input
              type="range"
              id="ai-confidence"
              name="ai-confidence"
              min="0.1"
              max="0.9"
              step="0.05"
              value={ai.confidenceThreshold}
              onChange={(e) => onUpdateSettingsData({ ai: { ...ai, confidenceThreshold: parseFloat(e.target.value) } })}
              className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-purple-500"
            />
          </div>
        </div>


      </section>
    </div>
  );
};

export default AISettingsPanel;
