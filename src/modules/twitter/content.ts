import { downloadMany } from '../shared/download';
import { createDownloadButton, setButtonState } from '../shared/ui';
import { hlsToMp4, saveBlob } from './hls';
import {
  TWX_GRAPHQL_MESSAGE_SOURCE,
  TWX_GRAPHQL_MESSAGE_TYPE,
  TWX_GRAPHQL_REPLAY_TYPE,
} from './constants';
import { extractTweets, filenameForTweet, type MediaItem, type TweetMedia } from './parser';

const tweetMediaCache = new Map<string, TweetMedia>();
// Reposts and quoted tweets can expose a different tweet ID in the DOM than the
// one in the API payload. Media IDs taken from thumbnails match in both places.
const mediaIdCache = new Map<string, TweetMedia>();
const cacheListeners = new Set<() => void>();
const TWEET_SELECTOR = 'article[data-testid="tweet"], [role="article"]';

let twitterModuleStarted = false;
let scanTimer: number | undefined;

function bindGraphqlListener() {
  globalThis.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== globalThis.location.origin) return;
    const data = event.data as { source?: string; type?: string; data?: unknown } | undefined;
    if (!data || data.source !== TWX_GRAPHQL_MESSAGE_SOURCE || data.type !== TWX_GRAPHQL_MESSAGE_TYPE) return;
    const found = extractTweets(data.data);
    if (found.size === 0) return;
    for (const entry of found.values()) cacheTweetMedia(entry);
    for (const listener of Array.from(cacheListeners)) listener();
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

function sharedScope(first: HTMLElement, second: HTMLElement): HTMLElement | undefined {
  let current: HTMLElement | null = first;
  while (current && current !== document.body) {
    if (current.contains(second)) return current;
    current = current.parentElement;
  }
  return undefined;
}

function findPermalinkActionBar(tweetId: string): {
  actionBar: HTMLElement;
  scope?: HTMLElement;
} | null {
  const mediaNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      `a[href*="/status/${tweetId}/photo/"] img, video, ` +
        '[data-testid="videoComponent"], [data-testid="videoPlayer"]',
    ),
  ).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width >= 180 && rect.height >= 180;
  });
  const mediaNode = mediaNodes.sort((a, b) => {
    const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
    const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
    return areaB - areaA;
  })[0];
  if (!mediaNode) return null;

  const mediaRect = mediaNode.getBoundingClientRect();
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="group"]'))
    .filter((group) => !group.querySelector('.twx-btn-wrap'))
    .map((group) => {
      const rect = group.getBoundingClientRect();
      const controls = group.querySelectorAll('button, a, [role="button"]').length;
      const horizontalOverlap = Math.min(rect.right, mediaRect.right) - Math.max(rect.left, mediaRect.left);
      return {
        group,
        controls,
        horizontalOverlap,
        distance: Math.abs(rect.top - mediaRect.bottom),
        rect,
      };
    })
    .filter(
      ({ controls, horizontalOverlap, rect }) =>
        controls >= 4 &&
        horizontalOverlap > Math.min(120, mediaRect.width / 2) &&
        rect.height > 0 &&
        rect.height <= 140 &&
        rect.top >= mediaRect.top,
    )
    .sort((a, b) => a.distance - b.distance);

  const actionBar = candidates[0]?.group;
  if (!actionBar) return null;
  return { actionBar, scope: sharedScope(mediaNode, actionBar) };
}

function mediaIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  return (
    url.match(
      /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|media)\/([^/?.]+)/,
    )?.[1] ?? null
  );
}

function cacheTweetMedia(entry: TweetMedia): void {
  tweetMediaCache.set(entry.tweetId, entry);
  for (const item of entry.media) {
    const mediaId = mediaIdFromUrl(item.posterUrl ?? item.bestUrl);
    if (mediaId) mediaIdCache.set(mediaId, entry);
  }
}

