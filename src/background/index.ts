interface DownloadMessage {
  type: 'twx-download';
  url: string;
  filename?: string;
}

chrome.runtime.onMessage.addListener(
  (msg: DownloadMessage, _sender, sendResponse: (resp: { ok: boolean; id?: number; error?: string }) => void) => {
    if (msg?.type !== 'twx-download' || !msg.url) return;

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
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}
