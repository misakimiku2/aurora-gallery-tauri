import { faceRecognitionService } from './faceRecognitionService';
import { AiData, AiFace, AppSettings, Person } from '../types';
import { readFileAsBase64 } from '../api/tauri-bridge';

class AIService {
  async analyzeImage(imageUrl: string, settings: AppSettings, people: Record<string, Person>) {
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
      const facesWithDescriptors = await this.detectAndRecognizeFaces(imageUrl, settings, people);
      aiData.faces = facesWithDescriptors.faces;
      faceDescriptors.push(...facesWithDescriptors.faceDescriptors);
    }

    return { aiData, faceDescriptors };
  }

  async detectAndRecognizeFaces(imageUrl: string, settings: AppSettings, people: Record<string, Person>) {
    try {
      // 检测人脸
      const detections = await faceRecognitionService.detectFaces(imageUrl);
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

  async updatePersonDescriptor(personId: string, imageUrl: string) {
    try {
      const descriptor = await faceRecognitionService.computeFaceDescriptor(imageUrl);
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

      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) return { status: 'disconnected' };
      const result = await res.json();
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
      const response = await fetch(`${settings.ai.openai.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.ai.openai.apiKey}`
        },
        body: JSON.stringify({
          model: settings.ai.openai.model || 'gpt-4o',
          messages,
          max_tokens: 100,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('OpenAI API error:', error);
        return null;
      }

      const data = await response.json();
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
}

export const aiService = new AIService();
