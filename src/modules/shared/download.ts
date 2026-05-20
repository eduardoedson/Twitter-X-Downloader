import { TWX_DOWNLOAD_MESSAGE_TYPE } from '../twitter/constants';

export interface DownloadResult {
  ok: boolean;
  error?: string;
  filename: string;
}

export interface DownloadRequest {
  url: string;
  filename: string;
}

interface DownloadResponse {
  ok?: boolean;
  error?: string;
}

export function requestDownload(request: DownloadRequest): Promise<DownloadResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: TWX_DOWNLOAD_MESSAGE_TYPE, url: request.url, filename: request.filename },
      (resp: DownloadResponse | undefined) => {
        if (!resp) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message ?? 'no response from background',
            filename: request.filename,
          });
          return;
        }
        resolve({ ok: !!resp.ok, error: resp.error, filename: request.filename });
      },
    );
  });
}


export async function downloadMany(files: DownloadRequest[]): Promise<DownloadResult[]> {
  return Promise.all(files.map((f) => requestDownload(f)));
}

