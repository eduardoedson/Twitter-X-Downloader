import { extractTweets, filenameFor, type TweetMedia } from '../lib/tweet-parser';

const tweetMediaCache = new Map<string, TweetMedia>();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; data?: unknown } | undefined;
  if (!data || data.source !== 'twx-download' || data.type !== 'graphql') return;
  const found = extractTweets(data.data);
  for (const [id, m] of found) tweetMediaCache.set(id, m);
});

const SVG_DOWNLOAD = `
<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor">
  <g><path d="M12 17.59 6.7 12.3l1.4-1.42 2.9 2.9V3h2v10.78l2.9-2.9 1.4 1.42L12 17.59zM4 20h16v-2H4v2z"></path></g>
</svg>
`.trim();

const SVG_SPINNER = `
<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="currentColor">
  <g><path d="M12 4V2a10 10 0 0 1 10 10h-2a8 8 0 0 0-8-8z"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></g>
</svg>
`.trim();

function tweetIdFromArticle(article: HTMLElement): string | null {
  const links = article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]');
  for (const link of Array.from(links)) {
    const m = link.getAttribute('href')?.match(/\/status\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

function articleHasMedia(article: HTMLElement): boolean {
  return !!article.querySelector(
    'video, [data-testid="videoComponent"], [data-testid="videoPlayer"], [data-testid="tweetPhoto"]',
  );
}

function setState(btn: HTMLButtonElement, state: 'idle' | 'loading' | 'ok' | 'error') {
  btn.classList.remove('twx-btn--loading', 'twx-btn--ok', 'twx-btn--error');
  if (state === 'loading') {
    btn.classList.add('twx-btn--loading');
    btn.innerHTML = SVG_SPINNER;
  } else if (state === 'ok') {
    btn.classList.add('twx-btn--ok');
    btn.innerHTML = SVG_DOWNLOAD;
  } else if (state === 'error') {
    btn.classList.add('twx-btn--error');
    btn.innerHTML = SVG_DOWNLOAD;
  } else {
    btn.innerHTML = SVG_DOWNLOAD;
  }
}

async function waitForMedia(tweetId: string, timeoutMs = 4000): Promise<TweetMedia | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const data = tweetMediaCache.get(tweetId);
    if (data && data.media.length > 0) return data;
    await new Promise((r) => setTimeout(r, 120));
  }
  return tweetMediaCache.get(tweetId) ?? null;
}

interface DownloadResult {
  ok: boolean;
  error?: string;
  filename: string;
}

function downloadOne(url: string, filename: string): Promise<DownloadResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'twx-download', url, filename },
      (resp: { ok?: boolean; error?: string } | undefined) => {
        if (!resp) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message ?? 'no response from background',
            filename,
          });
          return;
        }
        resolve({ ok: !!resp.ok, error: resp.error, filename });
      },
    );
  });
}

function injectButton(article: HTMLElement) {
  if (article.dataset.twxInjected) return;
  if (!articleHasMedia(article)) return;
  const tweetId = tweetIdFromArticle(article);
  if (!tweetId) return;

  const actionBar = article.querySelector<HTMLElement>('[role="group"]');
  if (!actionBar) return;

  article.dataset.twxInjected = '1';

  const wrap = document.createElement('div');
  wrap.className = 'twx-btn-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'twx-btn';
  btn.setAttribute('aria-label', 'Download media');
  btn.title = 'Download media';
  setState(btn, 'idle');

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setState(btn, 'loading');

    const data = await waitForMedia(tweetId);
    if (!data || data.media.length === 0) {
      setState(btn, 'error');
      alert(
        'Twitter/X Downloader\n\nNo downloadable media found for this tweet.\n' +
          'Try opening the tweet on its own page so the API response is captured.',
      );
      return;
    }

    const total = data.media.length;
    const results = await Promise.all(
      data.media.map((item, idx) =>
        downloadOne(item.bestUrl, filenameFor(data.username, tweetId, item, idx, total)),
      ),
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length === 0) {
      setState(btn, 'ok');
      return;
    }

    setState(btn, 'error');
    const lines = failures.map(
      (f) => `• ${f.filename}: ${f.error ?? 'unknown error'}`,
    );
    alert(
      `Twitter/X Downloader\n\n${failures.length} of ${total} download(s) failed:\n\n${lines.join(
        '\n',
      )}`,
    );
  });

  wrap.appendChild(btn);
  actionBar.appendChild(wrap);
}

function scan() {
  document
    .querySelectorAll<HTMLElement>('article[data-testid="tweet"]')
    .forEach(injectButton);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();
