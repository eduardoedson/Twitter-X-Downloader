import { downloadMany } from '../shared/download';
import { createDownloadButton, setButtonState } from '../shared/ui';
import {
  TWX_GRAPHQL_MESSAGE_SOURCE,
  TWX_GRAPHQL_MESSAGE_TYPE,
  TWX_GRAPHQL_REPLAY_TYPE,
} from './constants';
import { extractTweets, filenameForTweet, type MediaItem, type TweetMedia } from './parser';

const tweetMediaCache = new Map<string, TweetMedia>();
const TWEET_SELECTOR = 'article[data-testid="tweet"], [role="article"]';

let twitterModuleStarted = false;

function bindGraphqlListener() {
  globalThis.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== globalThis.location.origin) return;
    const data = event.data as { source?: string; type?: string; data?: unknown } | undefined;
    if (!data || data.source !== TWX_GRAPHQL_MESSAGE_SOURCE || data.type !== TWX_GRAPHQL_MESSAGE_TYPE) return;
    const found = extractTweets(data.data);
    for (const [id, m] of found) tweetMediaCache.set(id, m);
  });

  // Ask the MAIN-world interceptor to resend requests that completed before this
  // document_idle content script was able to attach its listener.
  window.postMessage(
    { source: TWX_GRAPHQL_MESSAGE_SOURCE, type: TWX_GRAPHQL_REPLAY_TYPE },
    '*',
  );
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
    'video, [data-testid="videoComponent"], [data-testid="videoPlayer"], ' +
      '[data-testid="tweetPhoto"], a[href*="/photo/"]',
  );
}

function findActionBar(article: HTMLElement): HTMLElement | null {
  const groups = article.querySelectorAll<HTMLElement>('[role="group"]');

  // The current X UI no longer exposes stable data-testid values on every
  // action. The reply link remains a reliable structural marker of the bar.
  for (const group of Array.from(groups)) {
    if (group.closest(TWEET_SELECTOR) !== article) continue;
    if (group.querySelector('a[href*="/compose/post?in_reply_to="]')) return group;
  }

  // Compatibility with older variants of the X interface.
  for (const group of Array.from(groups)) {
    if (group.closest(TWEET_SELECTOR) !== article) continue;
    if (
      group.querySelector(
        '[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], ' +
          '[data-testid="like"], [data-testid="unlike"], [data-testid="bookmark"], ' +
          '[data-testid="removeBookmark"], [data-testid="share"]',
      )
    ) {
      return group;
    }
  }

  return null;
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

function findTweetScope(actionBar: HTMLElement, tweetId: string): HTMLElement | undefined {
  const article = actionBar.closest<HTMLElement>(TWEET_SELECTOR);
  if (article) return article;

  let current = actionBar.parentElement;
  while (current && current !== document.body) {
    if (current.querySelector(`a[href*="/status/${tweetId}"]`)) return current;
    current = current.parentElement;
  }
  return undefined;
}

function mediaFromDom(scope: HTMLElement | undefined, tweetId: string): TweetMedia | null {
  if (!scope) return null;

  const media: MediaItem[] = [];
  const seen = new Set<string>();

  const resourceUrls = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => url.startsWith('https://video.twimg.com/'));

  for (const video of Array.from(scope.querySelectorAll<HTMLVideoElement>('video'))) {
    const poster = video.poster;
    const mediaId = poster.match(
      /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/(\d+)\//,
    )?.[1];
    const directCandidates = [
      video.currentSrc,
      video.src,
      ...Array.from(video.querySelectorAll<HTMLSourceElement>('source')).map((source) => source.src),
    ].filter((url) => /^https:\/\/video\.twimg\.com\/.*\.mp4(?:\?|$)/.test(url));
    const observedCandidates = resourceUrls.filter(
      (url) =>
        url.includes('.mp4') &&
        (!mediaId || url.includes(`/${mediaId}/`) || url.includes(`_${mediaId}/`)),
    );
    const candidates = [...directCandidates, ...observedCandidates];
    const bestUrl = candidates.sort((a, b) => videoResolutionScore(b) - videoResolutionScore(a))[0];
    if (!bestUrl || seen.has(bestUrl)) continue;
    seen.add(bestUrl);
    media.push({ type: 'video', bestUrl, posterUrl: poster || undefined });
  }

  for (const image of Array.from(
    scope.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/"]'),
  )) {
    try {
      const url = new URL(image.currentSrc || image.src);
      if (
        /\/(?:profile_images|profile_banners|emoji)\//.test(url.pathname) ||
        /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(url.pathname)
      ) {
        continue;
      }
      if (image.naturalWidth < 150 || image.naturalHeight < 150) continue;
      url.searchParams.set('name', 'orig');
      const bestUrl = url.toString();
      if (seen.has(bestUrl)) continue;
      seen.add(bestUrl);
      media.push({ type: 'photo', bestUrl });
    } catch {
      // Ignore malformed or transient image URLs.
    }
  }

  if (media.length === 0) return null;

  const statusLink = scope.querySelector<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`);
  const username = statusLink?.pathname.match(/^\/([^/]+)\/status\//)?.[1] ?? '';
  return { tweetId, username, media };
}

function videoResolutionScore(url: string): number {
  const dimensions = url.match(/\/(\d+)x(\d+)\//);
  if (!dimensions) return 0;
  return Number(dimensions[1]) * Number(dimensions[2]);
}

function injectButton(actionBar: HTMLElement, tweetId: string, scope?: HTMLElement) {
  // X frequently replaces the action bar while keeping the surrounding article.
  // Check the live DOM instead of permanently marking the article as injected.
  if (actionBar.querySelector(':scope > .twx-btn-wrap')) return;

  scope?.querySelectorAll<HTMLElement>('.twx-btn-wrap').forEach((existing) => existing.remove());

  const wrap = document.createElement('div');
  wrap.className = 'twx-btn-wrap';

  const btn = createDownloadButton('Download tweet media');

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setButtonState(btn, 'loading');

    const domData = mediaFromDom(scope, tweetId);
    const data = tweetMediaCache.get(tweetId) ?? domData ?? (await waitForMedia(tweetId));
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
  // The reply URL contains the tweet ID and is the most stable marker in both
  // the legacy and current X action bars. Starting from the bar avoids relying
  // on X's frequently changing article and media markup.
  document.querySelectorAll<HTMLElement>('[role="group"]').forEach((actionBar) => {
    const replyLink = actionBar.querySelector<HTMLAnchorElement>(
      'a[href*="/compose/post?in_reply_to="]',
    );
    if (!replyLink) return;

    const tweetId = new URL(replyLink.href, location.href).searchParams.get('in_reply_to');
    if (!tweetId) return;

    const article = findTweetScope(actionBar, tweetId);
    injectButton(actionBar, tweetId, article);
  });

  // Fallback for older X variants where reply is not rendered as a link.
  document.querySelectorAll<HTMLElement>(TWEET_SELECTOR).forEach((article) => {
    if (!articleHasMedia(article)) return;
    const tweetId = tweetIdFromArticle(article);
    const actionBar = findActionBar(article);
    if (tweetId && actionBar) injectButton(actionBar, tweetId, article);
  });
}

function startDomObserver() {
  const root = document.documentElement;
  if (!root) {
    document.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
    return;
  }

  const observer = new MutationObserver(() => scan());
  observer.observe(root, { childList: true, subtree: true });
  scan();
}

export function initTwitterModule() {
  if (twitterModuleStarted) return;
  twitterModuleStarted = true;
  bindGraphqlListener();
  startDomObserver();
}

