import * as faceapi from '@vladmandic/face-api';
import { AiFace, Person } from '../types';

class FaceRecognitionService {
  private isModelLoaded = false;

  async initialize() {
    if (this.isModelLoaded) return;

    // 加载模型
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models')
    ]);

    this.isModelLoaded = true;
    console.log('Face recognition models loaded successfully');
  }

  async detectFaces(imageUrl: string) {
    await this.initialize();

    const img = await faceapi.fetchImage(imageUrl);
    const detectionResults = await faceapi.detectAllFaces(img)
      .withFaceLandmarks()
      .withFaceDescriptors();

    return detectionResults;
  }

  async computeFaceDescriptor(imageUrl: string) {
    await this.initialize();

    const img = await faceapi.fetchImage(imageUrl);
    const detection = await faceapi.detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    return detection?.descriptor;
  }

  async matchFace(descriptor: Float32Array, people: Record<string, Person>) {
    await this.initialize();

    let bestMatch: { person: Person; distance: number } | null = null;
    const FACE_MATCH_THRESHOLD = 0.6;

    for (const person of Object.values(people)) {
      if (person.descriptor) {
        const personDescriptor = new Float32Array(person.descriptor);
        const distance = faceapi.euclideanDistance(descriptor, personDescriptor);

        if (distance < FACE_MATCH_THRESHOLD && (!bestMatch || distance < bestMatch.distance)) {
          bestMatch = { person, distance };
        }
      }
    }

    return bestMatch;
  }

  async extractFaceFromImage(imageUrl: string, detection: faceapi.FaceDetection) {
    await this.initialize();

    const img = await faceapi.fetchImage(imageUrl);
    const canvas = faceapi.createCanvasFromMedia(img);
    const ctx = canvas.getContext('2d');

    if (!ctx) return null;

    const { x, y, width, height } = detection.box;
    const faceCanvas = document.createElement('canvas');
    const faceCtx = faceCanvas.getContext('2d');

    if (!faceCtx) return null;

    faceCanvas.width = width;
    faceCanvas.height = height;
    faceCtx.drawImage(img, x, y, width, height, 0, 0, width, height);

    return faceCanvas.toDataURL();
  }
}

export const faceRecognitionService = new FaceRecognitionService();
