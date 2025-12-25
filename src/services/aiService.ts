import { faceRecognitionService } from './faceRecognitionService';
import { AiData, AiFace, AppSettings, Person } from '../types';

class AIService {
  async analyzeImage(imageUrl: string, settings: AppSettings) {
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
      const facesWithDescriptors = await this.detectAndRecognizeFaces(imageUrl, settings);
      aiData.faces = facesWithDescriptors.faces;
      faceDescriptors.push(...facesWithDescriptors.faceDescriptors);
    }

    return { aiData, faceDescriptors };
  }

  async detectAndRecognizeFaces(imageUrl: string, settings: AppSettings) {
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
        const people = this.getPeopleFromSettings(settings);
        const match = descriptor ? await faceRecognitionService.matchFace(descriptor, people) : null;

        let personId = `person_${Math.random().toString(36).substr(2, 9)}`;
        let name = '未知人物';

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

  private getPeopleFromSettings(settings: AppSettings): Record<string, Person> {
    // 在实际应用中，这里应该从全局状态或存储中获取人物数据库
    // 由于我们无法直接访问全局状态，我们将通过设置中的临时存储来获取
    // 这需要在调用analyzeImage方法之前将人物数据传递给settings
    // 目前我们返回一个空对象，实际使用时需要修改这部分逻辑
    // 注意：在真实应用中，你应该通过上下文或其他方式传递人物数据
    return settings.people || {};
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

  async processImageForAI(imageUrl: string, settings: AppSettings) {
    const aiData = await this.analyzeImage(imageUrl, settings);
    return aiData;
  }
}

export const aiService = new AIService();
