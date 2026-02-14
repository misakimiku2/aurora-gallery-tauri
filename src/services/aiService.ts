import { faceRecognitionService } from './faceRecognitionService';
import { AiData, AiFace, AppSettings, Person, AIModelOption, AI_SERVICE_PRESETS } from '../types';
import { readFileAsBase64, proxyHttpRequest } from '../api/tauri-bridge';

// 模型列表缓存的 localStorage key
const MODELS_CACHE_KEY = 'aurora_ai_models_cache';
const MODELS_CACHE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7天

interface ModelsCache {
  [presetId: string]: {
    models: AIModelOption[];
    timestamp: number;
  };
}

class AIService {
  async analyzeImage(imagePath: string, settings: AppSettings, people: Record<string, Person>) {
    const aiData: Partial<AiData> = {
      analyzed: true,
      analyzedAt: new Date().toISOString(),
      confidence: 0.0,
      tags: [],
      dominantColors: [],
      objects: [],
      faces: []
    };

    // 保存人脸特征向量信息
    const faceDescriptors: { faceId: string; descriptor: number[] | undefined }[] = [];

    // 如果启用人脸识别
    if (settings.ai.enableFaceRecognition) {
      try {
        // 读取图片为 DataURL 用于人脸识别
        const imageDataUrl = await readFileAsBase64(imagePath);
        if (imageDataUrl) {
          const facesWithDescriptors = await this.detectAndRecognizeFaces(imageDataUrl, settings, people);
          aiData.faces = facesWithDescriptors.faces;
          faceDescriptors.push(...facesWithDescriptors.faceDescriptors);
        }
      } catch (error) {
        console.error('Error reading image for face recognition:', error);
      }
    }

    return { aiData, faceDescriptors };
  }

  async detectAndRecognizeFaces(imageDataUrl: string, settings: AppSettings, people: Record<string, Person>) {
    try {
      // 检测人脸
      const detections = await faceRecognitionService.detectFaces(imageDataUrl);
      const faces: AiFace[] = [];
      const faceDescriptors: { faceId: string; descriptor: number[] | undefined }[] = [];

      for (const detection of detections) {
        const faceId = `face_${Math.random().toString(36).substr(2, 9)}`;

        // 提取人脸特征
        const descriptor = detection.descriptor;

        // 匹配已知人物
        const match = descriptor ? await faceRecognitionService.matchFace(descriptor, people) : null;

        // 初始化为未知人物
        let personId = `person_${Math.random().toString(36).substr(2, 9)}`;
        let name = '未知人物';

        // 如果有匹配的人物，使用匹配的人物信息
        if (match) {
          personId = match.person.id;
          name = match.person.name;
        }

        const face: AiFace = {
          id: faceId,
          personId,
          name,
          confidence: 1.0 - (match?.distance || 1.0),
          box: {
            x: Math.round(detection.detection.box.x),
            y: Math.round(detection.detection.box.y),
            w: Math.round(detection.detection.box.width),
            h: Math.round(detection.detection.box.height)
          }
        };

        faces.push(face);
        faceDescriptors.push({ faceId, descriptor: descriptor ? Array.from(descriptor) : undefined });
      }

      return { faces, faceDescriptors };
    } catch (error) {
      console.error('Error detecting faces:', error);
      return { faces: [], faceDescriptors: [] };
    }
  }

  async updatePersonDescriptor(personId: string, imagePath: string) {
    try {
      // 读取图片为 DataURL 用于人脸识别
      const imageDataUrl = await readFileAsBase64(imagePath);
      if (!imageDataUrl) {
        console.error('Failed to read image for person descriptor:', imagePath);
        return null;
      }
      const descriptor = await faceRecognitionService.computeFaceDescriptor(imageDataUrl);
      if (descriptor) {
        // 更新人物的特征向量
        return Array.from(descriptor);
      }
      return null;
    } catch (error) {
      console.error('Error updating person descriptor:', error);
      return null;
    }
  }

  async processImageForAI(imageUrl: string, settings: AppSettings, people: Record<string, Person>) {
    const aiData = await this.analyzeImage(imageUrl, settings, people);
    return aiData;
  }

