interface DecodeRequest {
  id: string;
  url: string;
}

interface DecodeSuccessResponse {
  id: string;
  imageBitmap: ImageBitmap;
}

interface DecodeErrorResponse {
  id: string;
  error: string;
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, url } = e.data;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      self.postMessage({ id, error: `HTTP ${response.status}` } as DecodeErrorResponse);
      return;
    }

    const blob = await response.blob();

    if (typeof createImageBitmap === 'undefined') {
      self.postMessage({ id, error: 'createImageBitmap not available' } as DecodeErrorResponse);
      return;
    }

    const imageBitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'premultiply',
      colorSpaceConversion: 'default',
      resizeQuality: 'medium',
    });

    self.postMessage(
      { id, imageBitmap } as DecodeSuccessResponse,
      { transfer: [imageBitmap] } as WindowPostMessageOptions
    );
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } as DecodeErrorResponse);
  }
};
