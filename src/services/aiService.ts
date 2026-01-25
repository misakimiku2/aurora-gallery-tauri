import { faceRecognitionService } from './faceRecognitionService';
import { AiData, AiFace, AppSettings, Person } from '../types';

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

    // 淇濆瓨浜鸿劯鐗瑰緛鍚戦噺淇℃伅
    const faceDescriptors: { faceId: string; descriptor: number[] | undefined }[] = [];

    // 濡傛灉鍚敤浜鸿劯璇嗗埆
    if (settings.ai.enableFaceRecognition) {
      const facesWithDescriptors = await this.detectAndRecognizeFaces(imageUrl, settings, people);
      aiData.faces = facesWithDescriptors.faces;
      faceDescriptors.push(...facesWithDescriptors.faceDescriptors);
    }

    return { aiData, faceDescriptors };
  }

  async detectAndRecognizeFaces(imageUrl: string, settings: AppSettings, people: Record<string, Person>) {
    try {
      // 妫€娴嬩汉鑴?
      const detections = await faceRecognitionService.detectFaces(imageUrl);
      const faces: AiFace[] = [];
      const faceDescriptors: { faceId: string; descriptor: number[] | undefined }[] = [];

      for (const detection of detections) {
        const faceId = `face_${Math.random().toString(36).substr(2, 9)}`;

        // 鎻愬彇浜鸿劯鐗瑰緛
        const descriptor = detection.descriptor;

        // 鍖归厤宸茬煡浜虹墿
        const match = descriptor ? await faceRecognitionService.matchFace(descriptor, people) : null;

        // 初始化为未知人物
        let personId = `person_${Math.random().toString(36).substr(2, 9)}`;
        let name = '鏈煡浜虹墿';

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
        // 鏇存柊浜虹墿鐨勭壒寰佸悜閲?
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
  }}

export const aiService = new AIService();