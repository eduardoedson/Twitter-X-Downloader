import { downloadMany } from '../shared/download';
import { createDownloadButton, setButtonState } from '../shared/ui';
import { TWX_GRAPHQL_MESSAGE_SOURCE, TWX_GRAPHQL_MESSAGE_TYPE } from './constants';
import { extractTweets, filenameForTweet, type TweetMedia } from './parser';

const tweetMediaCache = new Map<string, TweetMedia>();

let twitterModuleStarted = false;

function bindGraphqlListener() {
  globalThis.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== globalThis.location.origin) return;
    const data = event.data as { source?: string; type?: string; data?: unknown } | undefined;
    if (!data || data.source !== TWX_GRAPHQL_MESSAGE_SOURCE || data.type !== TWX_GRAPHQL_MESSAGE_TYPE) return;
    const found = extractTweets(data.data);
    for (const [id, m] of found) tweetMediaCache.set(id, m);
  });
}

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

async function waitForMedia(tweetId: string, timeoutMs = 4000): Promise<TweetMedia | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const data = tweetMediaCache.get(tweetId);
    if (data && data.media.length > 0) return data;
    await new Promise((r) => setTimeout(r, 120));
  }
  return tweetMediaCache.get(tweetId) ?? null;
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

  const btn = createDownloadButton('Download tweet media');

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setButtonState(btn, 'loading');

    const data = await waitForMedia(tweetId);
    if (!data || data.media.length === 0) {
      setButtonState(btn, 'error');
      alert(
        'Twitter/X Downloader\n\nNo downloadable media found for this tweet.\n' +
          'Try opening the tweet on its own page so the API response is captured.',
      );
      return;
    }

    const total = data.media.length;
    const results = await downloadMany(
      data.media.map((item, idx) => ({
        url: item.bestUrl,
        filename: filenameForTweet(data.username, tweetId, item, idx, total),
      })),
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length === 0) {
      setButtonState(btn, 'ok');
      return;
    }

    setButtonState(btn, 'error');
    const lines = failures.map((f) => `• ${f.filename}: ${f.error ?? 'unknown error'}`);
    alert(
      `Twitter/X Downloader\n\n${failures.length} of ${total} download(s) failed:\n\n${lines.join('\n')}`,
    );
  });

  wrap.appendChild(btn);
  actionBar.appendChild(wrap);
}

function scan() {
  document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]').forEach(injectButton);
}

export function initTwitterModule() {
  if (twitterModuleStarted) return;
  twitterModuleStarted = true;
  bindGraphqlListener();
  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
}