function cachedMediaFor(tweetIds: string[], scope?: HTMLElement): TweetMedia | null {
  for (const id of tweetIds) {
    const entry = tweetMediaCache.get(id);
    if (entry?.media.length) return entry;
  }
  if (!scope) return null;
  const urls = [
    ...Array.from(scope.querySelectorAll<HTMLVideoElement>('video')).map((video) => video.poster),
    ...Array.from(scope.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/"]')).map(
      (image) => image.src,
    ),
  ];
  for (const url of urls) {
    const mediaId = mediaIdFromUrl(url);
    const entry = mediaId ? mediaIdCache.get(mediaId) : undefined;
    if (entry?.media.length) return entry;
  }
  return null;
}

// Resolves as soon as a GraphQL response provides the media, instead of
// polling, and gives up after timeoutMs.
function waitForCachedMedia(
  lookup: () => TweetMedia | null,
  timeoutMs: number,
): Promise<TweetMedia | null> {
  const found = lookup();
  if (found || timeoutMs <= 0) return Promise.resolve(found);
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (value: TweetMedia | null) => {
      cacheListeners.delete(check);
      window.clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      const value = lookup();
      if (value) finish(value);
    };
    timer = window.setTimeout(() => finish(lookup()), timeoutMs);
    cacheListeners.add(check);
  });
}

function findTweetScope(actionBar: HTMLElement, tweetId: string): HTMLElement | undefined {
  let fallback: HTMLElement | undefined;
  let current: HTMLElement | null = actionBar;
  while (current && current !== document.body) {
    const hasStatusLink = !!current.querySelector(`a[href*="/status/${tweetId}"]`);
    const hasMedia = !!current.querySelector(
      'a[href*="/status/"][href*="/photo/"], video, [data-testid="tweetPhoto"], ' +
        '[data-testid="videoComponent"], [data-testid="videoPlayer"]',
    );

    if (hasStatusLink) fallback ??= current;

    // In a repost, the action bar can reference the timeline item while the
    // media URL references the original tweet. The nearest ancestor containing
    // both the action bar and rendered media is therefore the reliable scope.
    if (hasMedia && (hasStatusLink || current.matches(TWEET_SELECTOR))) {
      return current;
    }
    current = current.parentElement;
  }
  return fallback ?? actionBar.closest<HTMLElement>(TWEET_SELECTOR) ?? undefined;
}

function mediaTweetId(scope: HTMLElement | undefined): string | null {
  if (!scope) return null;
  const mediaLink = scope.querySelector<HTMLAnchorElement>(
    'a[href*="/status/"][href*="/photo/"], a[href*="/status/"][href*="/video/"]',
  );
  return mediaLink?.getAttribute('href')?.match(/\/status\/(\d+)\/(?:photo|video)\//)?.[1] ?? null;
}

function imageCandidates(image: HTMLImageElement): string[] {
  const candidates = [image.currentSrc, image.src, image.getAttribute('src') ?? ''];
  const srcset = image.getAttribute('srcset');

  if (srcset) {
    for (const entry of srcset.split(',')) {
      candidates.push(entry.trim().split(/\s+/)[0] ?? '');
    }
  }

  return candidates.filter((url, index, all) => url && all.indexOf(url) === index);
}

function originalPhotoUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl, location.href);
    if (url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) return null;
    url.searchParams.set('name', 'orig');
    return url.toString();
  } catch {
    return null;
  }
}

function appendPhotos(
  images: Iterable<HTMLImageElement>,
  media: MediaItem[],
  seen: Set<string>,
): void {
  for (const image of images) {
    const bestUrl = imageCandidates(image)
      .map(originalPhotoUrl)
      .find((url): url is string => url !== null);
    if (!bestUrl || seen.has(bestUrl)) continue;
    seen.add(bestUrl);
    media.push({ type: 'photo', bestUrl });
  }
}

