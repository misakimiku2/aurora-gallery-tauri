export interface ParsedQrData {
  host: string;
  port: number;
  code?: string;
}

const DEFAULT_PORT = 8080;

function parseServerUrl(url: string): { host: string; port: number } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    const port = u.port ? parseInt(u.port, 10) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

export function parseQrData(rawText: string): ParsedQrData | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'aurora-lan' && obj.url) {
        const urlResult = parseServerUrl(obj.url);
        if (urlResult) {
          return { ...urlResult, code: obj.code };
        }
      }
    } catch {
      // Not valid JSON, try as plain URL
    }
  }

  const urlResult = parseServerUrl(trimmed);
  if (urlResult) {
    return urlResult;
  }

  return null;
}
