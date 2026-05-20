import { TWX_DOWNLOAD_MESSAGE_TYPE } from '../modules/twitter/constants';

interface DownloadMessage {
  type: typeof TWX_DOWNLOAD_MESSAGE_TYPE;
  url: string;
  filename?: string;
}

chrome.runtime.onMessage.addListener(
  (msg: DownloadMessage, _sender, sendResponse: (resp: { ok: boolean; id?: number; error?: string }) => void) => {
    if (
      !msg ||
      msg.type !== TWX_DOWNLOAD_MESSAGE_TYPE ||
      !msg.url
    ) {
      return;
    }

    chrome.downloads.download(
      {
        url: msg.url,
        filename: sanitizeFilename(msg.filename ?? 'x-video.mp4'),
        saveAs: false,
      },
      (id) => {
        if (chrome.runtime.lastError || !id) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message });
        } else {
          sendResponse({ ok: true, id });
        }
      },
    );
    return true;
  },
);

function sanitizeFilename(name: string): string {
  return name.replaceAll(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}


