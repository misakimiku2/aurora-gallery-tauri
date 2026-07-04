import { lanClientApi } from './lanClientApi';
import { writeFileFromBytes } from '../../api/tauri-bridge';
import { generateId } from '../../utils/pathUtils';

export interface DownloadResult {
  localPath: string;
  fileName: string;
  success: boolean;
  error?: string;
}

const BATCH_SIZE = 4;
const BATCH_DELAY = 200;

function basenameOf(remotePath: string): string {
  const normalized = remotePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || `lan-${generateId(remotePath)}`;
}

function joinCachePath(cacheRoot: string, fileName: string): string {
  const root = cacheRoot.replace(/[/\\]+$/, '');
  return `${root}/lan-cache/${fileName}`;
}

/**
 * Download a single LAN image to the local cache directory.
 * Returns the local file path on success.
 */
export async function downloadLanImage(
  remotePath: string,
  cacheRoot: string
): Promise<DownloadResult> {
  const fileName = `${generateId(remotePath)}_${basenameOf(remotePath)}`;
  const localPath = joinCachePath(cacheRoot, fileName);

  try {
    const url = lanClientApi.getImageUrl(remotePath);
    const response = await fetch(url);
    if (!response.ok) {
      return {
        localPath: '',
        fileName,
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    const blob = await response.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    await writeFileFromBytes(localPath, buf);
    return { localPath, fileName, success: true };
  } catch (err) {
    return {
      localPath: '',
      fileName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download multiple LAN images in batches (4 per batch, 200ms between batches).
 * Calls onProgress(completed, total) after each individual download settles.
 * Continues even if some fail; failed entries are returned with success=false.
 */
export async function downloadLanImagesBatched(
  remotePaths: string[],
  cacheRoot: string,
  onProgress?: (completed: number, total: number) => void
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  const total = remotePaths.length;
  let completed = 0;

  for (let i = 0; i < remotePaths.length; i += BATCH_SIZE) {
    const batch = remotePaths.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((rp) => downloadLanImage(rp, cacheRoot))
    );

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        results.push({
          localPath: '',
          fileName: '',
          success: false,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
      completed++;
      onProgress?.(completed, total);
    }

    const isLastBatch = i + BATCH_SIZE >= remotePaths.length;
    if (!isLastBatch) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY));
    }
  }

  return results;
}
