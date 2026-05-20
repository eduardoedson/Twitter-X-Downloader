import { extensionFromUrl } from '../shared/filename';

export interface Variant {
  bitrate?: number;
  contentType: string;
  url: string;
}

export interface MediaItem {
  type: 'video' | 'gif' | 'photo';
  bestUrl: string;
  variants?: Variant[];
  posterUrl?: string;
  durationMs?: number;
}

export interface TweetMedia {
  tweetId: string;
  username: string;
  media: MediaItem[];
}

interface RawMedia {
  type?: string;
  media_url_https?: string;
  video_info?: {
    duration_millis?: number;
    variants?: Array<{ bitrate?: number; content_type?: string; url?: string }>;
  };
}

interface RawTweetLegacy {
  id_str?: string;
  extended_entities?: { media?: RawMedia[] };
}

interface RawTweetResult {
  legacy?: RawTweetLegacy;
  core?: {
    user_results?: { result?: { legacy?: { screen_name?: string } } };
    user_result?: { result?: { legacy?: { screen_name?: string } } };
  };
}

export function extractTweets(
  root: unknown,
  out: Map<string, TweetMedia> = new Map(),
): Map<string, TweetMedia> {
  walk(root, out, new WeakSet());
  return out;
}

function walk(node: unknown, out: Map<string, TweetMedia>, seen: WeakSet<object>): void {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  const candidate = node as RawTweetResult;
  const legacy = candidate.legacy;
  if (legacy?.id_str && legacy.extended_entities?.media?.length) {
    const tweetId = legacy.id_str;
    const username =
      candidate.core?.user_results?.result?.legacy?.screen_name ??
      candidate.core?.user_result?.result?.legacy?.screen_name ??
      '';
    const media = legacy.extended_entities.media
      .map(parseMediaItem)
      .filter((m): m is MediaItem => m !== null);
    if (media.length && !out.has(tweetId)) {
      out.set(tweetId, { tweetId, username, media });
    }
  }

  if (Array.isArray(node)) {
    for (const v of node) walk(v, out, seen);
    return;
  }
  for (const k of Object.keys(node)) {
    walk((node as Record<string, unknown>)[k], out, seen);
  }
}

function toOriginalPhotoUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('name', 'orig');
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function filenameForTweet(
  username: string,
  tweetId: string,
  item: MediaItem,
  index: number,
  total: number,
): string {
  const base = `${username || 'x'}-${tweetId}`;
  const suffix = total > 1 ? `-${index + 1}` : '';
  if (item.type === 'photo') {
    const ext = extensionFromUrl(item.bestUrl, 'jpg');
    return `${base}${suffix}.${ext}`;
  }
  return `${base}${suffix}.mp4`;
}

function parseMediaItem(m: RawMedia | undefined): MediaItem | null {
  if (!m || !m.type) return null;

  if (m.type === 'photo') {
    if (!m.media_url_https) return null;
    return { type: 'photo', bestUrl: toOriginalPhotoUrl(m.media_url_https) };
  }

  if (m.type === 'video' || m.type === 'animated_gif') {
    const variants: Variant[] = (m.video_info?.variants ?? [])
      .filter((v): v is { bitrate?: number; content_type: string; url: string } =>
        typeof v.url === 'string' && typeof v.content_type === 'string',
      )
      .map((v) => ({
        bitrate: v.bitrate,
        contentType: v.content_type,
        url: v.url,
      }));

    const mp4s = variants.filter((v) => v.contentType === 'video/mp4');
    const best = mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    if (!best) return null;

    return {
      type: m.type === 'animated_gif' ? 'gif' : 'video',
      bestUrl: best.url,
      variants,
      posterUrl: m.media_url_https,
      durationMs: m.video_info?.duration_millis,
    };
  }

  return null;
}