  // Check connectivity for configured AI provider (openai / ollama / lmstudio)
  async checkConnection(aiConfig: AppSettings['ai']): Promise<{ status: 'connected' | 'disconnected'; result?: any }> {
    const cleanUrl = (u: string) => u.replace(/\/+$|\s+/g, '');

    try {
      const provider = aiConfig.provider;
      let url = '';
      let headers: Record<string, string> = {};

      if (provider === 'openai') {
        url = `${cleanUrl(aiConfig.openai.endpoint)}/models`;
        headers = { 'Authorization': `Bearer ${aiConfig.openai.apiKey}` };
      } else if (provider === 'ollama') {
        url = `${cleanUrl(aiConfig.ollama.endpoint)}/api/tags`;
      } else if (provider === 'lmstudio') {
        let ep = cleanUrl(aiConfig.lmstudio.endpoint);
        if (!ep.endsWith('/v1')) ep = `${ep}/v1`;
        url = `${ep}/models`;
      }

      // 使用代理请求绕过 CORS
      const responseText = await proxyHttpRequest(url, 'GET', headers);
      const result = JSON.parse(responseText);
      return { status: 'connected', result };
    } catch (e) {
      console.error('AI connection check failed:', e);
      return { status: 'disconnected' };
    }
  }

  // 生成文件名 - 单个文件
  async generateSingleFileName(
    filePath: string,
    originalName: string,
    settings: AppSettings,
    personNames: string[] = []
  ): Promise<string | null> {
    try {
      // 读取图片为base64
      const base64Data = await readFileAsBase64(filePath);
      if (!base64Data) {
        console.error('Failed to read file:', filePath);
        return null;
      }

      // 获取文件扩展名
      const extension = originalName.match(/\.[^.]+$/)?.[0] || '';
      const nameWithoutExt = originalName.replace(/\.[^.]+$/, '');

      // 构建人物信息提示
      const personInfoPrompt = personNames.length > 0
        ? `\n6. 图片中包含以下人物：${personNames.join('、')}，请在文件名中优先使用人物名称（如"${personNames[0]}的..."）`
        : '';

      // 构建提示词
      const userPrompt = `请根据这张图片的内容，直接输出一个简洁、描述性的中文文件名。不要思考，不要解释，直接输出文件名。

要求：
1. 文件名应该准确描述图片的主要内容
2. 使用中文，简洁明了（10-20字）
3. 不要包含特殊字符，只使用中文、英文、数字、空格和下划线
4. 直接输出文件名，不要有任何解释、思考过程或额外文字
5. 原文件名是："${nameWithoutExt}"${personInfoPrompt}

请只返回新的文件名（不包含扩展名）：`;

      // 构建消息数组
      const messages: any[] = [];

      // 如果有系统提示词，先添加
      if (settings.ai.systemPrompt && settings.ai.systemPrompt.trim()) {
        messages.push({
          role: 'system',
          content: settings.ai.systemPrompt
        });
      }

      // 添加用户消息（包含图片和提示词）
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: userPrompt
          },
          {
            type: 'image_url',
            image_url: {
              url: base64Data
            }
          }
        ]
      });

      // 根据提供商调用AI
      const provider = settings.ai.provider;
      let response: string | null = null;

      if (provider === 'openai') {
        response = await this.callOpenAI(messages, settings);
      } else if (provider === 'ollama') {
        response = await this.callOllama(messages, settings);
      } else if (provider === 'lmstudio') {
        response = await this.callLMStudio(messages, settings);
      }

      if (!response) {
        return null;
      }

      // 清理返回的文件名
      let newName = response.trim();
      
      // 移除 think 标签及其内容（处理 <think>...</think> 格式）
      newName = newName.replace(/<think[\s\S]*?<\/think>/gi, '');
      
      // 处理 GLM 模型的思考格式：<think>开头但没有闭合标签，需要移除从<think>开始到行尾的所有内容
      if (newName.toLowerCase().startsWith('<think>')) {
        // 找到 <think> 后的第一个换行符，或者如果没有换行符则清空整个内容
        const thinkEndIndex = newName.indexOf('\n');
        if (thinkEndIndex !== -1) {
          newName = newName.substring(thinkEndIndex + 1);
        } else {
          // 如果整个响应都是 think 内容，返回空
          newName = '';
        }
      }
      
      // 移除包含 "用户现在需要" 或类似思考关键词的行（GLM模型的思考特征）
      newName = newName.split('\n').filter(line => {
        const lowerLine = line.trim().toLowerCase();
        return !lowerLine.startsWith('think') && 
               !lowerLine.includes('用户现在') &&
               !lowerLine.includes('首先看') &&
               !lowerLine.includes('分析') &&
               !lowerLine.includes('根据要求');
      }).join('\n');
      
      // 继续清理
      newName = newName
        .replace(/["'<>|:*?\\/]/g, '') // 移除非法字符
        .replace(/\n/g, ' ') // 换行转空格
        .replace(/\s+/g, ' ') // 多个空格合并
        .trim();

      // 如果AI返回了扩展名，移除它
      newName = newName.replace(/\.[^.]+$/, '');

      // 如果文件名为空，返回null
      if (!newName) {
        return null;
      }

      // 添加原扩展名
      return newName + extension;
    } catch (error) {
      console.error('Error generating file name:', error);
      return null;
    }
  }

  // 批量生成文件名
  async generateFileNames(
    filePaths: string[],
    settings: AppSettings,
    people: Record<string, Person>,
    filePersonMap: Map<string, string[]>,
    onProgress?: (current: number, total: number, result?: string) => void
  ): Promise<string[]> {
    const results: string[] = [];
    const total = filePaths.length;

    // 逐个处理文件（避免并发过多）
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      const originalName = filePath.split(/[\\/]/).pop() || '';

      // 获取该文件的人物信息
      const personNames = filePersonMap.get(filePath) || [];

      try {
        const newName = await this.generateSingleFileName(filePath, originalName, settings, personNames);
        const finalName = newName || originalName;
        results.push(finalName);
        // 报告进度，同时返回当前生成的文件名
        if (onProgress) {
          onProgress(i + 1, total, finalName);
        }
      } catch (error) {
        console.error('Failed to generate name for:', filePath, error);
        results.push(originalName);
        // 报告进度，失败时返回原文件名
        if (onProgress) {
          onProgress(i + 1, total, originalName);
        }
      }

      // 添加小延迟，避免请求过快
      if (i < filePaths.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  // 调用 OpenAI API
  private async callOpenAI(messages: any[], settings: AppSettings): Promise<string | null> {
    try {
      // 清理 endpoint，移除末尾的斜杠，避免双斜杠问题
      const endpoint = settings.ai.openai.endpoint.replace(/\/+$/, '');
      const url = `${endpoint}/chat/completions`;
      
      const body = JSON.stringify({
        model: settings.ai.openai.model || 'gpt-4o',
        messages,
        max_tokens: 100,
        temperature: 0.7
      });
      
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.ai.openai.apiKey}`
      };
      
      // 使用代理请求绕过 CORS
      const responseText = await proxyHttpRequest(url, 'POST', headers, body);
      const data = JSON.parse(responseText);
      return data.choices?.[0]?.message?.content || null;
    } catch (error) {
      console.error('Error calling OpenAI:', error);
      return null;
    }
  }

  // 调用 Ollama API
  private async callOllama(messages: any[], settings: AppSettings): Promise<string | null> {
    try {
      // Ollama 的消息格式转换
      const ollamaMessages = messages.map(msg => {
        if (typeof msg.content === 'string') {
          return msg;
        }
        // 处理多模态内容
        const textContent = msg.content.find((c: any) => c.type === 'text')?.text || '';
        const imageContent = msg.content.find((c: any) => c.type === 'image_url');
        
        if (imageContent) {
          // 提取base64数据
          const imageUrl = imageContent.image_url.url;
          const base64Data = imageUrl.replace(/^data:image\/[^;]+;base64,/, '');
          return {
            role: msg.role,
            content: textContent,
            images: [base64Data]
          };
        }
        return {
          role: msg.role,
          content: textContent
        };
      });

      const response = await fetch(`${settings.ai.ollama.endpoint}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: settings.ai.ollama.model || 'llava',
          messages: ollamaMessages,
          stream: false
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Ollama API error:', error);
        return null;
      }

      const data = await response.json();
      return data.message?.content || null;
    } catch (error) {
      console.error('Error calling Ollama:', error);
      return null;
    }
  }

  // 调用 LM Studio API
  private async callLMStudio(messages: any[], settings: AppSettings): Promise<string | null> {
    try {
      let endpoint = settings.ai.lmstudio.endpoint;
      if (!endpoint.endsWith('/v1')) {
        endpoint = `${endpoint}/v1`;
      }

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: settings.ai.lmstudio.model || 'local-model',
          messages,
          max_tokens: 100,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('LM Studio API error:', error);
        return null;
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || null;
    } catch (error) {
      console.error('Error calling LM Studio:', error);
      return null;
    }
  }

  // ==================== 动态获取模型列表 ====================

  /**
   * 从 API 获取模型列表
   * @param presetId 预设ID: 'openai' | 'gemini' | 'zhipu' | 'custom'
   * @param apiKey API Key
   * @param customEndpoint 自定义端点（用于 custom 预设）
   * @returns 模型列表和是否从 API 获取成功的标志
   */
  async fetchModels(
    presetId: string,
    apiKey: string,
    customEndpoint?: string
  ): Promise<{ models: AIModelOption[]; fromApi: boolean }> {
    try {
      const preset = AI_SERVICE_PRESETS.find(p => p.id === presetId);
      if (!preset) {
        throw new Error(`Unknown preset: ${presetId}`);
      }

      // 构建请求 URL
      let endpoint = presetId === 'custom' ? customEndpoint : preset.endpoint;
      if (!endpoint) {
        throw new Error('Endpoint is required');
      }

      // 清理 endpoint，移除末尾的斜杠
      endpoint = endpoint.replace(/\/+$/, '');
      const url = `${endpoint}/models`;

      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // 使用代理请求
      const responseText = await proxyHttpRequest(url, 'GET', headers);
      const data = JSON.parse(responseText);

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid response format');
      }

      // 转换为 AIModelOption 格式
      const models: AIModelOption[] = data.data
        .map((model: any) => this.parseModelInfo(model, presetId))
        .filter((model: AIModelOption | null): model is AIModelOption => model !== null);

      // 按推荐程度排序
      models.sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.name.localeCompare(b.name);
      });

      // 缓存结果
      this.cacheModels(presetId, models);

      return { models, fromApi: true };
    } catch (error) {
      console.error('Failed to fetch models:', error);
      // 返回预设的模型列表作为 fallback
      const preset = AI_SERVICE_PRESETS.find(p => p.id === presetId);
      const fallbackModels = preset?.models || [];
      return { models: fallbackModels, fromApi: false };
    }
  }

  /**
   * 解析模型信息，转换为 AIModelOption
   */
  private parseModelInfo(model: any, presetId: string): AIModelOption | null {
    let modelId = model.id || '';
    
    // Gemini API 返回的模型 ID 带有 "Models/" 或 "models/" 前缀，需要去掉
    if (presetId === 'gemini') {
      // 不区分大小写处理前缀
      if (modelId.toLowerCase().startsWith('models/')) {
        modelId = modelId.substring(7); // 去掉 "models/" 前缀
      }
    }
    
    // 过滤掉非视觉模型（根据模型名称特征）
    const isVisionModel = this.isVisionModel(modelId, presetId);
    
    // 获取模型显示名称
    const name = this.getModelDisplayName(modelId, presetId);
    
    // 判断是否为推荐模型
    const recommended = this.isRecommendedModel(modelId, presetId);

    return {
      id: modelId,
      name,
      description: this.getModelDescription(modelId, presetId),
      vision: isVisionModel,
      recommended
    };
  }

  /**
   * 判断模型是否支持视觉（图像识别）
   */
  private isVisionModel(modelId: string, presetId: string): boolean {
    const id = modelId.toLowerCase();
    
    // OpenAI 视觉模型
    if (presetId === 'openai') {
      return id.includes('gpt-4') && !id.includes('gpt-4-') || 
             id.includes('gpt-4o') ||
             id.includes('vision');
    }
    
    // Gemini 所有模型都支持多模态
    if (presetId === 'gemini') {
      return id.startsWith('gemini');
    }
    
    // 智谱 AI 视觉模型
    if (presetId === 'zhipu') {
      return id.includes('v') || id.includes('vision') || id.includes('vl');
    }
    
    // 自定义服务商：假设包含 vision、vl、v 的模型支持视觉
    return id.includes('vision') || id.includes('vl') || /-v\d/i.test(id);
  }

  /**
   * 获取模型显示名称
   */
  private getModelDisplayName(modelId: string, presetId: string): string {
    // 预设的友好名称映射
    const nameMap: Record<string, string> = {
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'gpt-4-turbo': 'GPT-4 Turbo',
      'gpt-4': 'GPT-4',
      'gpt-3.5-turbo': 'GPT-3.5 Turbo',
      // Gemini 2.0 系列
      'gemini-2.0-flash': 'Gemini 2.0 Flash',
      'gemini-2.0-flash-001': 'Gemini 2.0 Flash 001',
      'gemini-2.0-flash-lite': 'Gemini 2.0 Flash Lite',
      'gemini-2.0-flash-lite-001': 'Gemini 2.0 Flash Lite 001',
      'gemini-2.0-flash-exp-image-generation': 'Gemini 2.0 Flash Exp (图像生成)',
      'gemini-2.0-pro-exp-02-05': 'Gemini 2.0 Pro',
      // Gemini 2.5 系列
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-flash-image': 'Gemini 2.5 Flash (图像)',
      'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      // Gemini 1.5 系列
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
      // Gemini 3 系列
      'gemini-3-flash-preview': 'Gemini 3 Flash Preview',
      // 其他 Gemini 模型
      'aqa': 'AQA (问答模型)',
      'deep-research-pro-preview-12-2025': 'Deep Research Pro Preview (12/2025)',
      'gemini-2.5-computer-use-preview-10-2025': 'Gemini 2.5 Computer Use Preview (10/2025)',
      'gemini-2.5-flash-lite-preview-09-2025': 'Gemini 2.5 Flash Lite Preview (09/2025)',
      'gemini-2.5-flash-native-audio-latest': 'Gemini 2.5 Flash Native Audio',
      'gemini-2.5-flash-native-audio-preview-09-2025': 'Gemini 2.5 Flash Native Audio Preview (09/2025)',
      'gemini-2.5-flash-native-audio-preview-12-2025': 'Gemini 2.5 Flash Native Audio Preview (12/2025)',
      'gemini-2.5-flash-preview-09-2025': 'Gemini 2.5 Flash Preview (09/2025)',
      'gemini-2.5-flash-preview-tts': 'Gemini 2.5 Flash Preview (TTS)',
      'gemini-2.5-pro-preview-tts': 'Gemini 2.5 Pro Preview (TTS)',
      // 智谱 AI
      'glm-4v': 'GLM-4V',
      'glm-4': 'GLM-4',
      'glm-4v-flash': 'GLM-4V Flash',
      'glm-4v-plus': 'GLM-4V Plus',
    };

    if (nameMap[modelId]) {
      return nameMap[modelId];
    }

    // 格式化模型ID为友好名称
    return modelId
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * 获取模型描述
   */
  private getModelDescription(modelId: string, presetId: string): string {
    const descriptions: Record<string, string> = {
      'gpt-4o': '最先进的视觉模型',
      'gpt-4o-mini': '轻量快速',
      'gpt-4-turbo': '强大的文本模型',
      // Gemini 描述
      'gemini-2.0-flash': '快速多模态',
      'gemini-2.0-flash-lite': '轻量经济',
      'gemini-2.0-pro-exp-02-05': '实验性专业版',
      'gemini-2.5-flash': '新一代快速模型',
      'gemini-2.5-pro': '新一代专业模型',
      'gemini-1.5-flash': '稳定版快速模型',
      'gemini-1.5-pro': '稳定版专业模型',
      'aqa': '问答专用模型',
      'glm-4v': '视觉理解模型',
      'glm-4': '通用大模型',
      'glm-4v-flash': '轻量视觉模型',
    };

    return descriptions[modelId] || '';
  }

  /**
   * 判断是否为推荐模型
   */
  private isRecommendedModel(modelId: string, presetId: string): boolean {
    const recommendedModels: Record<string, string[]> = {
      'openai': ['gpt-4o', 'gpt-4o-mini'],
      'gemini': ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
      'zhipu': ['glm-4v']
    };

    return recommendedModels[presetId]?.includes(modelId) || false;
  }

  /**
   * 缓存模型列表
   */
  private cacheModels(presetId: string, models: AIModelOption[]): void {
    try {
      const cache: ModelsCache = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || '{}');
      cache[presetId] = {
        models,
        timestamp: Date.now()
      };
      localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
      console.error('Failed to cache models:', error);
    }
  }

  /**
   * 获取缓存的模型列表
   * @param presetId 预设ID
   * @param maxAge 最大缓存时间（毫秒），默认7天
   * @returns 缓存的模型列表，如果过期或不存在则返回 null
   */
  getCachedModels(presetId: string, maxAge: number = MODELS_CACHE_EXPIRY): AIModelOption[] | null {
    try {
      const cache: ModelsCache = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || '{}');
      const cached = cache[presetId];
      
      if (!cached) return null;
      
      const age = Date.now() - cached.timestamp;
      if (age > maxAge) return null;
      
      return cached.models;
    } catch (error) {
      console.error('Failed to get cached models:', error);
      return null;
    }
  }

  /**
   * 清除模型缓存
   */
  clearModelsCache(presetId?: string): void {
    try {
      if (presetId) {
        const cache: ModelsCache = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || '{}');
        delete cache[presetId];
        localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
      } else {
        localStorage.removeItem(MODELS_CACHE_KEY);
      }
    } catch (error) {
      console.error('Failed to clear models cache:', error);
    }
  }
}

export const aiService = new AIService();