function mediaFromNearbyPhotos(actionBar: HTMLElement): TweetMedia | null {
  const actionRect = actionBar.getBoundingClientRect();
  const actionCenterY = actionRect.top + actionRect.height / 2;
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"][href*="/photo/"]'),
  );

  const nearest = links
    .map((link) => {
      const rect = link.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      return { link, distance: Math.abs(actionCenterY - centerY) };
    })
    .filter(({ link }) => link.querySelector('img'))
    .sort((a, b) => a.distance - b.distance)[0]?.link;

  const match = nearest?.getAttribute('href')?.match(/^\/([^/]+)\/status\/(\d+)\/photo\//);
  if (!match) return null;

  const [, username, tweetId] = match;
  const escapedId = CSS.escape(tweetId);
  const matchingImages = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      `a[href*="/status/${escapedId}/photo/"] img`,
    ),
  );
  const media: MediaItem[] = [];
  appendPhotos(matchingImages, media, new Set());
  return media.length ? { tweetId, username, media } : null;
}

function mediaFromDom(scope: HTMLElement | undefined, tweetId: string): TweetMedia | null {
  if (!scope) return null;

  const media: MediaItem[] = [];
  const seen = new Set<string>();

  const resourceUrls = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => url.startsWith('https://video.twimg.com/'));

  const directHlsSource = (() => {
    const video = resourceUrls
      .map((url) => {
        const dimensions = url.match(/\/pl\/avc1\/(\d+)x(\d+)\/[^/]+\.m3u8(?:\?|$)/);
        return dimensions
          ? { url, area: Number(dimensions[1]) * Number(dimensions[2]) }
          : null;
      })
      .filter((item): item is { url: string; area: number } => item !== null)
      .sort((a, b) => b.area - a.area)[0]?.url;
    const audio = resourceUrls
      .map((url) => {
        const bitrate = url.match(/\/pl\/mp4a\/(\d+)\/[^/]+\.m3u8(?:\?|$)/)?.[1];
        return bitrate ? { url, bitrate: Number(bitrate) } : null;
      })
      .filter((item): item is { url: string; bitrate: number } => item !== null)
      .sort((a, b) => b.bitrate - a.bitrate)[0]?.url;
    return video && audio
      ? `twx-hls:${encodeURIComponent(JSON.stringify({ video, audio }))}`
      : null;
  })();

  for (const video of Array.from(scope.querySelectorAll<HTMLVideoElement>('video'))) {
    const poster = video.poster;
    const mediaId = poster.match(
      /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/(\d+)\//,
    )?.[1];
    const hlsMasterUrl = resourceUrls.find(
      (url) =>
        /\/pl\/[^/]+\.m3u8(?:\?|$)/.test(url) && (!mediaId || url.includes(`/${mediaId}/`)),
    ) ?? [...resourceUrls].reverse().find((url) => /\/pl\/[^/]+\.m3u8(?:\?|$)/.test(url));
    const hlsSource = hlsMasterUrl ?? directHlsSource;
    if (hlsSource) {
      if (!seen.has(hlsSource)) {
        seen.add(hlsSource);
        media.push({ type: 'video', bestUrl: hlsSource, posterUrl: poster || undefined });
      }
      continue;
    }
    const directCandidates = [
      video.currentSrc,
      video.src,
      ...Array.from(video.querySelectorAll<HTMLSourceElement>('source')).map((source) => source.src),
    ].filter(isCompleteMp4Url);
    const observedCandidates = resourceUrls.filter(
      (url) =>
        isCompleteMp4Url(url) &&
        (!mediaId || url.includes(`/${mediaId}/`) || url.includes(`_${mediaId}/`)),
    );
    const candidates = [...directCandidates, ...observedCandidates];
    const bestUrl = candidates.sort((a, b) => videoResolutionScore(b) - videoResolutionScore(a))[0];
    if (!bestUrl || seen.has(bestUrl)) continue;
    seen.add(bestUrl);
    media.push({ type: 'video', bestUrl, posterUrl: poster || undefined });
  }

  // X can put the selected image candidate in currentSrc/srcset while `src`
  // contains a placeholder. The /media/ path identifies tweet photos without
  // relying on dimensions, which may still be zero while a lazy image settles.
  appendPhotos(scope.querySelectorAll<HTMLImageElement>('img'), media, seen);

  if (media.length === 0) return null;

  const statusLink = scope.querySelector<HTMLAnchorElement>(`a[href*="/status/${tweetId}"]`);
  const username = statusLink?.pathname.match(/^\/([^/]+)\/status\//)?.[1] ?? '';
  return { tweetId, username, media };
}

function isCompleteMp4Url(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'video.twimg.com' || !parsed.pathname.endsWith('.mp4')) return false;
    if (/\/aud\//.test(parsed.pathname) || /\/(?:aud|vid)\/[^/]+\/0\/0\//.test(parsed.pathname)) {
      return false;
    }
    const filename = parsed.pathname.split('/').pop()?.toLowerCase();
    return filename !== 'init.mp4' && filename !== 'initialization.mp4';
  } catch {
    return false;
  }
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

  // Several detectors can resolve the same tweet. The first live button in the
  // tweet cell wins; removing it here would make detectors steal the button
  // from each other on every scan, since each insertion triggers a new scan.
  const cell =
    actionBar.closest<HTMLElement>('[data-testid="cellInnerDiv"]') ??
    actionBar.closest<HTMLElement>(TWEET_SELECTOR) ??
    scope;
  if (cell?.querySelector('.twx-btn-wrap')) return;
  if (document.querySelector(`.twx-btn-wrap[data-twx-tweet-id="${CSS.escape(tweetId)}"]`)) return;

  const wrap = document.createElement('div');
  wrap.className = 'twx-btn-wrap';
  wrap.dataset.twxTweetId = tweetId;

  const btn = createDownloadButton('Download tweet media');

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setButtonState(btn, 'loading');

    // React may replace the tweet container after the button was injected.
    // Resolve its live container at click time before reading rendered media.
    const liveScope = findTweetScope(btn, tweetId) ?? scope;
    const nearbyData = mediaFromNearbyPhotos(actionBar);
    const canonicalTweetId = nearbyData?.tweetId ?? mediaTweetId(liveScope) ?? tweetId;
    const domData = mediaFromDom(liveScope, canonicalTweetId) ?? nearbyData;
    const lookup = () => cachedMediaFor([canonicalTweetId, tweetId], liveScope);
    // The API response carries progressive MP4 URLs, which download directly
    // and much faster than rebuilding HLS. Wait for it only briefly when the
    // DOM already offers a usable source, and a single time overall.
    const domNeedsApi = !domData || domData.media.some((item) => item.type !== 'photo');
    let data =
      lookup() ??
      (domNeedsApi ? await waitForCachedMedia(lookup, domData ? 1200 : 3000) : null) ??
      domData;
    if (!data) {
      // The first click can cause X's player to request its HLS playlists. The
      // initial DOM read happens before those resources exist, so inspect the
      // live player once more after the API wait instead of requiring a second click.
      const refreshedScope = findTweetScope(btn, tweetId) ?? liveScope;
      data =
        mediaFromDom(refreshedScope, canonicalTweetId) ??
        mediaFromNearbyPhotos(actionBar);
    }
    if (!data || data.media.length === 0) {
      setButtonState(btn, 'error');
      alert(
        'Twitter/X Downloader\n\nNo downloadable media found for this tweet.\n' +
          'Try opening the tweet on its own page so the API response is captured.',
      );
      return;
    }

    const total = data.media.length;
    const regularItems = data.media
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => !item.bestUrl.includes('.m3u8') && !item.bestUrl.startsWith('twx-hls:'));
    const results = await downloadMany(
      regularItems.map(({ item, idx }) => ({
        url: item.bestUrl,
        filename: filenameForTweet(data.username, canonicalTweetId, item, idx, total),
      })),
    );

    for (const { item, idx } of data.media
      .map((mediaItem, mediaIndex) => ({ item: mediaItem, idx: mediaIndex }))
      .filter(
        ({ item: mediaItem }) =>
          mediaItem.bestUrl.includes('.m3u8') || mediaItem.bestUrl.startsWith('twx-hls:'),
      )) {
      const filename = filenameForTweet(data.username, canonicalTweetId, item, idx, total);
      try {
        saveBlob(await hlsToMp4(item.bestUrl), filename);
        results.push({ ok: true, filename });
      } catch (error) {
        results.push({
          ok: false,
          filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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

const STATUS_ID_PATTERN = /\/status\/(\d+)/;

function statusIdFromLink(link: HTMLAnchorElement | null): string | null {
  return link?.getAttribute('href')?.match(STATUS_ID_PATTERN)?.[1] ?? null;
}

function looksLikeActionBar(group: HTMLElement): boolean {
  const controls = group.querySelectorAll('button, a[href], [role="button"]').length;
  const rect = group.getBoundingClientRect();
  return controls >= 4 && rect.height > 0 && rect.height <= 140 && !!group.querySelector('svg');
}

function tweetIdFromActionBar(actionBar: HTMLElement): string | null {
  // Permalink and some timeline variants render reply as a link carrying the ID.
  const replyLink = actionBar.querySelector<HTMLAnchorElement>(
    'a[href*="/compose/post?in_reply_to="]',
  );
  if (replyLink) {
    const id = new URL(replyLink.href, location.href).searchParams.get('in_reply_to');
    if (id) return id;
  }

  // Other role="group" elements (media grids, cards) also contain status
  // links, so everything below only applies to bars shaped like action bars.
  if (!looksLikeActionBar(actionBar)) return null;
  if (actionBar.querySelector('a[href*="/photo/"], a[href*="/video/"], img, video')) return null;

  // Profile and home timelines render reply as a plain button. The views
  // counter still links to /status/<id>/analytics inside the same bar.
  const analyticsId = statusIdFromLink(
    actionBar.querySelector<HTMLAnchorElement>('a[href*="/status/"][href*="/analytics"]'),
  );
  if (analyticsId) return analyticsId;

  // Last resort: walk up to the smallest ancestor that contains the tweet's
  // timestamp link. The first timestamp in document order is the outer tweet,
  // so quoted tweets inside the same cell do not take over.
  let current: HTMLElement | null = actionBar.parentElement;
  for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
    const timeLink = current.querySelector('a[href*="/status/"] time')?.closest<HTMLAnchorElement>('a');
    const id = statusIdFromLink(timeLink ?? null);
    if (id) return id;
    current = current.parentElement;
  }
  return null;
}

function scan() {
  // Start from the action bars because X changes article and media markup
  // often. The tweet ID comes from the reply link, the views link or the
  // timestamp, so bars without a reply link (profile timelines) still work.
  document.querySelectorAll<HTMLElement>('[role="group"]').forEach((actionBar) => {
    if (actionBar.querySelector(':scope > .twx-btn-wrap')) return;
    const tweetId = tweetIdFromActionBar(actionBar);
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

  // When replies are restricted, X omits the reply link used by the primary
  // detector. On a permalink, locate the compact horizontal action group
  // immediately below the tweet media instead.
  const permalinkId = location.pathname.match(/\/status\/(\d+)/)?.[1];
  if (permalinkId && !document.querySelector('.twx-btn-wrap')) {
    const match = findPermalinkActionBar(permalinkId);
    if (match) injectButton(match.actionBar, permalinkId, match.scope);
  }
}

function scheduleScan(delayMs = 400): void {
  if (scanTimer !== undefined) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, delayMs);
}

function startDomObserver() {
  const root = document.documentElement;
  if (!root) {
    document.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
    return;
  }

  // X performs many small DOM mutations while videos play and counters update.
  // Coalesce them so a full document scan never runs for every individual change.
  const observer = new MutationObserver((mutations) => {
    const hasAddedElements = mutations.some((mutation) =>
      Array.from(mutation.addedNodes).some((node) => node.nodeType === Node.ELEMENT_NODE),
    );
    if (hasAddedElements) scheduleScan();
  });
  observer.observe(root, { childList: true, subtree: true });
  scan();
}

export function initTwitterModule() {
  if (twitterModuleStarted) return;
  twitterModuleStarted = true;
  bindGraphqlListener();
  startDomObserver();
}

